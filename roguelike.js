const crypto = require("crypto");
const rules = require("./public/rogue-rules");

// Call under the user's row lock for mutations. Reads do not enroll old bets:
// existing bankrolls survive the upgrade, and new picks start progression.
async function ensureRun(db, userId) {
  const r = await db.query(`INSERT INTO rogue_runs(id,user_id) VALUES($1,$2)
    ON CONFLICT (user_id) WHERE ended_at IS NULL DO UPDATE SET user_id=EXCLUDED.user_id
    RETURNING *`, [crypto.randomUUID(), userId]);
  return r.rows[0];
}
async function runState(db, userId, balanceCents, existing) {
  const run = existing || await ensureRun(db, userId);
  const r = await db.query(`SELECT
    COUNT(DISTINCT market_id) FILTER (WHERE status='WON' AND stake_cents>=2500 AND rogue_run_id=$2)::int AS wins,
    COUNT(*) FILTER (WHERE status='OPEN')::int AS pending
    FROM bets WHERE user_id=$1`, [userId, run.id]);
  const picked = run.picked;
  const p = rules.progress(Number(r.rows[0].wins), picked, Number(balanceCents), Number(r.rows[0].pending));
  return { id: run.id, ...p, picked, choices: p.rewardDue ? rules.choices(run.id, p.rewardIndex) : [] };
}
async function chooseReward(db, userId, body) {
  const u = await db.query("SELECT balance_cents FROM users WHERE id=$1 FOR UPDATE", [userId]);
  const run = await ensureRun(db, userId);
  const state = await runState(db, userId, u.rows[0].balance_cents, run);
  if (body.runId !== run.id || body.rewardIndex !== state.rewardIndex || !state.rewardDue || !state.choices.some(c => c.id === body.upgrade)) {
    const err = new Error("This reward is no longer available. Refresh your run and choose again.");
    err.status = 409;
    throw err;
  }
  await db.query("UPDATE rogue_runs SET picked=$1::jsonb WHERE id=$2", [JSON.stringify([...run.picked, body.upgrade]), run.id]);
  if (body.upgrade === "supplies") await db.query("UPDATE users SET balance_cents=balance_cents+15000 WHERE id=$1", [userId]);
}
async function finishRun(db, userId, state, balanceCents, result) {
  await db.query(`UPDATE rogue_runs SET ended_at=NOW(), result=$1, wins=$2, ending_balance_cents=$3
    WHERE id=$4 AND user_id=$5 AND ended_at IS NULL`, [result, state.wins, balanceCents, state.id, userId]);
}
module.exports = { ensureRun, runState, chooseReward, finishRun, rules };
