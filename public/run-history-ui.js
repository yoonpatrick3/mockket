(() => {
  const style = document.createElement("style");
  style.textContent = `
    .run-toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;margin:0 0 16px}
    .run-current{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--muted)}
    .run-badge{display:inline-flex;align-items:center;padding:5px 9px;border-radius:999px;border:1px solid var(--accent);color:var(--accent);font-weight:900;font-size:11px;letter-spacing:.04em}
    .run-history-btn{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;padding:8px 11px;cursor:pointer;font-weight:800;font-size:12px}
    .run-history-btn:hover{border-color:#505667}
    .run-modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.76);display:none;align-items:flex-start;justify-content:center;padding:40px 16px;z-index:1500;overflow:auto}
    .run-modal-backdrop.open{display:flex}
    .run-modal{width:min(900px,100%);background:var(--bg);border:1px solid var(--line);border-radius:18px;padding:20px}
    .run-modal-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:18px}
    .run-modal-head h2{margin:0;font-size:20px}
    .run-modal-head .sub{margin-top:4px}
    .run-close{margin-left:auto;border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:10px;padding:8px 11px;cursor:pointer}
    .run-summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px}
    .run-summary-card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:13px}
    .run-summary-card label{display:block;color:var(--muted);font-size:10px;margin-bottom:5px}
    .run-summary-card strong{font-size:17px}
    .run-list{display:grid;gap:10px}
    .run-card{width:100%;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;color:var(--text);cursor:pointer}
    .run-card:hover{border-color:#505667}
    .run-card-top{display:flex;align-items:center;gap:10px;margin-bottom:9px}
    .run-card-title{font-weight:900;font-size:14px}
    .run-card-date{color:var(--muted);font-size:11px;margin-left:auto}
    .run-card-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
    .run-mini label{display:block;color:var(--muted);font-size:9px;margin-bottom:2px}
    .run-mini strong{font-size:12px}
    .run-empty{color:var(--muted);padding:22px 4px;text-align:center}
    .run-detail-back{border:0;background:transparent;color:var(--accent);cursor:pointer;padding:0;margin:0 0 14px;font-weight:800}
    .run-detail-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:16px}
    .run-detail-table{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
    .run-detail-table table{min-width:800px}
    .run-detail-table th,.run-detail-table td{white-space:nowrap}
    .run-detail-table td:nth-child(2){white-space:normal;min-width:240px}
    .leaderboard-card{overflow-x:auto!important}
    .leaderboard-card table{min-width:860px}
    @media(max-width:860px){
      .run-toolbar{align-items:flex-start;flex-direction:column}
      .run-summary-grid{grid-template-columns:repeat(2,1fr)}
      .run-card-stats{grid-template-columns:repeat(2,1fr)}
      .run-detail-grid{grid-template-columns:repeat(2,1fr)}
    }
  `;
  document.head.appendChild(style);

  let runHistoryCache = null;

  function signedMoney(value){
    const n=Number(value||0);
    return `${n>=0?"+":""}${fmt(n)}`;
  }

  function shortDate(value){
    if(!value) return "—";
    const d=new Date(value);
    if(Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
  }

  function dateRange(run){
    if(!run) return "";
    const start=shortDate(run.startedAt);
    const end=shortDate(run.endedAt);
    return start===end ? start : `${start} – ${end}`;
  }

  async function fetchRunHistory(force=false){
    if(runHistoryCache && !force) return runHistoryCache;
    runHistoryCache=await apiJson("/api/run-history");
    updateCurrentRunBadge(runHistoryCache);
    return runHistoryCache;
  }

  function updateCurrentRunBadge(data){
    const badge=document.getElementById("currentRunBadge");
    if(badge){
      badge.textContent=`Run #${Number(data?.currentRun?.runNumber || 1)}`;
    }
  }

  function installStatsRunToolbar(){
    const panel=document.getElementById("tab-stats");
    const grid=panel?.querySelector(".stats-grid");
    if(!panel || !grid || document.getElementById("runToolbar")) return;

    const toolbar=document.createElement("div");
    toolbar.id="runToolbar";
    toolbar.className="run-toolbar";
    toolbar.innerHTML=`
      <div class="run-current">
        <span id="currentRunBadge" class="run-badge">Run #1</span>
        <span>Current run stats</span>
      </div>
      <button id="viewRunHistoryBtn" class="run-history-btn" type="button">View Run History →</button>
    `;
    panel.insertBefore(toolbar,grid);
    document.getElementById("viewRunHistoryBtn").addEventListener("click",openRunHistory);
  }

  function installRunModal(){
    if(document.getElementById("runHistoryBackdrop")) return;
    const backdrop=document.createElement("div");
    backdrop.id="runHistoryBackdrop";
    backdrop.className="run-modal-backdrop";
    backdrop.innerHTML=`
      <div class="run-modal" role="dialog" aria-modal="true">
        <div class="run-modal-head">
          <div>
            <h2>Run History</h2>
            <div class="sub">Current stats stay focused on this run. Finished runs live here.</div>
          </div>
          <button id="runHistoryClose" class="run-close" type="button">Close</button>
        </div>
        <div id="runHistoryContent"><div class="run-empty">Loading runs…</div></div>
      </div>
    `;
    document.body.appendChild(backdrop);
    document.getElementById("runHistoryClose").addEventListener("click",closeRunHistory);
    backdrop.addEventListener("click",e=>{
      if(e.target===backdrop) closeRunHistory();
    });
  }

  async function openRunHistory(){
    const backdrop=document.getElementById("runHistoryBackdrop");
    if(!backdrop) return;
    backdrop.classList.add("open");
    try{
      const data=await fetchRunHistory(true);
      renderRunHistory(data);
    }catch(e){
      document.getElementById("runHistoryContent").innerHTML=`<div class="run-empty">${esc(e.message)}</div>`;
    }
  }

  function closeRunHistory(){
    document.getElementById("runHistoryBackdrop")?.classList.remove("open");
  }

  function renderRunHistory(data){
    const content=document.getElementById("runHistoryContent");
    if(!content) return;
    const summary=data.summary || {};
    const current=data.currentRun || {};
    const runs=Array.isArray(data.runs)?data.runs:[];

    const best=summary.bestRun
      ? `Run #${summary.bestRun.runNumber} · ${signedMoney(summary.bestRun.pnl)}`
      : "—";

    content.innerHTML=`
      <div class="run-summary-grid">
        <div class="run-summary-card"><label>CURRENT RUN</label><strong>#${Number(current.runNumber||1)}</strong></div>
        <div class="run-summary-card"><label>TOTAL RUNS</label><strong>${Number(summary.totalRuns||1)}</strong></div>
        <div class="run-summary-card"><label>LIFETIME P/L</label><strong class="${Number(summary.lifetimePnl)>=0?"pos":"neg"}">${signedMoney(summary.lifetimePnl)}</strong></div>
        <div class="run-summary-card"><label>AVG COMPLETED RUN</label><strong class="${Number(summary.avgCompletedRunPnl)>=0?"pos":"neg"}">${summary.completedRuns?signedMoney(summary.avgCompletedRunPnl):"—"}</strong></div>
        <div class="run-summary-card"><label>BEST RUN</label><strong>${best}</strong></div>
        <div class="run-summary-card"><label>CURRENT RECORD</label><strong>${Number(current.wins||0)}-${Number(current.losses||0)}</strong></div>
        <div class="run-summary-card"><label>CURRENT P/L</label><strong class="${Number(current.pnl)>=0?"pos":"neg"}">${signedMoney(current.pnl)}</strong></div>
        <div class="run-summary-card"><label>CURRENT BETS</label><strong>${Number(current.totalBets||0)}</strong></div>
      </div>
      <div class="section-title"><h2>Completed runs</h2></div>
      <div class="run-list">
        ${runs.length ? runs.map(run=>`
          <button class="run-card" type="button" data-run-id="${run.id}">
            <div class="run-card-top">
              <span class="run-card-title">Run #${run.runNumber}</span>
              <span class="run-card-date">${esc(dateRange(run))}</span>
            </div>
            <div class="run-card-stats">
              <div class="run-mini"><label>P/L</label><strong class="${Number(run.pnl)>=0?"pos":"neg"}">${signedMoney(run.pnl)}</strong></div>
              <div class="run-mini"><label>RECORD</label><strong>${run.wins}-${run.losses}${run.openBets?` (${run.openBets}p)`:""}</strong></div>
              <div class="run-mini"><label>BETS</label><strong>${run.totalBets}</strong></div>
              <div class="run-mini"><label>ENDING BANKROLL</label><strong>${fmt(run.endingBalance)}</strong></div>
              <div class="run-mini"><label>REFILLS</label><strong>${run.refillCount}</strong></div>
            </div>
          </button>
        `).join("") : `<div class="run-empty">No completed runs yet. When you end this run, it will appear here.</div>`}
      </div>
    `;

    content.querySelectorAll(".run-card").forEach(card=>{
      card.addEventListener("click",()=>openRunDetail(Number(card.dataset.runId)));
    });
  }

  async function openRunDetail(runId){
    const content=document.getElementById("runHistoryContent");
    if(!content) return;
    content.innerHTML=`<div class="run-empty">Loading Run…</div>`;
    try{
      const data=await apiJson(`/api/run-history/${runId}`);
      renderRunDetail(data);
    }catch(e){
      content.innerHTML=`<button class="run-detail-back" id="backToRuns" type="button">← Back to runs</button><div class="run-empty">${esc(e.message)}</div>`;
      document.getElementById("backToRuns")?.addEventListener("click",()=>fetchRunHistory().then(renderRunHistory));
    }
  }

  function renderRunDetail(data){
    const content=document.getElementById("runHistoryContent");
    if(!content) return;
    const run=data.run || {};
    const bets=Array.isArray(data.bets)?data.bets:[];

    content.innerHTML=`
      <button class="run-detail-back" id="backToRuns" type="button">← Back to runs</button>
      <div class="section-title"><h2>Run #${run.runNumber}</h2><span style="color:var(--muted);font-size:12px">${esc(dateRange(run))}</span></div>
      <div class="run-detail-grid">
        <div class="run-summary-card"><label>NET P/L</label><strong class="${Number(run.pnl)>=0?"pos":"neg"}">${signedMoney(run.pnl)}</strong></div>
        <div class="run-summary-card"><label>RECORD</label><strong>${run.wins}-${run.losses}</strong></div>
        <div class="run-summary-card"><label>ROI</label><strong>${Number(run.roi||0).toFixed(1)}%</strong></div>
        <div class="run-summary-card"><label>TOTAL BETS</label><strong>${run.totalBets}</strong></div>
        <div class="run-summary-card"><label>ENDING BANKROLL</label><strong>${fmt(run.endingBalance)}</strong></div>
        <div class="run-summary-card"><label>REFILLS</label><strong>${run.refillCount}</strong></div>
      </div>
      <div class="section-title"><h2>Run bets</h2></div>
      <div class="run-detail-table">
        <table>
          <thead><tr><th>Placed</th><th>Match</th><th>Pick</th><th>Stake</th><th>Entry</th><th>Status</th><th>P/L</th></tr></thead>
          <tbody>
            ${bets.length ? bets.map(b=>`
              <tr>
                <td>${esc(new Date(b.placedAt).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}))}</td>
                <td>${esc(String(b.question||""))}</td>
                <td>${esc(String(b.outcome||""))}</td>
                <td>${fmt(b.stake)}</td>
                <td>${Math.round(Number(b.entryPrice||0)*100)}%</td>
                <td><span class="status">${esc(String(b.status||""))}</span></td>
                <td class="${Number(b.pnl)>0?"pos":Number(b.pnl)<0?"neg":""}">${b.status==="OPEN"?"—":signedMoney(b.pnl)}</td>
              </tr>
            `).join("") : `<tr><td colspan="7" style="color:var(--muted)">No bets saved for this run.</td></tr>`}
          </tbody>
        </table>
      </div>
    `;

    document.getElementById("backToRuns")?.addEventListener("click",()=>fetchRunHistory().then(renderRunHistory));
  }

  function replaceResetButton(){
    const old=document.getElementById("reset");
    if(!old || old.dataset.runAware==="true") return;
    const button=old.cloneNode(true);
    button.dataset.runAware="true";
    button.textContent="End Run & Start New Run";
    old.replaceWith(button);

    button.addEventListener("click",async()=>{
      let history;
      try{ history=await fetchRunHistory(); }catch{}
      const currentNumber=Number(history?.currentRun?.runNumber||1);
      const nextNumber=currentNumber+1;

      if(!confirm(`End Run #${currentNumber}? Its bets and stats will be saved to Run History, and Run #${nextNumber} will start with $1,000.`)) return;

      const resetSecret=prompt("Enter the MOCKKET recovery code to end this run:");
      if(resetSecret===null) return;
      if(!resetSecret){ alert("Recovery code is required."); return; }

      button.disabled=true;
      try{
        const data=await apiJson("/api/reset",{
          method:"POST",
          body:JSON.stringify({resetSecret})
        });
        selected=null;
        stakeDraft=25;
        applyAccountState(data);
        renderSlip();
        runHistoryCache=null;
        await fetchRunHistory(true);
        loadLeaderboard().catch(()=>{});
        alert(`Run #${currentNumber} saved. Run #${nextNumber} is live.`);
      }catch(e){
        alert(e.message);
      }finally{
        button.disabled=false;
      }
    });
  }

  async function loadLeaderboardWithRuns(){
    if(!state.user) return;
    const body=document.getElementById("leaderboardBody");
    const table=body?.closest("table");
    if(!body || !table) return;

    const head=table.querySelector("thead tr");
    if(head){
      head.innerHTML="<th>#</th><th>Player</th><th>Current P/L</th><th>ROI</th><th>Record</th><th>Open</th><th>Bankroll</th><th>Runs</th><th>Avg Run P/L</th>";
    }

    try{
      const data=await apiJson("/api/leaderboard");
      const rows=data.leaderboard || [];
      body.innerHTML=rows.length ? rows.map(r=>`<tr class="${r.username===state.user.username?"leader-me":""}">
        <td>${r.rank}</td>
        <td>${esc(r.username)}</td>
        <td class="${r.pnl>0?"pos":r.pnl<0?"neg":""}">${signedMoney(r.pnl)}</td>
        <td>${Number(r.roi).toFixed(1)}%</td>
        <td>${r.wins}-${r.losses}</td>
        <td>${r.openBets}</td>
        <td>${fmt(r.bankroll)}</td>
        <td>${Number(r.runs||1)}</td>
        <td class="${Number(r.avgRunPnl)>0?"pos":Number(r.avgRunPnl)<0?"neg":""}">${Number(r.completedRuns)>0?signedMoney(r.avgRunPnl):"—"}</td>
      </tr>`).join("") : `<tr><td colspan="9" style="color:var(--muted)">No players yet.</td></tr>`;
    }catch(e){
      body.innerHTML=`<tr><td colspan="9" style="color:var(--red)">${esc(e.message)}</td></tr>`;
    }
  }

  installStatsRunToolbar();
  installRunModal();
  replaceResetButton();
  window.loadLeaderboard=loadLeaderboardWithRuns;

  fetchRunHistory(true).catch(()=>{});

  document.addEventListener("keydown",e=>{
    if(e.key==="Escape") closeRunHistory();
  });
})();
