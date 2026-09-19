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
    if (historyUser !== state.user.id) {
      history = null;
      historyOpen = false;
      historyUser = state.user.id;
    }

    panel.hidden = false;
    const relics = (r.picked || []).map(id => RogueRules.upgrades.find(u => u.id === id)).filter(Boolean);
    const selectedStakeCents = Math.max(0, Math.round(Number(stakeDraft || 0) * 100));
    const selectedPrice = Number(selected?.price);
    const hasSelectedPick = Boolean(selected && Number.isFinite(selectedPrice));
    const activeRate = hasSelectedPick ? RogueRules.effectRate(selectedStakeCents, selectedPrice, r.picked || []) : 0;
    const threshold = Number(r.shopThreshold || RogueRules.SHOP_THRESHOLD || 60);
    const progress = Math.min(threshold, Number(r.shopProgress || 0));
    const remaining = Math.max(0, threshold - progress);
    const title = r.victory
      ? "You survived the expedition."
      : r.dead
        ? "The bankroll is gone."
        : r.shopOpen
          ? "A merchant found you."
          : "Risk money. Build an edge.";

    const subtitle = r.victory
      ? "Four merchants survived. One bankroll. Your build made it to the end."
      : r.dead
        ? "No bankroll and no open picks remain. Archive the run and start again."
        : r.shopOpen
          ? "Your bankroll is both your HP and your currency. Buy one upgrade or keep every dollar."
          : "Resolved risk moves the run forward. Losses push the merchant meter slightly faster.";

    panel.innerHTML = `
      <div class="rogue-top">
        <div>
          <div class="rogue-eyebrow">MOCKKET EXPEDITIONS <span>MERCHANT BUILD</span></div>
          <h2>${title}</h2>
          <p>${subtitle}</p>
        </div>
        <div class="rogue-score">
          <strong>${r.victory ? "4" : progress}<small> / ${r.victory ? "4" : threshold}</small></strong>
          <span>${r.victory ? "ACTS CLEARED" : "MERCHANT PROGRESS"}</span>
        </div>
      </div>

      <ol class="rogue-path">
        ${RogueRules.stages.map((name, i) => `
          <li class="${r.cleared > i ? "cleared" : r.stage === i + 1 && !r.victory ? "current" : ""}" ${!r.victory && r.stage === i + 1 ? 'aria-current="step"' : ""}>
            <span class="rogue-node">${r.cleared > i ? "&#10003;" : String(i + 1).padStart(2,"0")}</span>
            <div><b>${name}</b><small>${i === 3 ? "FINAL MERCHANT · VICTORY" : "MERCHANT CHECKPOINT"}</small></div>
          </li>`).join("")}
      </ol>

      <div class="rogue-progress" role="progressbar" aria-label="Merchant progress" aria-valuemin="0" aria-valuemax="${threshold}" aria-valuenow="${progress}">
        <span style="width:${r.victory ? 100 : Math.min(100, progress / threshold * 100)}%"></span>
      </div>

      <div class="rogue-status">
        <span>${r.shopOpen
          ? "MERCHANT READY · Further bet resolutions will not bank progress until you leave the shop."
          : r.victory
            ? (r.pending ? `${r.pending} open picks must resolve before your next expedition.` : "VICTORY · Ready for another expedition.")
            : r.dead
              ? "ELIMINATED · Your expedition will be saved when you restart."
              : `${remaining} progress to the next merchant · losses earn 1.25× progress.`}</span>
        <span>${r.pending} OPEN PICKS</span>
      </div>

      ${Number(state.bankroll) === 0 && r.pending ? '<div class="rogue-warning">ALL IN · Your run stays alive while your open picks resolve.</div>' : ""}

      ${r.shopOpen ? `
        <div class="rogue-draft">
          <div class="rogue-merchant-head">
            <div>
              <div class="rogue-eyebrow">MERCHANT ${Math.min(4, r.shopIndex + 1)} OF 4</div>
              <h3>Spend HP to strengthen the build.</h3>
              <p>Buy one relic, or walk away with your bankroll untouched. Relics affect future picks only.</p>
            </div>
            <div class="rogue-bankroll">BANKROLL <b>${fmt(Number(state.bankroll || 0))}</b></div>
          </div>
          <div class="rogue-choices">
            ${(r.choices || []).map(u => `
              <button type="button" class="rogue-choice" data-upgrade="${u.id}" ${busy ? "disabled" : ""}>
                <span>${u.kind}</span>
                <b>${u.name}</b>
                <p>${u.description}</p>
                <div class="rogue-price">-${fmt(Number(u.cost || 0))}</div>
                <small>BUY RELIC &rarr;</small>
              </button>`).join("")}
          </div>
          <button type="button" class="rogue-skip" ${busy ? "disabled" : ""}>KEEP MY MONEY · LEAVE SHOP</button>
        </div>` : ""}

      <div class="rogue-inventory">
        <span class="rogue-eyebrow">YOUR BUILD</span>
        <div class="rogue-relic-list">${relics.length
          ? relics.map(u => {
              const active = hasSelectedPick && RogueRules.relicApplies(u.id, selectedStakeCents, selectedPrice);
              return `<button type="button" class="rogue-relic ${hasSelectedPick ? (active ? "active-effect" : "inactive-effect") : ""}" aria-label="${esc(u.name)}: ${esc(u.description)}">
                <span class="rogue-relic-name">${esc(u.name)}</span>
                <span class="rogue-relic-bonus">${esc(u.bonusLabel || "")}</span>
                <span class="rogue-relic-tooltip" role="tooltip">
                  <b>${esc(u.name)}</b>
                  <span>${esc(u.description)}</span>
                  <small>Triggers: ${esc(u.trigger || "Future winning picks")}</small>
                  ${hasSelectedPick ? `<em class="${active ? "on" : "off"}">${active ? "ACTIVE ON CURRENT PICK" : "NOT ACTIVE ON CURRENT PICK"}</em>` : ""}
                </span>
              </button>`;
            }).join("")
          : '<span class="rogue-empty">No relics yet. Resolve meaningful bets to find your first merchant.</span>'}</div>
      </div>

      ${relics.length ? `<div class="rogue-effect-summary ${hasSelectedPick && activeRate > 0 ? "live" : ""}">
        <span class="rogue-effect-icon">✦</span>
        <div>
          <b>${hasSelectedPick ? (activeRate > 0 ? `CURRENT PICK · +${activeRate}% PROFIT` : "CURRENT PICK · NO RELIC BONUS") : "RELIC EFFECTS"}</b>
          <small>${hasSelectedPick
            ? (activeRate > 0 ? "Highlighted relics are modifying the profit on this pick." : "None of your current relic conditions match this pick.")
            : "Choose a market to see which relics activate on that pick."}</small>
        </div>
      </div>` : ""}

      ${r.canRestart ? `<button class="rogue-restart" type="button" ${busy ? "disabled" : ""}>${busy ? "Starting…" : "START NEW EXPEDITION · $1,000"}</button>` : ""}
      <div class="rogue-error" role="status">${esc(error)}</div>

      <div class="rogue-footer">
        <details>
          <summary>How expeditions work</summary>
          <p>Resolved bets generate Merchant Progress based on how much bankroll you risked. A bet can contribute at most 25 progress, so one giant all-in cannot instantly chain shops. Tiny bets barely move the meter.</p>
          <p>Winning bets generate normal progress. Losing bets generate 1.25× progress, giving struggling runs a small comeback nudge without refunding losses. Once a merchant is waiting, additional resolutions do not bank progress until you buy something or leave.</p>
          <p>Each merchant offers three run relics. Buying one permanently spends bankroll, so the same money keeping you alive is also your upgrade currency. You can always skip. Purchases can never reduce you below $1. Clear four merchant checkpoints to win the expedition.</p>
        </details>
        <button type="button" class="rogue-history-toggle" aria-expanded="${historyOpen}">Expedition log</button>
      </div>

      ${historyOpen ? `<div class="rogue-log">${history === null
        ? "Loading expeditions…"
        : history.length
          ? history.map(h => `<div><b>${h.result === "VICTORY" ? "VICTORY" : h.result === "RESET" ? "RESET" : "ELIMINATED"}</b><span>${h.wins} winning markets · ${fmt(Number(h.ending_balance_cents)/100)} ending bankroll</span><small>${new Date(h.ended_at).toLocaleDateString()} · ${(h.picked || []).map(id => RogueRules.upgrades.find(u => u.id === id)?.name || "").filter(Boolean).join(", ") || "No relics"}</small></div>`).join("")
          : "Completed expeditions will appear here. Earlier betting runs are still in Run History."}</div>` : ""}
    `;

    panel.querySelectorAll("[data-upgrade]").forEach(button => button.addEventListener("click", () => mutate("/api/rogue/reward", {
      runId: r.id,
      rewardIndex: r.shopIndex,
      upgrade: button.dataset.upgrade
    })));

    panel.querySelector(".rogue-skip")?.addEventListener("click", () => mutate("/api/rogue/reward", {
      runId: r.id,
      rewardIndex: r.shopIndex,
      skip: true
    }));

    panel.querySelector(".rogue-restart")?.addEventListener("click", () => mutate("/api/new-run", {}));
    panel.querySelector(".rogue-history-toggle")?.addEventListener("click", async () => {
      historyOpen = !historyOpen;
      renderGameState();
      if (historyOpen && history === null) {
        const userId = state.user.id;
        try {
          const data = await apiJson("/api/rogue/history");
          if (state.user?.id !== userId) return;
          history = data.runs;
        } catch(e) {
          error = e.message;
          history = [];
        }
        renderGameState();
      }
    });
  }

  async function mutate(url, body) {
    if (busy) return;
    busy = true;
    error = "";
    renderGameState();
    try {
      const result = await apiJson(url, { method:"POST", body:JSON.stringify(body) });
      const data = result.user ? result : await apiJson("/api/me");
      history = null;
      if (url === "/api/new-run") { selected = null; stakeDraft = 25; }
      applyAccountState(data);
      renderSlip();
      loadLeaderboard().catch(()=>{});
    } catch(e) {
      error = e.message;
      try { applyAccountState(await apiJson("/api/me")); } catch {}
    } finally {
      busy = false;
      renderGameState();
    }
  }

  const original = window.applyAccountState;
  window.applyAccountState = function(data) {
    const previousRun = state.rogue?.id;
    original(data);
    renderGameState();
    updateSelectedSlipPrice();
    if (data.rogue?.id && previousRun !== data.rogue.id) {
      apiJson("/api/run-history").then(h => {
        const badge = document.getElementById("currentRunBadge");
        if (badge && state.rogue?.id === data.rogue.id) badge.textContent = `Run #${h.currentRun.runNumber}`;
      }).catch(()=>{});
    }
  };

  document.addEventListener("click", () => setTimeout(() => {
    if (state.user && state.rogue) renderGameState();
  }, 0), true);
  document.addEventListener("input", e => {
    if (e.target?.id === "stake") renderGameState();
  }, true);

  renderGameState();
})();
