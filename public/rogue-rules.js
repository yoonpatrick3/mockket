(function(root) {
  "use strict";

  const stages = ["The Opening", "The Climb", "High Stakes", "The Final"];
  const SHOP_THRESHOLD = 60;
  const LOSS_PROGRESS_MULTIPLIER = 1.25;

  const upgrades = [
    { id: "lens", name: "Compound Lens", kind: "RELIC", cost: 125, bonusLabel: "+10%", trigger: "Every winning pick", description: "+10% profit on every future winning pick." },
    { id: "longshot", name: "Longshot Charm", kind: "RELIC", cost: 90, bonusLabel: "+25%", trigger: "Pick priced below 40%", description: "+25% profit on future wins priced below 40%." },
    { id: "anchor", name: "Anchor Sigil", kind: "RELIC", cost: 90, bonusLabel: "+20%", trigger: "Pick priced at 60%+", description: "+20% profit on future wins priced at 60% or higher." },
    { id: "momentum", name: "Heavy Hand", kind: "RELIC", cost: 110, bonusLabel: "+20%", trigger: "Stake $100+", description: "+20% profit on future wins with a stake of $100 or more." },
    { id: "closer", name: "Closer's Edge", kind: "RELIC", cost: 75, bonusLabel: "+15%", trigger: "Pick priced 45%–55%", description: "+15% profit on future wins priced from 45% to 55%." },
    { id: "whale", name: "Whale Tooth", kind: "RELIC", cost: 150, bonusLabel: "+25%", trigger: "Stake $250+", description: "+25% profit on future wins with a stake of $250 or more." }
  ];

  function choices(seed, index) {
    let h = 2166136261;
    for (const c of `${seed}:${index}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    const deck = [...upgrades];
    for (let i = deck.length - 1; i > 0; i--) {
      h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
      const j = h % (i + 1);
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck.slice(0, 3);
  }

  function relicApplies(id, stakeCents, price) {
    if (!Number.isFinite(price) || price <= 0 || price >= 1) return false;
    if (id === "lens") return true;
    if (id === "longshot") return price < .4;
    if (id === "anchor") return price >= .6;
    if (id === "momentum") return stakeCents >= 10000;
    if (id === "closer") return price >= .45 && price <= .55;
    if (id === "whale") return stakeCents >= 25000;
    return false;
  }

  function effectRate(stakeCents, price, picked = []) {
    return picked.reduce((rate, id) => {
      if (!relicApplies(id, stakeCents, price)) return rate;
      if (id === "lens") return rate + 10;
      if (id === "longshot") return rate + 25;
      if (id === "anchor") return rate + 20;
      if (id === "momentum") return rate + 20;
      if (id === "closer") return rate + 15;
      if (id === "whale") return rate + 25;
      return rate;
    }, 0);
  }

  function quote(stakeCents, price, picked = []) {
    if (!Number.isSafeInteger(stakeCents) || stakeCents < 1 || !Number.isFinite(price) || price <= 0 || price >= 1) {
      return { total: 0, bonus: 0 };
    }
    const base = Math.round(stakeCents / price);
    const rate = effectRate(stakeCents, price, picked);
    const bonus = Math.round(Math.max(0, base - stakeCents) * rate / 100);
    return { total: base + bonus, bonus, rate };
  }

  function progressContribution(stakeCents, bankrollBeforeCents, status) {
    const bankroll = Math.max(Number(bankrollBeforeCents) || 0, Number(stakeCents) || 0, 1);
    const exposurePct = Math.min(25, Math.max(0, Number(stakeCents) / bankroll * 100));
    const multiplier = status === "LOST" ? LOSS_PROGRESS_MULTIPLIER : 1;
    return Math.max(0, Math.round(exposurePct * multiplier));
  }

  function progress({ shopProgress = 0, shopIndex = 0, shopOpen = false, balanceCents = 0, pending = 0, wins = 0 }) {
    const completed = Math.min(4, Number(shopIndex) || 0);
    const victory = completed >= 4 && !shopOpen;
    const dead = Number(balanceCents) === 0 && Number(pending) === 0 && !shopOpen && !victory;
    return {
      wins: Number(wins) || 0,
      cleared: completed,
      stage: Math.min(4, completed + 1),
      shopIndex: Number(shopIndex) || 0,
      rewardIndex: Number(shopIndex) || 0,
      shopProgress: Math.min(SHOP_THRESHOLD, Math.max(0, Number(shopProgress) || 0)),
      shopThreshold: SHOP_THRESHOLD,
      shopOpen: Boolean(shopOpen),
      rewardDue: Boolean(shopOpen),
      victory,
      dead,
      pending: Number(pending) || 0,
      canRestart: Number(pending) === 0 && !shopOpen && (victory || dead)
    };
  }

  const rules = {
    stages,
    upgrades,
    choices,
    quote,
    effectRate,
    relicApplies,
    progress,
    progressContribution,
    SHOP_THRESHOLD,
    LOSS_PROGRESS_MULTIPLIER
  };

  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  else root.RogueRules = rules;
})(typeof window !== "undefined" ? window : this);
