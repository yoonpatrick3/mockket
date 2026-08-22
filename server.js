console.log("[MOCKKET] booting server.js");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");
const { promisify } = require("util");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const STARTING_BALANCE_CENTS = 100000;
const DAILY_REFILL_CENTS = 100000;
const DAILY_REFILL_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_SECRET = process.env.PASSWORD_RESET_SECRET || "";
const EARLY_SETTLEMENT_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const EARLY_SETTLEMENT_STABLE_MS = 5 * 60 * 1000;

// marketId -> { signature, winnerIndex, since }
const earlySettlementCandidates = new Map();

let mockketResolutionTablePromise = null;
function ensureMockketResolutionTable() {
  if (!mockketResolutionTablePromise) {
    mockketResolutionTablePromise = pool.query(`
      CREATE TABLE IF NOT EXISTS mockket_market_resolutions (
        market_id TEXT PRIMARY KEY,
        winner_index INTEGER NOT NULL CHECK (winner_index IN (0,1)),
        settlement_source TEXT NOT NULL DEFAULT 'mockket_100_0',
        settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch(err => {
      mockketResolutionTablePromise = null;
      throw err;
    });
  }
  return mockketResolutionTablePromise;
}


const SESSION_DAYS = 30;
const scryptAsync = promisify(crypto.scrypt);

if (!process.env.DATABASE_URL) {
  console.error("[MOCKKET] Missing DATABASE_URL.");
  console.error('Set it first, e.g. set "DATABASE_URL=postgresql://..."');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.on("error", err => {
  console.error("[MOCKKET] Unexpected Postgres pool error:", err);
});

console.log("[MOCKKET] PostgreSQL configured.");

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}


function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}


function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

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

function sessionCookie(token, maxAgeSeconds) {
  return `mock_league_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return "mock_league_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${Buffer.from(key).toString("hex")}`;
}

async function verifyPassword(password, stored) {
  try {
    const [kind, saltHex, keyHex] = String(stored).split("$");
    if (kind !== "scrypt" || !saltHex || !keyHex) return false;
    const actual = Buffer.from(await scryptAsync(password, Buffer.from(saltHex, "hex"), 64));
    const expected = Buffer.from(keyHex, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

async function cleanupExpiredSessions() {
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
}

async function getSessionUser(req) {
  await cleanupExpiredSessions();

  const token = parseCookies(req).mock_league_session;
  if (!token) return null;

  const result = await pool.query(`
    SELECT u.id, u.username, u.balance_cents, u.created_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1
      AND s.expires_at > NOW()
    LIMIT 1
  `, [hashSessionToken(token)]);

  return result.rows[0] || null;
}

async function requireUser(req, res) {
  const user = await getSessionUser(req);

  if (!user) {
    json(res, 401, { error: "Authentication required" });
    return null;
  }

  return user;
}

async function createSessionForUser(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(
    now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000
  );

  await pool.query(`
    INSERT INTO sessions(token_hash, user_id, expires_at, created_at)
    VALUES($1,$2,$3,$4)
  `, [
    hashSessionToken(token),
    userId,
    expires.toISOString(),
    now.toISOString()
  ]);

  return {
    token,
    maxAgeSeconds: SESSION_DAYS * 24 * 60 * 60
  };
}

function dbBetToClient(row) {
  return {
    id: row.id,
    marketId: row.market_id,
    conditionId: row.condition_id || "",
    game: row.game,
    gameKey: row.game_key,
    competition: row.competition || "",
    question: row.question,
    matchStart: row.match_start,
    outcome: row.outcome,
    outcomeIndex: Number(row.outcome_index),
    tokenIds: parseMaybeJson(row.token_ids),
    entryPrice: Number(row.entry_price),
    stake: Number(row.stake_cents) / 100,
    potential: Number(row.potential_cents) / 100,
    status: row.status,
    pnl: Number(row.pnl_cents) / 100,
    placedAt: row.placed_at,
    resolvedAt: row.resolved_at
  };
}

async function accountStateForUser(userId) {
  const userResult = await pool.query(`
    SELECT id, username, balance_cents, created_at
    FROM users
    WHERE id = $1
    LIMIT 1
  `, [userId]);

  const user = userResult.rows[0];
  if (!user) return null;

  const betsResult = await pool.query(`
    SELECT *
    FROM bets
    WHERE user_id = $1
    ORDER BY placed_at DESC
  `, [userId]);

  const openBetCount = betsResult.rows.filter(
    row => String(row.status) === "OPEN"
  ).length;

  const refillResult = await pool.query(`
    SELECT
      COUNT(*)::int AS refill_count,
      COALESCE(SUM(amount_cents), 0)::bigint AS total_refilled_cents,
      MAX(claimed_at) AS last_refill_at
    FROM daily_refills
    WHERE user_id = $1
  `, [userId]);

  const refillRow = refillResult.rows[0] || {};
  const lastRefillAt = refillRow.last_refill_at
    ? new Date(refillRow.last_refill_at)
    : null;

  const nextEligibleAt = lastRefillAt
    ? new Date(lastRefillAt.getTime() + DAILY_REFILL_COOLDOWN_MS)
    : null;

  const cooldownPassed =
    !nextEligibleAt ||
    nextEligibleAt.getTime() <= Date.now();

  const balanceCents = Number(user.balance_cents);

  return {
    user: {
      id: Number(user.id),
      username: user.username,
      createdAt: user.created_at
    },
    bankroll: balanceCents / 100,
    bets: betsResult.rows.map(dbBetToClient),
    refill: {
      amount: DAILY_REFILL_CENTS / 100,
      eligible:
        balanceCents === 0 &&
        openBetCount === 0 &&
        cooldownPassed,
      blockedByPendingBets: openBetCount > 0,
      openBetCount,
      refillCount: Number(refillRow.refill_count || 0),
      totalRefilled:
        Number(refillRow.total_refilled_cents || 0) / 100,
      lastRefillAt:
        lastRefillAt ? lastRefillAt.toISOString() : null,
      nextEligibleAt:
        balanceCents === 0 &&
        nextEligibleAt &&
        !cooldownPassed
          ? nextEligibleAt.toISOString()
          : null
    }
  };
}
async function leaderboardRows() {
  const result = await pool.query(`
    SELECT
      u.id,
      u.username,
      u.balance_cents,
      COUNT(b.id)::bigint AS total_bets,
      COUNT(*) FILTER (WHERE b.status='WON')::bigint AS wins,
      COUNT(*) FILTER (WHERE b.status='LOST')::bigint AS losses,
      COUNT(*) FILTER (WHERE b.status='OPEN')::bigint AS open_bets,
      COALESCE(
        SUM(b.pnl_cents) FILTER (WHERE b.status!='OPEN'),
        0
      )::bigint AS pnl_cents,
      COALESCE(
        SUM(b.stake_cents) FILTER (WHERE b.status!='OPEN'),
        0
      )::bigint AS resolved_stake_cents
    FROM users u
    LEFT JOIN bets b ON b.user_id = u.id
    GROUP BY u.id
    ORDER BY
      pnl_cents DESC,
      wins DESC,
      total_bets DESC,
      u.username ASC
  `);

  return result.rows.map((r, i) => ({
    rank: i + 1,
    username: r.username,
    bankroll: Number(r.balance_cents) / 100,
    totalBets: Number(r.total_bets || 0),
    wins: Number(r.wins || 0),
    losses: Number(r.losses || 0),
    openBets: Number(r.open_bets || 0),
    pnl: Number(r.pnl_cents || 0) / 100,
    roi: Number(r.resolved_stake_cents || 0) > 0
      ? Number(r.pnl_cents || 0) /
        Number(r.resolved_stake_cents) * 100
      : 0
  }));
}

function parseMaybeJson(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try { return JSON.parse(v); } catch { return []; }
}

function isLeagueOfLegendsText(text = "") {
  const s = ` ${String(text).toLowerCase()} `;
  const tokens = [
    "league of legends", " lol ", "lck", "lpl", "lec", "lcs", "lta",
    "mid-season invitational", " msi ", "worlds", "world championship",
    "t1", "gen.g", "geng", "hanwha life", "hle", "kt rolster", "dplus kia",
    "bilibili gaming", "blg", "top esports", "tes", "jd gaming", "jdg",
    "weibo gaming", "wbg", "invictus gaming", "fnatic", "g2 esports",
    "karmine corp", "team vitality", "movistar koi", "flyquest", "cloud9",
    "team liquid", "100 thieves"
  ];
  return tokens.some(t => s.includes(t));
}

async function discoverLeagueTagIds() {
  const ids = new Set();

  try {
    const r = await fetch(`${GAMMA}/sports`, { headers: { "User-Agent": "MockLeague/0.2" } });
    if (r.ok) {
      const sports = await r.json();
      for (const sport of sports) {
        const blob = `${sport.sport || ""} ${sport.name || ""}`.toLowerCase();
        if (blob.includes("league of legends") || blob.trim() === "lol") {
          String(sport.tags || "").split(",").map(x => x.trim()).filter(Boolean).forEach(x => ids.add(x));
        }
      }
    }
  } catch {}

  try {
    const r = await fetch(`${GAMMA}/tags?limit=1000`, { headers: { "User-Agent": "MockLeague/0.2" } });
    if (r.ok) {
      const tags = await r.json();
      for (const tag of tags) {
        const blob = `${tag.label || ""} ${tag.slug || ""}`.toLowerCase();
        if (blob.includes("league of legends") || blob.includes("league-of-legends") || blob.trim() === "lol") {
          ids.add(String(tag.id));
        }
      }
    }
  } catch {}

  return [...ids];
}

function parseTeamsAndCompetition(title = "") {
  const cleaned = String(title).replace(/^LoL:\s*/i, "").trim();
  const [matchPart, ...competitionParts] = cleaned.split(/\s+-\s+/);
  const competition = competitionParts.join(" - ").trim();

  const bo = matchPart.match(/\((BO\d+)\)/i)?.[1] || "";
  const withoutBo = matchPart.replace(/\s*\(BO\d+\)\s*/i, "").trim();
  const teams = withoutBo.split(/\s+vs\.?\s+/i);

  return {
    teamA: (teams[0] || "").trim(),
    teamB: (teams[1] || "").trim(),
    bestOf: bo.toUpperCase(),
    competition
  };
}

function isActualLolMatchEvent(event) {
  const title = String(event?.title || "");
  return /^LoL:\s*.+\s+vs\.?\s+.+/i.test(title);
}

function selectMatchWinnerMarket(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const active = markets.filter(m => m && !m.closed);

  // Prefer the series/match winner market instead of map/game props.
  return active.find(m => {
    const type = String(m.sportsMarketType || "").toLowerCase();
    return type.includes("moneyline") || type.includes("winner");
  }) || active.find(m => {
    const q = String(m.question || "").toLowerCase();
    return !/\b(game|map)\s*\d+\b/.test(q) &&
           !/\bfirst (blood|dragon|baron|tower)\b/.test(q) &&
           !/\btotal\b|\bspread\b|\bhandicap\b/.test(q);
  }) || active[0] || null;
}

async function fetchLiveMidpoints(tokenIds) {
  if (!tokenIds.length) return {};
  try {
    const r = await fetch(
      `${CLOB}/midpoints?token_ids=${encodeURIComponent(tokenIds.join(","))}`,
      { headers: { "User-Agent": "MockLeague/0.3" } }
    );
    if (!r.ok) return {};
    return await r.json();
  } catch {
    return {};
  }
}

function gammaPricesForMarket(m) {
  const p = parseMaybeJson(m?.outcomePrices).map(Number);
  if (p.length < 2 || p.some(x => !Number.isFinite(x) || x <= 0 || x >= 1)) return null;
  return p.slice(0, 2);
}

function tokenIdsForMarket(m) {
  return parseMaybeJson(m?.clobTokenIds).map(String).filter(Boolean).slice(0, 2);
}

const GAME_CONFIG = {
  lol: {
    name: "League of Legends",
    pageUrl: "https://polymarket.com/esports/league-of-legends",
    titlePrefix: "LoL:",
    slugPrefix: "lol-"
  },
  valorant: {
    name: "Valorant",
    pageUrl: "https://polymarket.com/esports/valorant",
    titlePrefix: "Valorant:",
    slugPrefix: "val-"
  }
};

async function fetchGamePageSlugs(gameKey) {
  const config = GAME_CONFIG[gameKey];
  if (!config) throw new Error("Unsupported game");

  const r = await fetchWithTimeout(
    config.pageUrl,
    { headers: {
        "User-Agent": "Mozilla/5.0 MockLeague/2.1",
        "Accept": "text/html"
    }},
    10000
  );

  if (!r.ok) {
    throw new Error(`Polymarket ${config.name} page failed: ${r.status}`);
  }

  const html = await r.text();
  const slugs = new Set();

  // Search the raw page for event slugs directly instead of assuming
  // how many URL path segments Polymarket puts before them.
  //
  // LoL examples: lol-t1-gen-2026-08-16
  // Valorant examples: val-gm-sge-2026-08-12
  const prefix = config.slugPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(${prefix}[a-z0-9-]+-[0-9]{4}-[0-9]{2}-[0-9]{2})`,
    "gi"
  );

  let match;
  while ((match = pattern.exec(html)) !== null) {
    slugs.add(match[1]);
  }

  return [...slugs];
}

async function fetchEventBySlug(slug) {
  try {
    const r = await fetchWithTimeout(
      `${GAMMA}/events/slug/${encodeURIComponent(slug)}`,
      { headers: { "User-Agent": "MockLeague/2.0" } },
      8000
    );
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function parseGameMatch(title = "", gameKey = "lol") {
  const config = GAME_CONFIG[gameKey];
  const prefix = (config?.titlePrefix || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cleaned = String(title).replace(new RegExp(`^${prefix}\\s*`, "i"), "").trim();

  const [matchPart, ...competitionParts] = cleaned.split(/\s+-\s+/);
  const competition = competitionParts.join(" - ").trim();
  const bo = matchPart.match(/\((BO\d+)\)/i)?.[1] || "";
  const withoutBo = matchPart.replace(/\s*\(BO\d+\)\s*/i, "").trim();
  const teams = withoutBo.split(/\s+vs\.?\s+/i);

  return {
    teamA: (teams[0] || "").trim(),
    teamB: (teams[1] || "").trim(),
    bestOf: bo.toUpperCase(),
    competition
  };
}

function isActualGameMatchEvent(event, gameKey) {
  const config = GAME_CONFIG[gameKey];
  if (!config) return false;
  const prefix = config.titlePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${prefix}\\s*.+\\s+vs\\.?\\s+.+`, "i").test(String(event?.title || ""));
}


function normalizeEventSubMarket(m, parsed, gameKey) {
  if (!m) return null;

  const outcomes = parseMaybeJson(m.outcomes);
  const rawPrices = parseMaybeJson(m.outcomePrices).map(Number);
  const prices =
    rawPrices.length >= 2 &&
    rawPrices.slice(0,2).every(
      p => Number.isFinite(p) && p >= 0 && p <= 1
    )
      ? rawPrices.slice(0,2)
      : gammaPricesForMarket(m);
  const tokenIds = tokenIdsForMarket(m);

  if (outcomes.length < 2 || !prices || tokenIds.length < 2) return null;

  return {
    id: String(m.id ?? m.conditionId ?? m.slug ?? ""),
    conditionId: String(m.conditionId || m.condition_id || ""),
    question: String(m.question || "").trim(),
    sportsMarketType: String(m.sportsMarketType || "").trim(),
    outcomes: outcomes.slice(0, 2),
    prices: prices.slice(0, 2),
    tokenIds: tokenIds.slice(0, 2),
    active: Boolean(m.active),
    closed: Boolean(m.closed),
    gameKey,
    teamA: parsed.teamA,
    teamB: parsed.teamB
  };
}

function classifyEventSubMarket(m, gameKey = "lol") {
  const question = String(m.question || "").trim();

  if (gameKey === "valorant") {
    const mapWinner = question.match(
      /^Valorant:\s*.+\s+vs\.?\s+.+\s+-\s+Map\s+(\d+)\s+Winner$/i
    );

    if (mapWinner) {
      return {
        bucket: "game",
        gameNumber: Number(mapWinner[1]),
        unitLabel: "Map"
      };
    }

    if (/^Games Total:\s*O\/U\s*\d+(?:\.\d+)?$/i.test(question)) {
      const line = question.match(/(\d+(?:\.\d+)?)$/)?.[1] || "";
      return {
        bucket: "total",
        gameNumber: 0,
        line: line ? Number(line) : null,
        unitLabel: "Maps"
      };
    }

    if (
      /^Valorant:\s*.+\s+vs\.?\s+.+\s+\(BO\d+\)\s+-\s+.+$/i.test(question)
    ) {
      return { bucket: "match", gameNumber: 0 };
    }

    return { bucket: "other", gameNumber: 0 };
  }

  const gameWinner = question.match(
    /^LoL:\s*.+\s+vs\.?\s+.+\s+-\s+Game\s+(\d+)\s+Winner$/i
  );

  if (gameWinner) {
    return {
      bucket: "game",
      gameNumber: Number(gameWinner[1]),
      unitLabel: "Game"
    };
  }

  if (/^Games Total:\s*O\/U\s*\d+(?:\.\d+)?$/i.test(question)) {
    const line = question.match(/(\d+(?:\.\d+)?)$/)?.[1] || "";
    return {
      bucket: "total",
      gameNumber: 0,
      line: line ? Number(line) : null,
      unitLabel: "Games"
    };
  }

  if (
    /^LoL:\s*.+\s+vs\.?\s+.+\s+\(BO\d+\)\s+-\s+.+$/i.test(question)
  ) {
    return { bucket: "match", gameNumber: 0 };
  }

  return { bucket: "other", gameNumber: 0 };
}
function buildEventMarkets(event, parsed, gameKey) {
  const rows = (Array.isArray(event?.markets) ? event.markets : [])
    .map(m => {
      const normalized = normalizeEventSubMarket(m, parsed, gameKey);
      if (!normalized) return null;
      return { ...normalized, ...classifyEventSubMarket(m, gameKey) };
    })
    .filter(Boolean);

  const match = rows.find(x => x.bucket === "match") || null;

  const gamesByNumber = new Map();
  rows
    .filter(x => x.bucket === "game")
    .forEach(x => {
      if (!gamesByNumber.has(x.gameNumber)) {
        gamesByNumber.set(x.gameNumber, x);
      }
    });

  const totalsByQuestion = new Map();
  rows
    .filter(x => x.bucket === "total")
    .forEach(x => {
      const key = String(x.question || "").toLowerCase();
      if (!totalsByQuestion.has(key)) {
        totalsByQuestion.set(key, x);
      }
    });

  return {
    match,
    games: [...gamesByNumber.values()].sort((a, b) => a.gameNumber - b.gameNumber),
    totals: [...totalsByQuestion.values()]
  };
}

async function getMarkets(gameKey = "lol") {
  const config = GAME_CONFIG[gameKey];
  if (!config) throw new Error("Unsupported game");

  await ensureMockketResolutionTable();
  const resolvedResult = await pool.query(`
    SELECT market_id, winner_index, settlement_source, settled_at
    FROM mockket_market_resolutions
  `);

  const mockketResolved = new Map(
    resolvedResult.rows.map(row => [
      String(row.market_id),
      {
        winnerIndex: Number(row.winner_index),
        settlementSource: row.settlement_source,
        settledAt: row.settled_at
      }
    ])
  );

  const applyStoredResolution = sm => {
    if (!sm) return sm;
    const stored = mockketResolved.get(String(sm.id));
    if (!stored) return sm;

    sm.mockketResolved = true;
    sm.mockketWinnerIndex = stored.winnerIndex;
    sm.mockketSettlementSource = stored.settlementSource;
    sm.mockketSettledAt = stored.settledAt;
    sm.closed = true;
    sm.active = false;

    // Force the historical result to render exactly as 100% / 0%.
    sm.prices = stored.winnerIndex === 0 ? [1, 0] : [0, 1];
    return sm;
  };

  const slugs = await fetchGamePageSlugs(gameKey);
  if (!slugs.length) throw new Error(`Could not discover ${config.name} matches from Polymarket page`);

  const events = [];
  for (let i = 0; i < slugs.length; i += 20) {
    const batch = await Promise.all(slugs.slice(i, i + 20).map(fetchEventBySlug));
    events.push(...batch.filter(Boolean));
  }

  const now = Date.now();
  const oneWeekFromNow = now + (7 * 24 * 60 * 60 * 1000);

  const gameEvents = [...new Map(
    events.filter(e => isActualGameMatchEvent(e, gameKey))
      .map(e => [String(e.id || e.slug), e])
  ).values()];

  return gameEvents
    .map(event => {
      const market = selectMatchWinnerMarket(event);
      if (!market) return null;


      const parsed = parseGameMatch(event.title, gameKey);
      const prices = gammaPricesForMarket(market);
      if (!prices) return null;

      const eventMarkets = buildEventMarkets(event, parsed, gameKey);

      applyStoredResolution(eventMarkets.match);
      (eventMarkets.games || []).forEach(applyStoredResolution);
      (eventMarkets.totals || []).forEach(applyStoredResolution);

      if (!eventMarkets.match) {
        eventMarkets.match = {
          ...normalizeEventSubMarket(market, parsed, gameKey),
          bucket: "match",
          gameNumber: 0
        };
        applyStoredResolution(eventMarkets.match);
      }

      const startTime =
        market.gameStartTime ||
        market.eventStartTime ||
        event.startDate ||
        market.startDate ||
        event.endDate ||
        market.endDate ||
        null;

      return {
        id: String(market.id ?? market.conditionId ?? market.slug),
        eventId: String(event.id ?? ""),
        slug: event.slug || market.slug || "",
        question: event.title,
        gameKey,
        game: config.name,
        teamA: parsed.teamA,
        teamB: parsed.teamB,
        bestOf: parsed.bestOf,
        competition: parsed.competition,
        league: config.name,
        outcomes: [parsed.teamA, parsed.teamB],
        prices,
        tokenIds: tokenIdsForMarket(market),
        conditionId: String(market.conditionId || market.condition_id || ""),
        eventMarkets,
        startTime,
        active:
          !eventMarkets.match?.closed &&
          Boolean(event.active ?? market.active),
        closed:
          Boolean(event.closed ?? market.closed) ||
          Boolean(eventMarkets.match?.closed),
        volume: Number(event.volume ?? market.volumeNum ?? market.volume ?? 0),
        liquidity: Number(event.liquidity ?? market.liquidityNum ?? market.liquidity ?? 0),
        image: event.image || event.icon || market.image || market.icon || null,
        priceSource: "Gamma outcomePrices"
      };
    })
    .filter(Boolean)
    .filter(match => {
      if (!match.startTime) return false;

      const start = new Date(match.startTime).getTime();
      if (!Number.isFinite(start)) return false;

      // Upcoming matches: keep only the next 7 days.
      if (start >= now) {
        return start <= oneWeekFromNow;
      }

      // Live matches: keep already-started events only while Polymarket still
      // reports the event/market as active and not closed. Limit the lookback
      // so stale historical events cannot leak back into the slate.
      const liveLookbackMs = 12 * 60 * 60 * 1000;
      return match.active && !match.closed && (now - start) <= liveLookbackMs;
    })

    // For League of Legends, only Tier 1 domestic leagues for now.
    // International events can be added explicitly when one is active.
    .filter(match => {
      if (gameKey !== "lol") return true;

      const c = String(match.competition || "").trim().toUpperCase();

      return (
        c === "LPL" || c.startsWith("LPL ") ||
        c === "LCK" || c.startsWith("LCK ") ||
        c === "LEC" || c.startsWith("LEC ") ||
        c === "LCS" || c.startsWith("LCS ")
      ) &&
      !c.includes("CHALLENGERS") &&
      !c.includes("ACADEMY");
    })

    // Live matches first, then upcoming chronologically.
    .sort((a,b) => {
      const aStart = new Date(a.startTime).getTime();
      const bStart = new Date(b.startTime).getTime();

      const aLive = aStart < now && a.active && !a.closed;
      const bLive = bStart < now && b.active && !b.closed;

      if (aLive !== bLive) return aLive ? -1 : 1;
      return aStart - bStart;
    })
    .slice(0,200);
}

function normalizeMarket(m) {
  const outcomes = parseMaybeJson(m.outcomes);
  const prices = parseMaybeJson(m.outcomePrices).map(Number);
  return {
    id: String(m.id ?? m.conditionId ?? m.slug ?? Math.random()),
    slug: m.slug || "",
    question: m.question || m.title || "",
    league: "League of Legends",
    outcomes: outcomes.length ? outcomes : ["Yes", "No"],
    prices,
    tokenIds: tokenIdsForMarket(m),
    conditionId: String(m.conditionId || m.condition_id || ""),
    startTime: m.gameStartTime || m.eventStartTime || m.startDate || m.endDate || null,
    active: Boolean(m.active),
    closed: Boolean(m.closed),
    volume: Number(m.volumeNum ?? m.volume ?? 0),
    liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
    image: m.image || m.icon || null
  };
}

async function getMarketById(id) {
  const r = await fetch(`${GAMMA}/markets/${encodeURIComponent(id)}`, {
    headers: { "User-Agent": "MockLeague/0.2" }
  });
  if (!r.ok) throw new Error(`Market lookup returned ${r.status}`);
  return normalizeMarket(await r.json());
}


async function displayedPricesForMarket(market) {
  const tokenIds = Array.isArray(market.tokenIds)
    ? market.tokenIds.map(String).slice(0, 2)
    : [];

  if (tokenIds.length === 2) {
    const midpoints = await fetchLiveMidpoints(tokenIds);

    const live = tokenIds.map(id => Number(midpoints?.[id]));
    if (
      live.length === 2 &&
      live.every(p => Number.isFinite(p) && p >= 0 && p <= 1)
    ) {
      return live.map(p => Math.round(p * 100));
    }
  }

  const fallback = Array.isArray(market.prices)
    ? market.prices.slice(0, 2).map(Number)
    : [];

  if (
    fallback.length === 2 &&
    fallback.every(p => Number.isFinite(p))
  ) {
    return fallback.map(p => Math.round(p * 100));
  }

  return [];
}

async function settleExactMarketWithWinner(
  marketKey,
  winner,
  settlementSource
) {
  await ensureMockketResolutionTable();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const betsResult = await client.query(`
      SELECT *
      FROM bets
      WHERE status='OPEN' AND market_id=$1
      FOR UPDATE
    `, [marketKey]);

    const now = new Date().toISOString();

    for (const row of betsResult.rows) {
      const won = Number(row.outcome_index) === winner;

      if (won) {
        await client.query(`
          UPDATE users
          SET balance_cents = balance_cents + $1
          WHERE id=$2
        `, [
          Number(row.potential_cents),
          Number(row.user_id)
        ]);

        await client.query(`
          UPDATE bets
          SET status='WON',
              pnl_cents=$1,
              resolved_at=$2
          WHERE id=$3 AND status='OPEN'
        `, [
          Number(row.potential_cents) - Number(row.stake_cents),
          now,
          row.id
        ]);
      } else {
        await client.query(`
          UPDATE bets
          SET status='LOST',
              pnl_cents=$1,
              resolved_at=$2
          WHERE id=$3 AND status='OPEN'
        `, [
          -Number(row.stake_cents),
          now,
          row.id
        ]);
      }
    }

    await client.query(`
      INSERT INTO mockket_market_resolutions(
        market_id,
        winner_index,
        settlement_source,
        settled_at
      )
      VALUES($1,$2,$3,NOW())
      ON CONFLICT (market_id)
      DO UPDATE SET
        winner_index=EXCLUDED.winner_index,
        settlement_source=EXCLUDED.settlement_source,
        settled_at=EXCLUDED.settled_at
    `, [
      marketKey,
      winner,
      settlementSource
    ]);

    await client.query("COMMIT");
    return betsResult.rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function settleMarketForAllUsers(marketId) {
  const marketKey = String(marketId);

  const openResult = await pool.query(`
    SELECT
      COUNT(*)::int AS n,
      MIN(match_start) AS match_start
    FROM bets
    WHERE status='OPEN' AND market_id=$1
  `, [marketKey]);

  const openCount = Number(openResult.rows[0]?.n || 0);

  if (!openCount) {
    earlySettlementCandidates.delete(marketKey);
    return false;
  }

  const market = await getMarketById(marketKey);

  // Official Polymarket resolution still settles immediately.
  if (market.closed) {
    const winner = market.prices.findIndex(
      price => Number(price) > 0.99
    );

    if (winner < 0) return false;

    await settleExactMarketWithWinner(
      marketKey,
      winner,
      "polymarket"
    );

    earlySettlementCandidates.delete(marketKey);

    console.log(
      `[MOCKKET] OFFICIAL SETTLEMENT ${marketKey} | ` +
      `${market.question || "Unknown market"} | ` +
      `Winner: ${market.outcomes?.[winner] || `outcome ${winner}`}`
    );

    return true;
  }

  // MOCKKET early settlement:
  // 1. the event start stored on the bet is >2 hours ago
  // 2. the percentages MOCKKET would DISPLAY are exactly 100% / 0%
  // 3. that displayed 100/0 pair does not change for 5 minutes
  const rawStart =
    openResult.rows[0]?.match_start ||
    market.startTime ||
    null;

  const startMs = rawStart
    ? new Date(rawStart).getTime()
    : NaN;

  if (
    !Number.isFinite(startMs) ||
    Date.now() - startMs < EARLY_SETTLEMENT_MIN_AGE_MS
  ) {
    earlySettlementCandidates.delete(marketKey);
    return false;
  }

  const displayed = await displayedPricesForMarket(market);

  if (displayed.length !== 2) {
    earlySettlementCandidates.delete(marketKey);
    return false;
  }

  let winner = -1;

  if (displayed[0] === 100 && displayed[1] === 0) {
    winner = 0;
  } else if (displayed[0] === 0 && displayed[1] === 100) {
    winner = 1;
  }

  if (winner < 0) {
    earlySettlementCandidates.delete(marketKey);
    return false;
  }

  const signature = `${displayed[0]}:${displayed[1]}`;
  const existing = earlySettlementCandidates.get(marketKey);

  if (
    !existing ||
    existing.signature !== signature ||
    existing.winnerIndex !== winner
  ) {
    earlySettlementCandidates.set(marketKey, {
      signature,
      winnerIndex: winner,
      since: Date.now()
    });

    console.log(
      `[MOCKKET] 100/0 candidate ${marketKey}: ${signature}. ` +
      `Starting 5-minute stability clock.`
    );

    return false;
  }

  if (Date.now() - existing.since < EARLY_SETTLEMENT_STABLE_MS) {
    return false;
  }

  await settleExactMarketWithWinner(
    marketKey,
    winner,
    "mockket_100_0"
  );

  earlySettlementCandidates.delete(marketKey);

  console.log(
    `[MOCKKET] EARLY SETTLED ${marketKey} | ` +
    `${market.question || "Unknown market"} | ` +
    `Winner: ${market.outcomes?.[winner] || `outcome ${winner}`} | ` +
    `5 minutes unchanged at ${signature}.`
  );

  return true;
}
async function settleOpenMarkets(limit = 30) {
  const result = await pool.query(`
    SELECT DISTINCT market_id
    FROM bets
    WHERE status='OPEN'
    LIMIT $1
  `, [limit]);

  for (const row of result.rows) {
    try {
      await settleMarketForAllUsers(row.market_id);
    } catch (err) {
      console.error(
        "Settlement check failed for",
        row.market_id,
        err.message
      );
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/register" && req.method === "POST") {
      const body = await readJsonBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        return json(res, 400, {
          error: "Username must be 3-20 letters, numbers, or underscores."
        });
      }

      if (password.length < 8 || password.length > 200) {
        return json(res, 400, {
          error: "Password must be at least 8 characters."
        });
      }

      const passwordHash = await hashPassword(password);

      let userId;

      try {
        const result = await pool.query(`
          INSERT INTO users(
            username,
            password_hash,
            balance_cents,
            created_at
          )
          VALUES($1,$2,$3,NOW())
          RETURNING id
        `, [
          username,
          passwordHash,
          STARTING_BALANCE_CENTS
        ]);

        userId = Number(result.rows[0].id);
      } catch (err) {
        if (err.code === "23505") {
          return json(res, 409, {
            error: "That username is already taken."
          });
        }

        throw err;
      }

      const session = await createSessionForUser(userId);
      const account = await accountStateForUser(userId);

      return json(res, 201, account, {
        "Set-Cookie": sessionCookie(
          session.token,
          session.maxAgeSeconds
        )
      });
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      const result = await pool.query(`
        SELECT *
        FROM users
        WHERE LOWER(username)=LOWER($1)
        LIMIT 1
      `, [username]);

      const user = result.rows[0];

      if (
        !user ||
        !(await verifyPassword(password, user.password_hash))
      ) {
        return json(res, 401, {
          error: "Invalid username or password."
        });
      }

      const session = await createSessionForUser(Number(user.id));
      const account = await accountStateForUser(Number(user.id));

      return json(res, 200, account, {
        "Set-Cookie": sessionCookie(
          session.token,
          session.maxAgeSeconds
        )
      });
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      const token = parseCookies(req).mock_league_session;

      if (token) {
        await pool.query(`
          DELETE FROM sessions
          WHERE token_hash=$1
        `, [hashSessionToken(token)]);
      }

      return json(
        res,
        200,
        { ok: true },
        { "Set-Cookie": clearSessionCookie() }
      );
    }

    if (url.pathname === "/api/me" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;

      return json(
        res,
        200,
        await accountStateForUser(Number(user.id))
      );
    }

    if (url.pathname === "/api/bets" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;

      const body = await readJsonBody(req);

      const marketId = String(body.marketId || "").trim();
      const outcomeIndex = Number(body.outcomeIndex);
      const entryPrice = Number(body.entryPrice);
      const stake = Number(body.stake);
      const tokenIds = Array.isArray(body.tokenIds)
        ? body.tokenIds.map(String).slice(0, 2)
        : [];

      await ensureMockketResolutionTable();

      const mockketResolvedCheck = await pool.query(`
        SELECT winner_index
        FROM mockket_market_resolutions
        WHERE market_id=$1
        LIMIT 1
      `, [marketId]);

      if (mockketResolvedCheck.rows.length) {
        return json(res, 409, {
          error: "That market has already been settled by MOCKKET."
        });
      }

      if (
        !marketId ||
        ![0,1].includes(outcomeIndex) ||
        !Number.isFinite(entryPrice) ||
        entryPrice <= 0 ||
        entryPrice >= 1
      ) {
        return json(res, 400, {
          error: "Invalid market selection."
        });
      }

      if (!Number.isFinite(stake) || stake <= 0) {
        return json(res, 400, {
          error: "Stake must be greater than $0."
        });
      }

      const stakeCents = Math.round(stake * 100);
      const potentialCents = Math.round(
        stakeCents / entryPrice
      );

      const betId = crypto.randomUUID();
      const now = new Date().toISOString();

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        const debit = await client.query(`
          UPDATE users
          SET balance_cents = balance_cents - $1
          WHERE id=$2
            AND balance_cents >= $1
          RETURNING balance_cents
        `, [
          stakeCents,
          Number(user.id)
        ]);

        if (!debit.rowCount) {
          await client.query("ROLLBACK");
          return json(res, 400, {
            error: "Not enough simulated balance."
          });
        }

        await client.query(`
          INSERT INTO bets(
            id,
            user_id,
            market_id,
            condition_id,
            game,
            game_key,
            competition,
            question,
            match_start,
            outcome,
            outcome_index,
            token_ids,
            entry_price,
            stake_cents,
            potential_cents,
            status,
            pnl_cents,
            placed_at
          )
          VALUES(
            $1,$2,$3,$4,$5,$6,$7,$8,$9,
            $10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18
          )
        `, [
          betId,
          Number(user.id),
          marketId,
          String(body.conditionId || ""),
          String(body.game || "Esports"),
          String(body.gameKey || ""),
          String(body.competition || ""),
          String(body.question || ""),
          body.matchStart ? String(body.matchStart) : null,
          String(body.outcome || ""),
          outcomeIndex,
          JSON.stringify(tokenIds),
          entryPrice,
          stakeCents,
          potentialCents,
          "OPEN",
          0,
          now
        ]);

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return json(
        res,
        201,
        await accountStateForUser(Number(user.id))
      );
    }

    if (
      url.pathname === "/api/import-legacy" &&
      req.method === "POST"
    ) {
      const user = await requireUser(req, res);
      if (!user) return;

      const body = await readJsonBody(req);
      const legacy = body?.legacy;

      if (
        !legacy ||
        !Array.isArray(legacy.bets) ||
        !Number.isFinite(Number(legacy.bankroll))
      ) {
        return json(res, 400, {
          error: "Invalid legacy simulator data."
        });
      }

      const existing = await pool.query(`
        SELECT COUNT(*)::int AS n
        FROM bets
        WHERE user_id=$1
      `, [Number(user.id)]);

      if (Number(existing.rows[0]?.n || 0) > 0) {
        return json(res, 409, {
          error:
            "This account already has bets. Reset it first if you want to replace it with your old local simulator data."
        });
      }

      const bankrollCents = Math.round(
        Number(legacy.bankroll) * 100
      );

      if (
        !Number.isInteger(bankrollCents) ||
        bankrollCents < 0 ||
        bankrollCents > 100000000
      ) {
        return json(res, 400, {
          error: "Invalid legacy bankroll."
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await client.query(`
          UPDATE users
          SET balance_cents=$1
          WHERE id=$2
        `, [
          bankrollCents,
          Number(user.id)
        ]);

        for (const raw of legacy.bets) {
          const stake = Number(raw.stake);
          const potential = Number(raw.potential);
          const entryPrice = Number(raw.entryPrice);
          const outcomeIndex = Number(raw.outcomeIndex);
          const status = ["OPEN","WON","LOST"].includes(
            String(raw.status)
          )
            ? String(raw.status)
            : "OPEN";

          if (
            !raw.id ||
            !raw.marketId ||
            !Number.isFinite(stake) ||
            stake <= 0 ||
            !Number.isFinite(potential) ||
            potential < 0 ||
            !Number.isFinite(entryPrice) ||
            entryPrice <= 0 ||
            entryPrice >= 1 ||
            ![0,1].includes(outcomeIndex)
          ) {
            throw new Error(
              `Legacy bet ${raw.id || "(unknown)"} is invalid.`
            );
          }

          const tokenIds = Array.isArray(raw.tokenIds)
            ? raw.tokenIds.map(String).slice(0, 2)
            : [];

          await client.query(`
            INSERT INTO bets(
              id,user_id,market_id,condition_id,game,game_key,
              competition,question,match_start,outcome,
              outcome_index,token_ids,entry_price,stake_cents,
              potential_cents,status,pnl_cents,placed_at,resolved_at
            )
            VALUES(
              $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              $11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19
            )
            ON CONFLICT (id) DO NOTHING
          `, [
            String(raw.id),
            Number(user.id),
            String(raw.marketId),
            String(raw.conditionId || ""),
            String(raw.game || raw.league || "Esports"),
            String(raw.gameKey || ""),
            String(raw.competition || ""),
            String(raw.question || ""),
            raw.matchStart ? String(raw.matchStart) : null,
            String(raw.outcome || ""),
            outcomeIndex,
            JSON.stringify(tokenIds),
            entryPrice,
            Math.round(stake * 100),
            Math.round(potential * 100),
            status,
            Math.round(Number(raw.pnl || 0) * 100),
            raw.placedAt
              ? String(raw.placedAt)
              : new Date().toISOString(),
            raw.resolvedAt
              ? String(raw.resolvedAt)
              : null
          ]);
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        return json(res, 400, {
          error: err.message
        });
      } finally {
        client.release();
      }

      return json(res, 200, {
        ...(await accountStateForUser(Number(user.id))),
        importedCount: legacy.bets.length
      });
    }

    if (url.pathname === "/api/reset-password" && req.method === "POST") {
      if (!PASSWORD_RESET_SECRET) {
        return json(res, 503, {
          error: "Password recovery is not configured on this server."
        });
      }

      const body = await readJsonBody(req);
      const username = String(body.username || "").trim();
      const recoveryCode = String(body.recoveryCode || "");
      const newPassword = String(body.newPassword || "");

      if (!username) {
        return json(res, 400, { error: "Username is required." });
      }

      if (newPassword.length < 8 || newPassword.length > 200) {
        return json(res, 400, {
          error: "New password must be at least 8 characters."
        });
      }

      const expected = Buffer.from(PASSWORD_RESET_SECRET, "utf8");
      const supplied = Buffer.from(recoveryCode, "utf8");

      const validSecret =
        expected.length === supplied.length &&
        crypto.timingSafeEqual(expected, supplied);

      if (!validSecret) {
        return json(res, 401, {
          error: "Invalid recovery code."
        });
      }

      const userResult = await pool.query(`
        SELECT id
        FROM users
        WHERE LOWER(username)=LOWER($1)
        LIMIT 1
      `, [username]);

      const targetUser = userResult.rows[0];

      if (!targetUser) {
        return json(res, 404, {
          error: "Account not found."
        });
      }

      const passwordHash = await hashPassword(newPassword);
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await client.query(`
          UPDATE users
          SET password_hash=$1
          WHERE id=$2
        `, [
          passwordHash,
          Number(targetUser.id)
        ]);

        await client.query(`
          DELETE FROM sessions
          WHERE user_id=$1
        `, [Number(targetUser.id)]);

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return json(res, 200, {
        ok: true,
        message: "Password reset. You can log in with the new password."
      });
    }

    if (url.pathname === "/api/refill" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Lock the account row so two simultaneous clicks cannot both refill.
        const userResult = await client.query(`
          SELECT balance_cents
          FROM users
          WHERE id=$1
          FOR UPDATE
        `, [Number(user.id)]);

        if (!userResult.rows.length) {
          await client.query("ROLLBACK");
          return json(res, 404, {
            error: "Account not found."
          });
        }

        const balanceCents =
          Number(userResult.rows[0].balance_cents);

        if (balanceCents !== 0) {
          await client.query("ROLLBACK");
          return json(res, 400, {
            error:
              "Daily refill is only available when your balance is exactly $0."
          });
        }

        const pendingResult = await client.query(`
          SELECT COUNT(*)::int AS n
          FROM bets
          WHERE user_id=$1 AND status='OPEN'
        `, [Number(user.id)]);

        const pendingCount = Number(pendingResult.rows[0]?.n || 0);

        if (pendingCount > 0) {
          await client.query("ROLLBACK");
          return json(res, 400, {
            error:
              "Daily refill is only available when you have no pending bets."
          });
        }

        const lastResult = await client.query(`
          SELECT claimed_at
          FROM daily_refills
          WHERE user_id=$1
          ORDER BY claimed_at DESC
          LIMIT 1
        `, [Number(user.id)]);

        const lastClaimed =
          lastResult.rows[0]?.claimed_at
            ? new Date(lastResult.rows[0].claimed_at)
            : null;

        if (
          lastClaimed &&
          Date.now() - lastClaimed.getTime() <
            DAILY_REFILL_COOLDOWN_MS
        ) {
          const nextEligibleAt = new Date(
            lastClaimed.getTime() +
              DAILY_REFILL_COOLDOWN_MS
          );

          await client.query("ROLLBACK");

          return json(res, 429, {
            error: "You already used your daily refill.",
            nextEligibleAt: nextEligibleAt.toISOString()
          });
        }

        await client.query(`
          UPDATE users
          SET balance_cents = balance_cents + $1
          WHERE id=$2
        `, [
          DAILY_REFILL_CENTS,
          Number(user.id)
        ]);

        await client.query(`
          INSERT INTO daily_refills(
            user_id,
            amount_cents,
            claimed_at
          )
          VALUES($1,$2,NOW())
        `, [
          Number(user.id),
          DAILY_REFILL_CENTS
        ]);

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return json(
        res,
        200,
        await accountStateForUser(Number(user.id))
      );
    }

    if (url.pathname === "/api/reset" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;

      if (!PASSWORD_RESET_SECRET) {
        return json(res, 503, {
          error: "Simulator reset is not configured on this server."
        });
      }

      const body = await readJsonBody(req);
      const resetSecret = String(body.resetSecret || "");

      const expected = Buffer.from(PASSWORD_RESET_SECRET, "utf8");
      const supplied = Buffer.from(resetSecret, "utf8");

      const validSecret =
        expected.length === supplied.length &&
        crypto.timingSafeEqual(expected, supplied);

      if (!validSecret) {
        return json(res, 401, {
          error: "Invalid recovery code."
        });
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        await client.query(
          "DELETE FROM bets WHERE user_id=$1",
          [Number(user.id)]
        );

        await client.query(
          "DELETE FROM daily_refills WHERE user_id=$1",
          [Number(user.id)]
        );

        await client.query(`
          UPDATE users
          SET balance_cents=$1
          WHERE id=$2
        `, [
          STARTING_BALANCE_CENTS,
          Number(user.id)
        ]);

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return json(
        res,
        200,
        await accountStateForUser(Number(user.id))
      );
    }

    if (url.pathname === "/api/settle" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;

      const body = await readJsonBody(req);

      if (body.marketId) {
        await settleMarketForAllUsers(
          String(body.marketId)
        );
      } else {
        await settleOpenMarkets(50);
      }

      return json(
        res,
        200,
        await accountStateForUser(Number(user.id))
      );
    }

    if (
      url.pathname === "/api/leaderboard" &&
      req.method === "GET"
    ) {
      const user = await requireUser(req, res);
      if (!user) return;

      return json(res, 200, {
        leaderboard: await leaderboardRows()
      });
    }

    if (url.pathname === "/api/markets") {
      const gameKey = url.searchParams.get("game") || "lol";
      const markets = await getMarkets(gameKey);
      return json(res, 200, {
        source: "Polymarket",
        game: GAME_CONFIG[gameKey]?.name || gameKey,
        markets
      });
    }

    if (url.pathname.startsWith("/api/markets/")) {
      const id = url.pathname.split("/").pop();
      return json(res, 200, await getMarketById(id));
    }

    const filePath = url.pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, url.pathname);
    if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain");

    fs.readFile(filePath, (err, data) => {
      if (err) return send(res, 404, "Not found", "text/plain");
      const ext = path.extname(filePath);
      const types = {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon"
      };
      send(res, 200, data, types[ext] || "application/octet-stream");
    });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

server.on("error", err => {
  console.error("HTTP server failed:", err);
  process.exitCode = 1;
});

console.log("[MOCKKET] Using Neon PostgreSQL.");

const settlementTimer = setInterval(() => {
  settleOpenMarkets(50).catch(err =>
    console.error("Background settlement failed:", err.message)
  );
}, 60000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MOCKKET running at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});

// Keep a referenced timer alive in addition to the HTTP server.
// This should normally be unnecessary, but makes unexpected early exits obvious.
const keepAliveTimer = setInterval(() => {}, 60 * 60 * 1000);

function shutdown() {
  clearInterval(settlementTimer);
  clearInterval(keepAliveTimer);
  try { server.close(); } catch {}
  pool.end().catch(()=>{});
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
