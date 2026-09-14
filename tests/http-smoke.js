const assert=require("node:assert/strict");
const {start}=require("./local-server");
(async()=>{
  const {base,fetch,db}=await start();
  let cookie="";
  async function call(url,body) {
    const r=await fetch(base+url,{method:body?"POST":"GET",headers:{"Content-Type":"application/json",Cookie:cookie},body:body?JSON.stringify(body):undefined});
    if(r.headers.get("set-cookie")) cookie=r.headers.get("set-cookie").split(";")[0];
    return {status:r.status,data:await r.json()};
  }
  assert.equal((await call("/api/rogue/reward",{})).status,401);
  let r=await call("/api/register",{username:"http_player",password:"test-pass-123"});
  assert.equal(r.status,201);
  assert.equal(r.data.rogue.wins,0);
  const userId=r.data.user.id;
  const pick=(id,stake=25)=>call("/api/bets",{marketId:id,outcomeIndex:0,entryPrice:.5,stake,game:"LoL",gameKey:"lol",outcome:"A"});
  assert.equal((await call("/api/new-run",{})).status,409);
  assert.equal((await pick("tiny",.001)).status,400);
  for(let i=0;i<3;i++) {
    r=await pick(`won-${i}`); assert.equal(r.status,201);
    assert.equal(r.data.bets.find(b=>b.marketId===`won-${i}`).potential,50);
  }
  r=await call("/api/settle",{});
  assert.equal(r.status,200); assert.equal(r.data.rogue.wins,3); assert.equal(r.data.bankroll,1075);
  assert.equal((await pick("blocked")).status,409);
  const first=r.data.rogue;
  const relic=first.choices.find(c=>c.id!=="supplies");
  const body={runId:first.id,rewardIndex:0,upgrade:relic.id};
  // The pool shim serializes transactions; this also exercises simultaneous HTTP claims.
  const claims=await Promise.all([call("/api/rogue/reward",body),call("/api/rogue/reward",body)]);
  assert.deepEqual(claims.map(x=>x.status).sort(),[200,409]);
  r=await pick("won-bonus",100);
  const bonusBet=r.data.bets.find(b=>b.marketId==="won-bonus");
  assert.equal(bonusBet.potential,require("../public/rogue-rules").quote(10000,.5,[relic.id]).total/100);
  const before=r.data.bankroll;
  r=await call("/api/settle",{});
  assert.equal(r.data.bankroll,before+bonusBet.potential);
  const once=r.data.bankroll;
  assert.equal((await call("/api/settle",{})).data.bankroll,once);
  // Complete remaining stages, claiming each draft through the real endpoint.
  for(let i=4;i<12;i++) {
    assert.equal((await pick(`won-${i}`)).status,201);
    r=await call("/api/settle",{});
    if(r.data.rogue.rewardDue) {
      const s=r.data.rogue;
      r=await call("/api/rogue/reward",{runId:s.id,rewardIndex:s.rewardIndex,upgrade:s.choices[0].id});
      assert.equal(r.status,200);
    }
  }
  assert.equal(r.data.rogue.victory,true);
  assert.equal((await pick("after-victory")).status,409);
  assert.equal((await call("/api/new-run",{})).status,200);
  r=await call("/api/me");
  assert.equal(r.data.bankroll,1000); assert.equal(r.data.bets.length,0); assert.deepEqual(r.data.rogue.picked,[]);
  const log=await call("/api/rogue/history");
  assert.equal(log.data.runs[0].result,"VICTORY"); assert.equal(log.data.runs[0].wins,12);
  assert.equal((await call("/api/run-history")).data.runs[0].totalBets,12);
  assert.equal((await pick("pending-all-in",1000)).status,201);
  assert.equal((await call("/api/new-run",{})).status,409);
  await db.query("UPDATE bets SET market_id='lost-all-in' WHERE user_id=$1",[userId]);
  r=await call("/api/settle",{});
  assert.equal(r.data.rogue.dead,true);
  assert.equal((await call("/api/new-run",{})).status,200);
  assert.equal((await call("/api/rogue/history")).data.runs[0].result,"ELIMINATED");
  const html=await (await fetch(base)).text();
  assert.ok(html.includes('/rogue-ui.js')); assert.ok(html.includes('/rogue-rules.js'));
  assert.ok(!html.includes('<script src="/game-loop-ui.js">'));
  console.log("HTTP smoke passed: auth, picks, relic payouts, duplicate claims/settlement, victory, death, archives, and scripts.");
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});

