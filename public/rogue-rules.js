(function(root) {
  "use strict";
  const stages = ["The Opening", "The Climb", "High Stakes", "The Final"];
  const upgrades = [
    { id: "lens", name: "Compound Lens", kind: "RELIC", description: "+10% profit on every future winning pick." },
    { id: "longshot", name: "Longshot Charm", kind: "RELIC", description: "+20% profit on future wins priced below 40%." },
    { id: "anchor", name: "Anchor Sigil", kind: "RELIC", description: "+12% profit on future wins priced at 60% or higher." },
    { id: "momentum", name: "Heavy Hand", kind: "RELIC", description: "+15% profit on future wins with a stake of $100 or more." },
    { id: "supplies", name: "Supply Cache", kind: "SUPPLIES", description: "Recover $150 in simulated bankroll immediately." }
  ];
  function choices(seed, index) {
    // Stable per-run drafts: refreshing cannot reroll a reward.
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
  function quote(stakeCents, price, picked = []) {
    if (!Number.isSafeInteger(stakeCents) || stakeCents < 1 || !Number.isFinite(price) || price <= 0 || price >= 1) return { total: 0, bonus: 0 };
    const base = Math.round(stakeCents / price);
    const rate = picked.reduce((n, id) => n + (
      id === "lens" ? 10 : id === "longshot" && price < .4 ? 20 :
      id === "anchor" && price >= .6 ? 12 : id === "momentum" && stakeCents >= 10000 ? 15 : 0
    ), 0);
    const bonus = Math.round(Math.max(0, base - stakeCents) * rate / 100);
    return { total: base + bonus, bonus };
  }
  function progress(wins, picked, balanceCents, pending) {
    const cleared = Math.min(4, Math.floor(wins / 3));
    const rewardIndex = picked.length;
    const rewardDue = rewardIndex < Math.min(3, cleared);
    const victory = wins >= 12;
    const dead = balanceCents === 0 && pending === 0 && !rewardDue && !victory;
    return { wins, cleared, stage: Math.min(4, cleared + 1), rewardIndex, rewardDue, victory, dead, pending,
      canRestart: pending === 0 && !rewardDue && (victory || dead) };
  }
  const rules = { stages, upgrades, choices, quote, progress };
  if (typeof module !== "undefined" && module.exports) module.exports = rules;
  else root.RogueRules = rules;
})(typeof window !== "undefined" ? window : this);
