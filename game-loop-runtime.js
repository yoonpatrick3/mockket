const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  throw new Error("[MOCKKET] Missing DATABASE_URL for game-loop runtime.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const STARTING_BALANCE_CENTS = 100000;

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
    JOIN users u ON u.id=s.user_id
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

const originalCreateServer = http.createServer;
http.createServer = function gameLoopCreateServer(handler) {
  return originalCreateServer.call(http, async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      // Daily refills are intentionally gone. Each $1,000 bankroll is one run.
      if (url.pathname === "/api/refill" && req.method === "POST") {
        const user = await sessionUser(req);
        if (!user) return sendJson(res, 401, { error: "Authentication required" });
        return sendJson(res, 410, {
          error: "Daily refills were removed. Go broke with no pending bets to start a new run."
        });
      }

      if (url.pathname === "/api/new-run" && req.method === "POST") {
        const user = await sessionUser(req);
        if (!user) return sendJson(res, 401, { error: "Authentication required" });

        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          const lockedUser = await client.query(`
            SELECT balance_cents
            FROM users
            WHERE id=$1
            FOR UPDATE
          `, [Number(user.id)]);

          if (!lockedUser.rows.length) {
            await client.query("ROLLBACK");
            return sendJson(res, 404, { error: "Account not found" });
          }

          const balance = Number(lockedUser.rows[0].balance_cents || 0);
          if (balance !== 0) {
            await client.query("ROLLBACK");
            return sendJson(res, 409, {
              error: "You can only start a new run after your balance reaches $0."
            });
          }

          const pending = await client.query(`
            SELECT COUNT(*)::int AS n
            FROM bets
            WHERE user_id=$1 AND status='OPEN'
          `, [Number(user.id)]);

          const pendingCount = Number(pending.rows[0]?.n || 0);
          if (pendingCount > 0) {
            await client.query("ROLLBACK");
            return sendJson(res, 409, {
              error: `You still have ${pendingCount} pending bet${pendingCount === 1 ? "" : "s"}. This run is not over yet.`
            });
          }

          // These DELETEs are intercepted by the run-history DB triggers,
          // which archive every bet/refill before clearing the visible run.
          await client.query("DELETE FROM bets WHERE user_id=$1", [Number(user.id)]);
          await client.query("DELETE FROM daily_refills WHERE user_id=$1", [Number(user.id)]);

          await client.query(`
            UPDATE users
            SET balance_cents=$1
            WHERE id=$2
          `, [STARTING_BALANCE_CENTS, Number(user.id)]);

          await client.query("COMMIT");
          return sendJson(res, 200, { ok: true });
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      }

      return handler(req, res);
    } catch (err) {
      console.error("[MOCKKET] Game-loop runtime error:", err);
      if (!res.headersSent) return sendJson(res, 500, { error: err.message });
      try { res.end(); } catch {}
    }
  });
};

const originalReadFile = fs.readFile;
fs.readFile = function gameLoopReadFile(filePath, ...args) {
  const callback = args[args.length - 1];
  if (typeof callback !== "function") {
    return originalReadFile.call(fs, filePath, ...args);
  }

  const nextArgs = args.slice(0, -1);
  const wrapped = (err, data) => {
    if (!err && String(filePath).endsWith(path.join("public", "index.html"))) {
      const original = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const tag = '<script src="/game-loop-ui.js"></script>';
      if (!original.includes(tag)) {
        data = Buffer.from(original.replace("</body>", `${tag}\n</body>`), "utf8");
      }
    }
    callback(err, data);
  };

  return originalReadFile.call(fs, filePath, ...nextArgs, wrapped);
};

console.log("[MOCKKET] Run-based game loop enabled; daily refills disabled.");
