(() => {
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet"; sheet.href = "/roguelike.css";
  document.head.appendChild(sheet);
  const panel = document.createElement("section");
  panel.className = "rogue-panel";
  panel.setAttribute("aria-label", "Roguelike expedition");
  document.querySelector("#appShell header")?.insertAdjacentElement("afterend", panel);
  let busy = false, error = "", historyOpen = false, history = null, historyUser = null;
  function renderGameState() {
    for (const id of ["refillBtn", "refillNote", "reset"]) {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    }
    const r = state.rogue;
    if (!state.user || !r) { panel.hidden = true; return; }
    if (historyUser !== state.user.id) { history = null; historyOpen = false; historyUser = state.user.id; }
    panel.hidden = false;
    const title = r.victory ? "You conquered the market." : r.dead ? "The run ends. The next begins." : "Build your edge.";
    const nextWins = Math.min(12, r.stage * 3);
    const relics = r.picked.map(id => RogueRules.upgrades.find(u => u.id === id));
    panel.innerHTML = `
      <div class="rogue-top"><div><div class="rogue-eyebrow">MOCKKET EXPEDITIONS <span>SEASON 01</span></div>
        <h2>${title}</h2><p>${r.victory ? "Twelve winning markets. One surviving bankroll. Your expedition is complete." : r.dead ? "Your bankroll is empty and all picks have resolved. Start fresh with $1,000." : "One bankroll. Four stages. Pick well, collect relics, survive."}</p></div>
        <div class="rogue-score"><strong>${Math.min(12, r.wins)}<small> / 12</small></strong><span>WINNING MARKETS</span></div></div>
      <ol class="rogue-path">${RogueRules.stages.map((name, i) => `<li class="${r.cleared > i ? "cleared" : r.stage === i + 1 ? "current" : ""}" ${!r.victory && r.stage === i + 1 ? 'aria-current="step"' : ""}><span class="rogue-node">${r.cleared > i ? "&#10003;" : String(i + 1).padStart(2,"0")}</span><div><b>${name}</b><small>${(i+1)*3} wins${i===3 ? " · VICTORY" : " · DRAFT"}</small></div></li>`).join("")}</ol>
      <div class="rogue-progress" role="progressbar" aria-label="Winning markets" aria-valuemin="0" aria-valuemax="12" aria-valuenow="${Math.min(12,r.wins)}"><span style="width:${Math.min(100,r.wins/12*100)}%"></span></div>
      <div class="rogue-status"><span>${r.rewardDue ? "STAGE CLEARED · Choose an upgrade below to continue." : r.victory ? (r.pending ? `${r.pending} open picks must resolve before your next run.` : "VICTORY · Ready for another expedition.") : r.dead ? "ELIMINATED · Your expedition will be saved when you restart." : `${nextWins-r.wins} more winning market${nextWins-r.wins===1?"":"s"} to ${r.stage===4 ? "victory" : "your next upgrade"}.`}</span><span>${r.pending} OPEN PICKS</span></div>
      ${Number(state.bankroll) === 0 && r.pending ? '<div class="rogue-warning">ALL IN · Your run stays alive while your open picks resolve.</div>' : ""}
      ${r.rewardDue ? `<div class="rogue-draft"><div class="rogue-eyebrow">REWARD ${r.rewardIndex+1} OF 3</div><h3>Choose your advantage.</h3><p>Pick one. Relics stack and last for this run. Existing picks keep their original payout.</p><div class="rogue-choices">${r.choices.map(u=>`<button type="button" class="rogue-choice" data-upgrade="${u.id}" ${busy?"disabled":""}><span>${u.kind}</span><b>${u.name}</b><p>${u.description}</p><small>CHOOSE &rarr;</small></button>`).join("")}</div></div>` : ""}
      <div class="rogue-inventory"><span class="rogue-eyebrow">YOUR BUILD</span><div>${relics.length ? relics.map(u=>`<span class="rogue-relic" title="${u.description}">${u.name}${u.id==="supplies"?" · +$150 claimed":""}</span>`).join("") : '<span class="rogue-empty">No relics yet. Win 3 qualifying markets to draft your first upgrade.</span>'}</div></div>
      ${r.canRestart ? `<button class="rogue-restart" type="button" ${busy?"disabled":""}>${busy?"Starting…":"START NEW EXPEDITION · $1,000"}</button>` : ""}
      <div class="rogue-error" role="status">${esc(error)}</div>
      <div class="rogue-footer"><details><summary>How expeditions work</summary><p>Win 12 distinct markets to finish four stages. A winning pick must stake at least $25 to count; repeated wins on the same market count once. Smaller picks still pay out but do not advance stages.</p><p>Draft one of three upgrades at 3, 6, and 9 wins. Relic percentages add together and apply to profit, not returned stake. Only picks placed after a relic is chosen receive its bonus. Supply caches add $150; this is not betting profit.</p><p>Your existing bankroll and picks are preserved. Progress begins with picks placed after this update. Matches resolve on the live esports schedule. At $0 with no open picks or unclaimed rewards, the run ends. Upgrades reset on your next run.</p></details><button type="button" class="rogue-history-toggle" aria-expanded="${historyOpen}">Expedition log</button></div>
      ${historyOpen ? `<div class="rogue-log">${history === null ? "Loading expeditions…" : history.length ? history.map(h=>`<div><b>${h.result === "VICTORY" ? "VICTORY" : h.result === "RESET" ? "RESET" : "ELIMINATED"}</b><span>${h.wins} wins · ${fmt(Number(h.ending_balance_cents)/100)} ending bankroll</span><small>${new Date(h.ended_at).toLocaleDateString()} · ${h.picked.map(id=>RogueRules.upgrades.find(u=>u.id===id)?.name || "").join(", ") || "No upgrades"}</small></div>`).join("") : "Completed expeditions will appear here. Earlier betting runs are still in Run History."}</div>` : ""}`;
    panel.querySelectorAll("[data-upgrade]").forEach(button => button.addEventListener("click", () => mutate("/api/rogue/reward", { runId:r.id, rewardIndex:r.rewardIndex, upgrade:button.dataset.upgrade })));
    panel.querySelector(".rogue-restart")?.addEventListener("click", () => mutate("/api/new-run", {}));
    panel.querySelector(".rogue-history-toggle")?.addEventListener("click", async () => {
      historyOpen = !historyOpen; renderGameState();
      if (historyOpen && history === null) {
        const userId = state.user.id;
        try {
          const data = await apiJson("/api/rogue/history");
          if (state.user?.id !== userId) return;
          history = data.runs;
        } catch(e) { error = e.message; history = []; }
        renderGameState();
      }
    });
  }
  async function mutate(url, body) {
    if (busy) return;
    busy = true; error = ""; renderGameState();
    try {
      const result = await apiJson(url, { method:"POST", body:JSON.stringify(body) });
      const data = result.user ? result : await apiJson("/api/me");
      history = null;
      if (url === "/api/new-run") { selected = null; stakeDraft = 25; }
      applyAccountState(data); renderSlip(); loadLeaderboard().catch(()=>{});
    } catch(e) {
      error = e.message;
      try { applyAccountState(await apiJson("/api/me")); } catch {}
    } finally { busy = false; renderGameState(); }
  }
  const original = window.applyAccountState;
  window.applyAccountState = function(data) {
    const previousRun = state.rogue?.id;
    original(data); renderGameState(); updateSelectedSlipPrice();
    if (data.rogue?.id && previousRun !== data.rogue.id) {
      apiJson("/api/run-history").then(h => {
        const badge = document.getElementById("currentRunBadge");
        if (badge && state.rogue?.id === data.rogue.id) badge.textContent = `Run #${h.currentRun.runNumber}`;
      }).catch(()=>{});
    }
  };
  renderGameState();
})();
