(() => {
  const style=document.createElement("style");
  style.textContent=`
    .run-over-backdrop{position:fixed;inset:0;background:rgba(5,6,8,.94);display:none;align-items:center;justify-content:center;padding:24px;z-index:2500}
    .run-over-backdrop.open{display:flex}
    .run-over-card{width:min(520px,100%);background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:26px;text-align:center;box-shadow:0 24px 80px rgba(0,0,0,.55)}
    .run-over-kicker{font-size:11px;letter-spacing:.18em;color:var(--red);font-weight:900;margin-bottom:8px}
    .run-over-card h1{font-size:34px;margin:0 0 8px;letter-spacing:-.04em}
    .run-over-copy{color:var(--muted);font-size:14px;line-height:1.5;margin-bottom:20px}
    .run-over-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:0 0 20px;text-align:left}
    .run-over-stat{background:var(--panel2);border:1px solid var(--line);border-radius:13px;padding:12px}
    .run-over-stat label{display:block;color:var(--muted);font-size:9px;margin-bottom:4px}
    .run-over-stat strong{font-size:15px}
    .new-run-btn{width:100%;border:0;background:var(--accent);color:#10120c;font-weight:900;border-radius:12px;padding:14px;cursor:pointer;font-size:14px}
    .new-run-btn:disabled{opacity:.5;cursor:not-allowed}
    .all-in-banner{display:none;margin:0 0 16px;padding:13px 15px;background:var(--panel);border:1px solid var(--line);border-radius:14px;color:var(--muted);font-size:12px}
    .all-in-banner.show{display:block}
    .all-in-banner strong{color:var(--text)}
    @media(max-width:600px){
      .run-over-stats{grid-template-columns:1fr}
      .run-over-card h1{font-size:30px}
    }
  `;
  document.head.appendChild(style);

  // Daily refill UI is retired.
  const refillButton=document.getElementById("refillBtn");
  const refillNote=document.getElementById("refillNote");
  if(refillButton) refillButton.style.display="none";
  if(refillNote) refillNote.style.display="none";

  const app=document.getElementById("appShell");
  const header=app?.querySelector("header");
  if(app && header && !document.getElementById("allInBanner")){
    const banner=document.createElement("div");
    banner.id="allInBanner";
    banner.className="all-in-banner";
    header.insertAdjacentElement("afterend",banner);
  }

  if(!document.getElementById("runOverBackdrop")){
    const backdrop=document.createElement("div");
    backdrop.id="runOverBackdrop";
    backdrop.className="run-over-backdrop";
    backdrop.innerHTML=`
      <div class="run-over-card">
        <div class="run-over-kicker">RUN OVER</div>
        <h1>You went broke.</h1>
        <div class="run-over-copy">That run is dead. Your bets and stats are saved forever in Run History.</div>
        <div id="runOverStats" class="run-over-stats"></div>
        <button id="startNewRunBtn" class="new-run-btn" type="button">START NEW RUN — $1,000</button>
      </div>
    `;
    document.body.appendChild(backdrop);
  }

  function signedMoney(n){
    n=Number(n||0);
    return `${n>=0?"+":""}${fmt(n)}`;
  }

  async function currentRunInfo(){
    try{return await apiJson("/api/run-history");}
    catch{return null;}
  }

  async function renderGameState(){
    if(!state?.user) return;

    const pending=(state.bets||[]).filter(b=>b.status==="OPEN").length;
    const dead=Number(state.bankroll)===0 && pending===0;
    const allIn=Number(state.bankroll)===0 && pending>0;

    const refillButton=document.getElementById("refillBtn");
    const refillNote=document.getElementById("refillNote");
    if(refillButton) refillButton.style.display="none";
    if(refillNote) refillNote.style.display="none";

    const banner=document.getElementById("allInBanner");
    if(banner){
      if(allIn){
        banner.classList.add("show");
        banner.innerHTML=`<strong>ALL IN.</strong> You have $0 available and ${pending} pending bet${pending===1?"":"s"}. Your run stays alive until ${pending===1?"it resolves":"they resolve"}.`;
      }else{
        banner.classList.remove("show");
        banner.textContent="";
      }
    }

    const backdrop=document.getElementById("runOverBackdrop");
    if(!backdrop) return;

    if(!dead){
      backdrop.classList.remove("open");
      return;
    }

    const resolved=(state.bets||[]).filter(b=>b.status!=="OPEN");
    const wins=resolved.filter(b=>b.status==="WON").length;
    const losses=resolved.filter(b=>b.status==="LOST").length;
    const pnl=resolved.reduce((sum,b)=>sum+Number(b.pnl||0),0);
    const history=await currentRunInfo();
    const runNumber=Number(history?.currentRun?.runNumber||1);

    document.getElementById("runOverStats").innerHTML=`
      <div class="run-over-stat"><label>RUN</label><strong>#${runNumber}</strong></div>
      <div class="run-over-stat"><label>FINAL P/L</label><strong class="${pnl>=0?"pos":"neg"}">${signedMoney(pnl)}</strong></div>
      <div class="run-over-stat"><label>RECORD</label><strong>${wins}-${losses}</strong></div>
      <div class="run-over-stat"><label>BETS</label><strong>${state.bets.length}</strong></div>
      <div class="run-over-stat"><label>ENDING BANKROLL</label><strong>${fmt(state.bankroll)}</strong></div>
      <div class="run-over-stat"><label>STATUS</label><strong>ELIMINATED</strong></div>
    `;

    backdrop.classList.add("open");
  }

  const originalRenderRefill=window.renderRefill;
  window.renderRefill=function(){
    if(typeof originalRenderRefill==="function") originalRenderRefill();
    const button=document.getElementById("refillBtn");
    const note=document.getElementById("refillNote");
    if(button) button.style.display="none";
    if(note) note.style.display="none";
  };

  const originalApplyAccountState=window.applyAccountState;
  window.applyAccountState=function(data){
    originalApplyAccountState(data);
    setTimeout(()=>renderGameState(),0);
  };

  document.getElementById("startNewRunBtn")?.addEventListener("click",async()=>{
    const button=document.getElementById("startNewRunBtn");
    button.disabled=true;
    try{
      await apiJson("/api/new-run",{method:"POST",body:"{}"});
      const data=await apiJson("/api/me");
      selected=null;
      stakeDraft=25;
      applyAccountState(data);
      renderSlip();

      const history=await currentRunInfo();
      const badge=document.getElementById("currentRunBadge");
      if(badge && history){
        badge.textContent=`Run #${Number(history.currentRun?.runNumber||1)}`;
      }

      loadLeaderboard?.().catch(()=>{});
    }catch(e){
      alert(e.message);
    }finally{
      button.disabled=false;
    }
  });

  // Manual early reset no longer belongs in the game loop.
  const endRunButton=document.getElementById("reset");
  if(endRunButton){
    endRunButton.style.display="none";
  }

  renderGameState();
})();
