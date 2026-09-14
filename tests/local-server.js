// Isolated test server: in-memory PostgreSQL, fake markets, no production data.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
async function start() {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname,"../mockket-schema.sql"),"utf8"));
  const source = fs.readFileSync(path.join(__dirname,"../ensure-run-history.js"),"utf8");
  await db.exec(source.match(/const sql = `([\s\S]*?)`;/)[1]);
  await db.exec(fs.readFileSync(path.join(__dirname,"../roguelike-schema.sql"),"utf8"));
  let tail = Promise.resolve();
  async function lock() { const previous=tail; let release; tail=new Promise(r=>release=r); await previous; return release; }
  async function query(sql,args) { const r=await db.query(sql,args); return {...r,rowCount:r.affectedRows ?? r.rows.length}; }
  class TestPool {
    on() { return this; }
    async query(sql,args) { const release=await lock(); try {return await query(sql,args);} finally {release();} }
    async connect() { const release=await lock(); return {query,release}; }
    async end() {}
  }
  require("pg").Pool = TestPool;
  process.env.DATABASE_URL = "postgresql://isolated-test";
  process.env.PORT = process.env.PORT || "4173";
  process.env.PASSWORD_RESET_SECRET = "local-test-recovery";
  const realFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url.startsWith("https://gamma-api.polymarket.com/markets/")) {
      const id = decodeURIComponent(url.split("/").pop());
      return Response.json({id,question:"Test esports market",active:true,closed:!id.startsWith("pending"),outcomes:["A","B"],outcomePrices:id.startsWith("lost")?[0,1]:[1,0]});
    }
    if (url.includes("polymarket.com")) return Response.json([]);
    return realFetch(input,options);
  };
  require("../settlement-tuning-runtime");
  require("../run-history-runtime");
  require("../game-loop-runtime");
  require("../server");
  const base=`http://127.0.0.1:${process.env.PORT}`;
  await realFetch(base);
  const response=await realFetch(`${base}/api/register`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"expedition_demo",password:"local-only-pass"})});
  const data=await response.json();
  if(!response.ok) throw new Error(JSON.stringify(data));
  for(let i=0;i<3;i++) {
    await db.query(`INSERT INTO bets(id,user_id,market_id,game,game_key,question,outcome,outcome_index,entry_price,
      stake_cents,potential_cents,status,pnl_cents,placed_at,resolved_at,rogue_run_id)
      VALUES($1,$2,$3,'League of Legends','lol','T1 vs Gen.G','T1',0,0.5,2500,5000,'WON',2500,NOW(),NOW(),$4)`,
      [crypto.randomUUID(),data.user.id,`demo-${i}`,data.rogue.id]);
  }
  await db.query("UPDATE users SET balance_cents=107500 WHERE id=$1",[data.user.id]);
  console.log("Isolated preview ready: expedition_demo / local-only-pass");
  return {db,base,fetch:realFetch};
}
module.exports = {start};
if(require.main===module) start().catch(e=>{console.error(e);process.exit(1);});

