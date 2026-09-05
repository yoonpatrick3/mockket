// Runtime patch for settlement timing. Keeps series/match winner behavior unchanged,
// but lets individual Game/Map winner markets settle quickly enough for players
// to reuse bankroll on the next game in the series.
const Module = require("module");
const fs = require("fs");

const originalJsLoader = Module._extensions[".js"];

Module._extensions[".js"] = function(module, filename) {
  if (!filename.endsWith("server.js")) {
    return originalJsLoader(module, filename);
  }

  let source = fs.readFileSync(filename, "utf8");

  source = source.replace(
    'const EARLY_SETTLEMENT_STABLE_MS = 5 * 60 * 1000;',
    'const EARLY_SETTLEMENT_STABLE_MS = 5 * 60 * 1000;\n' +
    'const INDIVIDUAL_GAME_SETTLEMENT_MIN_AGE_MS = 0;\n' +
    'const INDIVIDUAL_GAME_SETTLEMENT_STABLE_MS = 60 * 1000;\n' +
    'function isIndividualGameWinnerMarket(market) {\n' +
    '  return /\\b(?:Game|Map)\\s+\\d+\\s+Winner\\b/i.test(String(market?.question || ""));\n' +
    '}'
  );

  source = source.replace(
    'Date.now() - startMs < EARLY_SETTLEMENT_MIN_AGE_MS',
    'Date.now() - startMs < (isIndividualGameWinnerMarket(market) ? INDIVIDUAL_GAME_SETTLEMENT_MIN_AGE_MS : EARLY_SETTLEMENT_MIN_AGE_MS)'
  );

  source = source.replace(
    'if (Date.now() - existing.since < EARLY_SETTLEMENT_STABLE_MS) {',
    'const requiredStableMs = isIndividualGameWinnerMarket(market) ? INDIVIDUAL_GAME_SETTLEMENT_STABLE_MS : EARLY_SETTLEMENT_STABLE_MS;\n\n  if (Date.now() - existing.since < requiredStableMs) {'
  );

  source = source.replace(
    '`Starting 5-minute stability clock.`',
    '`${isIndividualGameWinnerMarket(market) ? "Starting 1-minute game stability clock." : "Starting 5-minute stability clock."}`'
  );

  source = source.replace(
    '`5 minutes unchanged at ${signature}.`',
    '`${isIndividualGameWinnerMarket(market) ? "1 minute" : "5 minutes"} unchanged at ${signature}.`'
  );

  module._compile(source, filename);
};

console.log("[MOCKKET] Individual game settlement tuning enabled (100/0 stable for 1 minute).");
