const crypto = require("crypto");
const rules = require("./public/rogue-rules");

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch {}
  }
  return [];
}

// Call under the user's row lock for mutations. Existing bankrolls and old bets
// survive the upgrade; only bets tagged to the current rogue run generate progress.
async function ensureRun(db, userId) {
  const r = await db.query(`INSERT INTO rogue_runs(id,user_id) VALUES($1,$2)
    ON CONFLICT (user_id) WHERE ended_at IS NULL DO UPDATE SET user_id=EXCLUDED.user_id
    RETURNING *`, [crypto.randomUUID(), userId]);
  return r.rows[0];
}

async function syncMerchantProgress(db, userId, existingRun) {
  let run = existingRun;
  const resolved = await db.query(`SELECT id,status,stake_cents,
      COALESCE(bankroll_before_cents,100000) AS bankroll_before_cents
    FROM bets
    WHERE user_id=$1
      AND rogue_run_id=$2
      AND status IN ('WON','LOST')
      AND rogue_progress_applied=FALSE
    ORDER BY COALESCE(resolved_at,placed_at), placed_at, id`, [userId, run.id]);

  let progress = Number(run.shop_progress || 0);
  let shopOpen = Boolean(run.shop_open);
  const shopIndex = Number(run.shop_index || 0);

  for (const bet of resolved.rows) {
    const claimed = await db.query(`UPDATE bets
      SET rogue_progress_applied=TRUE
      WHERE id=$1 AND rogue_progress_applied=FALSE
      RETURNING id`, [bet.id]);
    if (!claimed.rowCount) continue;

    // Once a merchant is waiting, additional resolutions do not bank progress.
    // This prevents a pile of tiny/pending bets from chaining multiple shops.
    if (shopOpen) continue;

    progress = Math.min(
      rules.SHOP_THRESHOLD,
      progress + rules.progressContribution(
        Number(bet.stake_cents),
        Number(bet.bankroll_before_cents),
        String(bet.status)
      )
    );
    if (progress >= rules.SHOP_THRESHOLD) shopOpen = true;

    await db.query(`UPDATE rogue_runs
      SET shop_progress=$1, shop_open=$2
      WHERE id=$3 AND ended_at IS NULL`, [progress, shopOpen, run.id]);
  }

  const refreshed = await db.query("SELECT * FROM rogue_runs WHERE id=$1 LIMIT 1", [run.id]);
  return refreshed.rows[0] || run;
}

async function runState(db, userId, balanceCents, existing) {
  let run = existing || await ensureRun(db, userId);
  run = await syncMerchantProgress(db, userId, run);

  const r = await db.query(`SELECT
    COUNT(DISTINCT market_id) FILTER (WHERE status='WON' AND rogue_run_id=$2)::int AS wins,
    COUNT(*) FILTER (WHERE status='OPEN' AND rogue_run_id=$2)::int AS pending
    FROM bets WHERE user_id=$1`, [userId, run.id]);

  const picked = asArray(run.picked);
  // Only bets with a placement-time effect snapshot can be attributed exactly.
  // Older aggregate relic bonuses are deliberately not guessed or redistributed.
  const effectsResult = await db.query(`SELECT status, relic_effects
    FROM bets WHERE user_id=$1 AND rogue_run_id=$2
      AND relic_effects <> '{}'::jsonb`, [userId, run.id]);
  const relicStats = {};
  for (const id of picked) {
    relicStats[id] = { earnedCents: 0, pendingCents: 0, winningPicks: 0, openPicks: 0 };
  }
  for (const bet of effectsResult.rows) {
    const effects = bet.relic_effects || {};
    for (const [id, cents] of Object.entries(effects)) {
      if (!relicStats[id]) continue;
      if (bet.status === "WON") {
        relicStats[id].earnedCents += Number(cents) || 0;
        relicStats[id].winningPicks++;
      } else if (bet.status === "OPEN") {
        relicStats[id].pendingCents += Number(cents) || 0;
        relicStats[id].openPicks++;
      }
    }
  }
  const p = rules.progress({
    shopProgress: Number(run.shop_progress || 0),
    shopIndex: Number(run.shop_index || 0),
    shopOpen: Boolean(run.shop_open),
    balanceCents: Number(balanceCents),
    pending: Number(r.rows[0]?.pending || 0),
    wins: Number(r.rows[0]?.wins || 0)
  });

  return {
    id: run.id,
    ...p,
    picked,
    relicStats,
    choices: p.shopOpen ? rules.choices(run.id, p.shopIndex) : []
  };
}

async function chooseReward(db, userId, body) {
  const u = await db.query("SELECT balance_cents FROM users WHERE id=$1 FOR UPDATE", [userId]);
  const run = await ensureRun(db, userId);
  const state = await runState(db, userId, u.rows[0].balance_cents, run);

  if (
    body.runId !== run.id ||
    Number(body.rewardIndex) !== state.shopIndex ||
    !state.shopOpen
  ) {
    const err = new Error("This merchant is no longer available. Refresh your run.");
    err.status = 409;
    throw err;
  }

  if (body.skip === true) {
    await db.query(`UPDATE rogue_runs
      SET shop_progress=0, shop_open=FALSE, shop_index=shop_index+1
      WHERE id=$1 AND ended_at IS NULL`, [run.id]);
    return;
  }

  const upgrade = state.choices.find(c => c.id === body.upgrade);
  if (!upgrade) {
    const err = new Error("That item is not in this merchant's shop.");
    err.status = 409;
    throw err;
  }

  const costCents = Math.round(Number(upgrade.cost || 0) * 100);
  const debit = await db.query(`UPDATE users
    SET balance_cents=balance_cents-$1
    WHERE id=$2 AND balance_cents-$1>=100
    RETURNING balance_cents`, [costCents, userId]);
  if (!debit.rowCount) {
    const err = new Error("Buying that would leave you with less than $1. Keep your bankroll or choose a cheaper item.");
    err.status = 409;
    throw err;
  }

  const picked = [...asArray(run.picked), upgrade.id];
  await db.query(`UPDATE rogue_runs
    SET picked=$1::jsonb,
        shop_progress=0,
        shop_open=FALSE,
        shop_index=shop_index+1
    WHERE id=$2 AND ended_at IS NULL`, [JSON.stringify(picked), run.id]);
}

async function finishRun(db, userId, state, balanceCents, result) {
  await db.query(`UPDATE rogue_runs SET ended_at=NOW(), result=$1, wins=$2, ending_balance_cents=$3
    WHERE id=$4 AND user_id=$5 AND ended_at IS NULL`, [result, state.wins, balanceCents, state.id, userId]);
}

module.exports = { ensureRun, runState, chooseReward, finishRun, rules };
