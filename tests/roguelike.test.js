const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const rogue = require("../roguelike");
let db;
before(async () => {
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname,"../mockket-schema.sql"),"utf8"));
  const migration = fs.readFileSync(path.join(__dirname,"../ensure-run-history.js"),"utf8").match(/const sql = `([\s\S]*?)`;/)[1];
  await db.exec(migration);
  const schema = fs.readFileSync(path.join(__dirname,"../roguelike-schema.sql"),"utf8");
  await db.exec(schema);
  await db.exec(schema); // Deploy migration is idempotent.
});
after(async () => { await db.close(); });
async function user() {
  return (await db.query("INSERT INTO users(username,password_hash) VALUES($1,'test') RETURNING id", [crypto.randomUUID().slice(0,20)])).rows[0].id;
}
async function bet(userId, runId, market, stake=2500, status="WON") {
  await db.query(`INSERT INTO bets(id,user_id,market_id,game,game_key,question,outcome,outcome_index,
    entry_price,stake_cents,potential_cents,status,placed_at,rogue_run_id)
    VALUES($1,$2,$3,'League of Legends','lol','A vs B','A',0,0.5,$4::bigint,$4::bigint*2,$5,NOW(),$6)`,
    [crypto.randomUUID(),userId,market,stake,status,runId]);
}
async function transaction(fn) {
  await db.exec("BEGIN");
  try { const result=await fn(); await db.exec("COMMIT"); return result; }
  catch(e) { await db.exec("ROLLBACK"); throw e; }
}
test("relics boost profit only, stack, and respect odds/stake boundaries", () => {
  assert.deepEqual(rogue.rules.quote(10000,.5,[]), { total:20000, bonus:0 });
  assert.deepEqual(rogue.rules.quote(10000,.5,["lens","lens","momentum"]), { total:23500, bonus:3500 });
  assert.equal(rogue.rules.quote(2500,.4,["longshot"]).bonus,0);
  assert.ok(rogue.rules.quote(2500,.39,["longshot"]).bonus > 0);
  assert.equal(rogue.rules.quote(2500,.59,["anchor"]).bonus,0);
  assert.ok(rogue.rules.quote(2500,.6,["anchor"]).bonus > 0);
  assert.equal(rogue.rules.quote(9999,.5,["momentum"]).bonus,0);
  assert.equal(rogue.rules.quote(2500,.5,["supplies"]).bonus,0);
  assert.equal(rogue.rules.quote(0,.5,[]).total,0);
});
test("drafts are stable and contain three distinct valid upgrades", () => {
  const draft=rogue.rules.choices("run-seed",0);
  assert.deepEqual(draft,rogue.rules.choices("run-seed",0));
  assert.equal(new Set(draft.map(x=>x.id)).size,3);
  assert.notDeepEqual(draft,rogue.rules.choices("another-seed",1));
});
test("only qualifying distinct markets from this expedition advance stages", async () => {
  const id=await user();
  await bet(id,null,"legacy");
  const run=await rogue.ensureRun(db,id);
  assert.equal((await rogue.ensureRun(db,id)).id,run.id);
  await bet(id,run.id,"first"); await bet(id,run.id,"first");
  await bet(id,run.id,"small",2499); await bet(id,run.id,"loss",2500,"LOST");
  await bet(id,run.id,"pending",2500,"OPEN");
  const state=await rogue.runState(db,id,100000);
  assert.equal(state.wins,1); assert.equal(state.pending,1); assert.equal(state.rewardDue,false);
  const other=await user();
  assert.equal((await rogue.runState(db,other,100000)).wins,0);
});
test("reward validation prevents early, forged, cross-user, and replayed claims", async () => {
  const id=await user(), run=await rogue.ensureRun(db,id);
  let body={runId:run.id,rewardIndex:0,upgrade:rogue.rules.choices(run.id,0)[0].id};
  await assert.rejects(transaction(()=>rogue.chooseReward(db,id,body)),{status:409});
  for(let i=0;i<3;i++) await bet(id,run.id,`reward-${i}`);
  await assert.rejects(transaction(()=>rogue.chooseReward(db,id,{...body,upgrade:"made-up"})),{status:409});
  await assert.rejects(transaction(()=>rogue.chooseReward(db,999999,body)));
  const other=await user();
  await assert.rejects(transaction(()=>rogue.chooseReward(db,other,body)),{status:409});
  await transaction(()=>rogue.chooseReward(db,id,body));
  await assert.rejects(transaction(()=>rogue.chooseReward(db,id,body)),{status:409});
  assert.equal((await rogue.runState(db,id,100000)).picked.length,1);
});
test("supply cash is credited once without changing recorded betting profit", async () => {
  const id=await user();
  let seed;
  do { seed=crypto.randomUUID(); } while(!rogue.rules.choices(seed,0).some(x=>x.id==="supplies"));
  await db.query("INSERT INTO rogue_runs(id,user_id) VALUES($1,$2)",[seed,id]);
  for(let i=0;i<3;i++) await bet(id,seed,`supply-${i}`);
  const body={runId:seed,rewardIndex:0,upgrade:"supplies"};
  await transaction(()=>rogue.chooseReward(db,id,body));
  await assert.rejects(transaction(()=>rogue.chooseReward(db,id,body)),{status:409});
  assert.equal(Number((await db.query("SELECT balance_cents FROM users WHERE id=$1",[id])).rows[0].balance_cents),115000);
  assert.equal(Number((await db.query("SELECT SUM(pnl_cents) AS pnl FROM bets WHERE user_id=$1",[id])).rows[0].pnl),0);
});
test("all-in runs survive, pending rewards delay death, and victory waits for open picks", () => {
  assert.equal(rogue.rules.progress(0,[],0,1).dead,false);
  assert.equal(rogue.rules.progress(0,[],0,0).canRestart,true);
  assert.equal(rogue.rules.progress(3,[],0,0).dead,false);
  assert.equal(rogue.rules.progress(3,["lens"],0,0).dead,true);
  assert.equal(rogue.rules.progress(12,["lens","lens","lens"],100000,1).canRestart,false);
  assert.equal(rogue.rules.progress(12,["lens","lens","lens"],100000,0).canRestart,true);
  assert.equal(rogue.rules.progress(12,[],100000,0).canRestart,false);
});
test("victory archives upgrades and betting history; the next run starts empty", async () => {
  const id=await user(), run=await rogue.ensureRun(db,id);
  for(let i=0;i<12;i++) await bet(id,run.id,`victory-${i}`);
  for(let i=0;i<3;i++) {
    const state=await rogue.runState(db,id,100000);
    await transaction(()=>rogue.chooseReward(db,id,{runId:run.id,rewardIndex:i,upgrade:state.choices[0].id}));
  }
  const state=await rogue.runState(db,id,100000);
  assert.equal(state.victory,true); assert.equal(state.canRestart,true);
  await transaction(async()=>{
    await rogue.finishRun(db,id,state,100000,"VICTORY");
    await db.query("DELETE FROM bets WHERE user_id=$1",[id]);
    await db.query("UPDATE users SET balance_cents=100000 WHERE id=$1",[id]);
  });
  const next=await rogue.runState(db,id,100000);
  assert.notEqual(next.id,run.id); assert.equal(next.wins,0); assert.deepEqual(next.picked,[]);
  const archived=(await db.query("SELECT * FROM rogue_runs WHERE id=$1",[run.id])).rows[0];
  assert.equal(archived.result,"VICTORY"); assert.equal(archived.wins,12); assert.equal(archived.picked.length,3);
  assert.equal((await db.query("SELECT * FROM simulator_run_bets")).rows.filter(b=>b.run_id).length,12);
  assert.equal((await db.query("SELECT * FROM simulator_run_archive_state WHERE user_id=$1",[id])).rows[0].current_run_number,2);
});
