// Runtime patch for settlement timing. Keeps series/match winner behavior unchanged,
// but lets individual Game/Map winner markets settle quickly enough for players
// to reuse bankroll on the next game in the series. It also captures bankroll at
// placement so roguelike Merchant Progress can use percentage risk instead of raw dollars.
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

  // Add the bankroll snapshot used by Merchant Progress without rewriting the
  // large legacy server file. The migration adds this nullable column first.
  source = source.replace(
    '            rogue_run_id,\n            relic_bonus_cents\n          )',
    '            rogue_run_id,\n            relic_bonus_cents,\n            bankroll_before_cents\n          )'
  );
  source = source.replace(
    '            $10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20\n          )',
    '            $10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21\n          )'
  );
  source = source.replace(
    '          run.id,\n          payout.bonus\n        ]);',
    '          run.id,\n          payout.bonus,\n          Number(locked.rows[0].balance_cents)\n        ]);'
  );

  source = source.replace(
    'Choose your stage reward before placing another pick.',
    'Visit or leave the merchant before placing another pick.'
  );

  // Freeze each relic's share of the bonus when the bet is placed. Never infer
  // attribution from the player's current build after a later shop purchase.
  source = source.replace(
    '            bankroll_before_cents\n          )',
    '            bankroll_before_cents,\n            relic_effects\n          )'
  );
  source = source.replace(
    '            $10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21\n          )',
    '            $10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb\n          )'
  );
  source = source.replace(
    '          Number(locked.rows[0].balance_cents)\n        ]);',
    '          Number(locked.rows[0].balance_cents),\n          JSON.stringify(rogue.rules.effectBreakdown(stakeCents, entryPrice, run.picked))\n        ]);'
  );

  module._compile(source, filename);
};

console.log("[MOCKKET] Individual game settlement tuning + merchant exposure tracking enabled.");
