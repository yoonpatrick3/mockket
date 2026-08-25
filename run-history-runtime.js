const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("[MOCKKET] Missing DATABASE_URL for run-history runtime.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  raw.split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i <= 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function sessionUser(req) {
  const token = parseCookies(req).mock_league_session;
  if (!token) return null;

  const result = await pool.query(`
    SELECT u.id, u.username, u.balance_cents
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash=$1
      AND s.expires_at > NOW()
    LIMIT 1
  `, [hashSessionToken(token)]);

  return result.rows[0] || null;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

async function currentRunNumber(userId) {
  const result = await pool.query(`
    SELECT COALESCE(
      (SELECT current_run_number
       FROM simulator_run_archive_state
       WHERE user_id=$1),
      (SELECT MAX(run_number)+1
       FROM simulator_runs
       WHERE user_id=$1),
      1
    )::int AS run_number
  `, [userId]);

  return Number(result.rows[0]?.run_number || 1);
}

async function currentRunSummary(userId) {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total_bets,
      COUNT(*) FILTER (WHERE status='WON')::int AS wins,
      COUNT(*) FILTER (WHERE status='LOST')::int AS losses,
      COUNT(*) FILTER (WHERE status='OPEN')::int AS open_bets,
      COALESCE(SUM(pnl_cents) FILTER (WHERE status!='OPEN'),0)::bigint AS pnl_cents,
      COALESCE(SUM(stake_cents) FILTER (WHERE status!='OPEN'),0)::bigint AS resolved_stake_cents,
      MIN(placed_at) AS first_bet_at,
      MAX(placed_at) AS last_bet_at
    FROM bets
    WHERE user_id=$1
  `, [userId]);

  const r = result.rows[0] || {};
  const stake = Number(r.resolved_stake_cents || 0);
  const pnl = Number(r.pnl_cents || 0);

  return {
    totalBets: Number(r.total_bets || 0),
    wins: Number(r.wins || 0),
    losses: Number(r.losses || 0),
    openBets: Number(r.open_bets || 0),
    pnl: pnl / 100,
    roi: stake > 0 ? pnl / stake * 100 : 0,
    startedAt: r.first_bet_at || null,
    lastBetAt: r.last_bet_at || null
  };
}

async function runHistoryForUser(userId) {
  const [runsResult, currentNumber, currentSummary, refillResult] = await Promise.all([
    pool.query(`
      SELECT *
      FROM simulator_runs
      WHERE user_id=$1
        AND ended_at IS NOT NULL
      ORDER BY run_number DESC
    `, [userId]),
    currentRunNumber(userId),
    currentRunSummary(userId),
    pool.query(`
      SELECT
        COUNT(*)::int AS refill_count,
        COALESCE(SUM(amount_cents),0)::bigint AS total_refilled_cents
      FROM daily_refills
      WHERE user_id=$1
    `, [userId])
  ]);

  const completed = runsResult.rows.map(r => {
    const pnlCents = Number(r.realized_pnl_cents || 0);
    const endingBalanceCents = Number(r.ending_balance_cents || 0);
    return {
      id: Number(r.id),
      runNumber: Number(r.run_number),
      startedAt: r.started_at,
      endedAt: r.ended_at,
      endingBalance: endingBalanceCents / 100,
      pnl: pnlCents / 100,
      totalBets: Number(r.total_bets || 0),
      wins: Number(r.wins || 0),
      losses: Number(r.losses || 0),
      openBets: Number(r.open_bets || 0),
      refillCount: Number(r.refill_count || 0),
      totalRefilled: Number(r.total_refilled_cents || 0) / 100
    };
  });

  const completedPnl = completed.reduce((sum, r) => sum + r.pnl, 0);
  const bestRun = completed.reduce((best, r) => !best || r.pnl > best.pnl ? r : best, null);
  const currentRefill = refillResult.rows[0] || {};

  return {
    currentRun: {
      runNumber: currentNumber,
      ...currentSummary,
      refillCount: Number(currentRefill.refill_count || 0),
      totalRefilled: Number(currentRefill.total_refilled_cents || 0) / 100
    },
    summary: {
      totalRuns: completed.length + 1,
      completedRuns: completed.length,
      lifetimePnl: completedPnl + currentSummary.pnl,
      avgCompletedRunPnl: completed.length ? completedPnl / completed.length : 0,
      bestRun: bestRun ? {
        runNumber: bestRun.runNumber,
        pnl: bestRun.pnl
      } : null
    },
    runs: completed
  };
}

async function runDetailForUser(userId, runId) {
  const runResult = await pool.query(`
    SELECT *
    FROM simulator_runs
    WHERE id=$1 AND user_id=$2 AND ended_at IS NOT NULL
    LIMIT 1
  `, [runId, userId]);

  if (!runResult.rows.length) return null;

  const betsResult = await pool.query(`
    SELECT *
    FROM simulator_run_bets
    WHERE run_id=$1
    ORDER BY placed_at DESC
  `, [runId]);

  const r = runResult.rows[0];
  const bets = betsResult.rows.map(b => ({
    id: b.original_bet_id,
    marketId: b.market_id,
    game: b.game,
    gameKey: b.game_key,
    competition: b.competition || "",
    question: b.question,
    matchStart: b.match_start,
    outcome: b.outcome,
    outcomeIndex: Number(b.outcome_index),
    entryPrice: Number(b.entry_price),
    stake: Number(b.stake_cents) / 100,
    potential: Number(b.potential_cents) / 100,
    status: b.status,
    pnl: Number(b.pnl_cents) / 100,
    placedAt: b.placed_at,
    resolvedAt: b.resolved_at
  }));

  const resolvedStake = bets
    .filter(b => b.status !== "OPEN")
    .reduce((sum, b) => sum + b.stake, 0);
  const pnl = Number(r.realized_pnl_cents || 0) / 100;

  return {
    run: {
      id: Number(r.id),
      runNumber: Number(r.run_number),
      startedAt: r.started_at,
      endedAt: r.ended_at,
      endingBalance: Number(r.ending_balance_cents || 0) / 100,
      pnl,
      totalBets: Number(r.total_bets || 0),
      wins: Number(r.wins || 0),
      losses: Number(r.losses || 0),
      openBets: Number(r.open_bets || 0),
      refillCount: Number(r.refill_count || 0),
      totalRefilled: Number(r.total_refilled_cents || 0) / 100,
      roi: resolvedStake > 0 ? pnl / resolvedStake * 100 : 0
    },
    bets
  };
}

async function enhancedLeaderboard() {
  const current = await pool.query(`
    SELECT
      u.id,
      u.username,
      u.balance_cents,
      COUNT(b.id)::bigint AS total_bets,
      COUNT(*) FILTER (WHERE b.status='WON')::bigint AS wins,
      COUNT(*) FILTER (WHERE b.status='LOST')::bigint AS losses,
      COUNT(*) FILTER (WHERE b.status='OPEN')::bigint AS open_bets,
      COALESCE(SUM(b.pnl_cents) FILTER (WHERE b.status!='OPEN'),0)::bigint AS pnl_cents,
      COALESCE(SUM(b.stake_cents) FILTER (WHERE b.status!='OPEN'),0)::bigint AS resolved_stake_cents
    FROM users u
    LEFT JOIN bets b ON b.user_id=u.id
    GROUP BY u.id
  `);

  const archived = await pool.query(`
    SELECT
      user_id,
      COUNT(*)::int AS completed_runs,
      COALESCE(AVG(realized_pnl_cents),0) AS avg_run_pnl_cents
    FROM simulator_runs
    WHERE ended_at IS NOT NULL
    GROUP BY user_id
  `);

  const archiveMap = new Map(archived.rows.map(r => [Number(r.user_id), r]));

  const rows = current.rows.map(r => {
    const a = archiveMap.get(Number(r.id));
    const stake = Number(r.resolved_stake_cents || 0);
    const pnl = Number(r.pnl_cents || 0);
    const completedRuns = Number(a?.completed_runs || 0);

    return {
      username: r.username,
      bankroll: Number(r.balance_cents) / 100,
      totalBets: Number(r.total_bets || 0),
      wins: Number(r.wins || 0),
      losses: Number(r.losses || 0),
      openBets: Number(r.open_bets || 0),
      pnl: pnl / 100,
      roi: stake > 0 ? pnl / stake * 100 : 0,
      runs: completedRuns + 1,
      completedRuns,
      avgRunPnl: Number(a?.avg_run_pnl_cents || 0) / 100
    };
  });

  rows.sort((a,b) =>
    b.pnl - a.pnl ||
    b.wins - a.wins ||
    b.totalBets - a.totalBets ||
    a.username.localeCompare(b.username)
  );

  return rows.map((r,i) => ({ rank:i+1, ...r }));
}

const originalCreateServer = http.createServer;
http.createServer = function patchedCreateServer(handler) {
  return originalCreateServer.call(http, async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/api/run-history") {
        const user = await sessionUser(req);
        if (!user) return sendJson(res, 401, { error: "Authentication required" });
        return sendJson(res, 200, await runHistoryForUser(Number(user.id)));
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/run-history/")) {
        const user = await sessionUser(req);
        if (!user) return sendJson(res, 401, { error: "Authentication required" });
        const runId = Number(url.pathname.split("/").pop());
        if (!Number.isInteger(runId) || runId <= 0) {
          return sendJson(res, 400, { error: "Invalid run id" });
        }
        const detail = await runDetailForUser(Number(user.id), runId);
        if (!detail) return sendJson(res, 404, { error: "Run not found" });
        return sendJson(res, 200, detail);
      }

      if (req.method === "GET" && url.pathname === "/api/leaderboard") {
        const user = await sessionUser(req);
        if (!user) return sendJson(res, 401, { error: "Authentication required" });
        return sendJson(res, 200, { leaderboard: await enhancedLeaderboard() });
      }

      return handler(req, res);
    } catch (err) {
      console.error("[MOCKKET] Run-history runtime error:", err);
      if (!res.headersSent) return sendJson(res, 500, { error: err.message });
      try { res.end(); } catch {}
    }
  });
};

const originalReadFile = fs.readFile;
fs.readFile = function patchedReadFile(filePath, ...args) {
  const callback = args[args.length - 1];
  if (typeof callback !== "function") {
    return originalReadFile.call(fs, filePath, ...args);
  }

  const nextArgs = args.slice(0, -1);
  const wrapped = (err, data) => {
    if (!err && String(filePath).endsWith(path.join("public", "index.html"))) {
      const original = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const tag = '<script src="/run-history-ui.js"></script>';
      if (!original.includes(tag)) {
        data = Buffer.from(original.replace("</body>", `${tag}\n</body>`), "utf8");
      }
    }
    callback(err, data);
  };

  return originalReadFile.call(fs, filePath, ...nextArgs, wrapped);
};

console.log("[MOCKKET] Run-history runtime enabled.");
