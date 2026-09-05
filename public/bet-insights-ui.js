(() => {
  const style=document.createElement("style");
  style.textContent=`
    .pnl-chart-tooltip{position:fixed;z-index:1800;pointer-events:none;display:none;max-width:330px;background:#171a20;border:1px solid #3a3f4d;border-radius:11px;padding:10px 12px;color:#f4f6fb;box-shadow:0 12px 32px rgba(0,0,0,.42);font-size:11px;line-height:1.4}
    .pnl-chart-tooltip strong{display:block;font-size:12px;margin-bottom:4px}
    .pnl-chart-tooltip .tip-pick{color:#b6ff5c;font-weight:800}
    .pnl-chart-tooltip .tip-meta{color:#9298a8;margin-top:3px}
    #pnlChart{cursor:crosshair}
    .game-date-cell{white-space:nowrap}
    .match-open-stake{display:inline-flex;align-items:center;gap:6px;margin:-3px 0 12px;padding:6px 9px;border:1px solid rgba(182,255,92,.28);background:rgba(182,255,92,.07);border-radius:8px;color:#b6ff5c;font-size:11px;font-weight:800}
    .match-open-stake span{color:#9298a8;font-weight:600}
  `;
  document.head.appendChild(style);

  const tooltip=document.createElement("div");
  tooltip.id="pnlBetTooltip";
  tooltip.className="pnl-chart-tooltip";
  document.body.appendChild(tooltip);

  function gameDate(value){
    if(!value) return "TBD";
    const d=new Date(value);
    if(Number.isNaN(d.getTime())) return "TBD";
    return d.toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
  }

  function resolvedBets(){
    return (state.bets||[])
      .filter(b=>b.status!=="OPEN")
      .slice()
      .sort((a,b)=>new Date(a.resolvedAt||a.placedAt)-new Date(b.resolvedAt||b.placedAt));
  }

  function chartGeometry(canvas,resolved){
    const rect=canvas.getBoundingClientRect();
    const ctx=canvas.getContext("2d");
    ctx.save();
    ctx.font="11px system-ui";
    let cumulative=0;
    const values=[0];
    resolved.forEach(b=>{ cumulative+=Number(b.pnl||0); values.push(cumulative); });
    let rawMin=Math.min(0,...values), rawMax=Math.max(0,...values);
    if(rawMin===rawMax){rawMin-=10;rawMax+=10;}
    const range=rawMax-rawMin||1;
    let min=Math.min(rawMin-range*.08,0), max=Math.max(rawMax+range*.08,0);
    const tickValues=Array.from({length:5},(_,i)=>max-(i/4)*(max-min));
    const axis=v=>{const a=Math.abs(v);return a>=1000?`${v<0?"-":""}$${(a/1000).toFixed(a>=10000?0:1)}k`:`${v<0?"-":""}$${a.toFixed(0)}`;};
    const widest=Math.max(...tickValues.map(v=>ctx.measureText(axis(v)).width),ctx.measureText("$0").width);
    ctx.restore();
    const pad={l:Math.ceil(widest)+18,r:20,t:18,b:36};
    const iw=Math.max(1,rect.width-pad.l-pad.r), ih=Math.max(1,rect.height-pad.t-pad.b);
    const count=resolved.length+1;
    const x=i=>pad.l+(count===1?0:(i/(count-1))*iw);
    const y=v=>pad.t+((max-v)/(max-min))*ih;
    cumulative=0;
    const points=[{x:x(0),y:y(0),value:0,bet:null}];
    resolved.forEach((b,i)=>{cumulative+=Number(b.pnl||0);points.push({x:x(i+1),y:y(cumulative),value:cumulative,bet:b});});
    return {rect,points};
  }

  function installChartTooltip(){
    const canvas=document.getElementById("pnlChart");
    if(!canvas || canvas.dataset.betTooltipInstalled) return;
    canvas.dataset.betTooltipInstalled="1";

    canvas.addEventListener("mousemove",e=>{
      const resolved=resolvedBets();
      if(!resolved.length){tooltip.style.display="none";return;}
      const {rect,points}=chartGeometry(canvas,resolved);
      const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      let nearest=null,dist=Infinity;
      for(const p of points.slice(1)){
        const d=Math.hypot(mx-p.x,my-p.y);
        if(d<dist){dist=d;nearest=p;}
      }
      if(!nearest || dist>14){tooltip.style.display="none";return;}
      const b=nearest.bet;
      const pnl=Number(b.pnl||0);
      tooltip.innerHTML=`<strong>${esc(String(b.question||"Bet"))}</strong><div class="tip-pick">${esc(String(b.outcome||""))} · ${pnl>=0?"+":""}${fmt(pnl)}</div><div class="tip-meta">Stake ${fmt(b.stake)} · Entry ${Math.round(Number(b.entryPrice||0)*100)}% · ${esc(String(b.status||""))}</div><div class="tip-meta">Game: ${esc(gameDate(b.matchStart))} · Resolved: ${esc(gameDate(b.resolvedAt||b.placedAt))}</div><div class="tip-meta">Cumulative P/L: ${nearest.value>=0?"+":""}${fmt(nearest.value)}</div>`;
      tooltip.style.display="block";
      const left=Math.min(window.innerWidth-350,e.clientX+14);
      const top=Math.min(window.innerHeight-130,e.clientY+14);
      tooltip.style.left=`${Math.max(8,left)}px`;
      tooltip.style.top=`${Math.max(8,top)}px`;
    });
    canvas.addEventListener("mouseleave",()=>{tooltip.style.display="none";});
  }

  function normalizeMatchup(s){return String(s||"").toLowerCase().replace(/\s+/g," ").trim();}
  function betMatchup(question){return normalizeMatchup(String(question||"").split(/\s+-\s+(?:match winner|game \d+ winner|map \d+ winner|total games|total maps)/i)[0]);}
  function enhanceMarketCards(){
    const open=(state.bets||[]).filter(b=>b.status==="OPEN");
    document.querySelectorAll(".match-card").forEach(card=>{
      const q=card.querySelector(".q");
      const date=card.querySelector(".match-date");
      if(!q||!date) return;
      const matchup=normalizeMatchup(q.textContent);
      const matching=open.filter(b=>betMatchup(b.question)===matchup);
      const total=matching.reduce((sum,b)=>sum+Number(b.stake||0),0);
      let badge=card.querySelector(".match-open-stake");
      if(total<=0){badge?.remove();return;}
      if(!badge){badge=document.createElement("div");badge.className="match-open-stake";date.after(badge);}
      badge.innerHTML=`YOUR OPEN BETS · ${fmt(total)} <span>${matching.length} ${matching.length===1?"bet":"bets"}</span>`;
    });
  }

  function enhanceHistoryTable(){
    const body=document.getElementById("history");
    const table=body?.closest("table");
    if(!body||!table) return;
    const head=table.querySelector("thead tr");
    if(head && !head.querySelector('[data-game-date-head]')){
      const th=document.createElement("th");
      th.textContent="Game Date";
      th.dataset.gameDateHead="1";
      const matchTh=head.children[2];
      matchTh?.after(th);
    }
    const bets=state.bets||[];
    const groups=new Map();
    bets.forEach(b=>{
      const key=[String(b.marketId||""),String(b.outcomeIndex??""),String(b.outcome||"")].join("::");
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(b);
    });
    const ordered=[...groups.values()].map(fills=>fills.slice().sort((a,b)=>new Date(b.placedAt)-new Date(a.placedAt))).sort((a,b)=>new Date(b[0]?.placedAt)-new Date(a[0]?.placedAt));
    let groupIndex=0;
    for(const row of body.querySelectorAll("tr.history-group-row")){
      if(row.querySelector(".game-date-cell")) continue;
      const fills=ordered[groupIndex++]||[];
      const td=document.createElement("td");td.className="game-date-cell";td.textContent=gameDate(fills[0]?.matchStart);row.children[2]?.after(td);
      const groupId=row.querySelector(".group-toggle")?.dataset.group;
      if(groupId){
        const children=[...body.querySelectorAll(`[data-history-group="${groupId}"]`)];
        children.forEach((child,i)=>{if(child.querySelector(".game-date-cell"))return;const c=document.createElement("td");c.className="game-date-cell";c.textContent=gameDate(fills[i]?.matchStart);child.children[2]?.after(c);});
      }
    }
    const empty=body.querySelector("tr:not(.history-group-row):not(.history-child-row) td[colspan]");
    if(empty) empty.colSpan=10;
    table.style.minWidth="1040px";
  }

  function refreshEnhancements(){installChartTooltip();enhanceHistoryTable();enhanceMarketCards();}
  const observer=new MutationObserver(()=>refreshEnhancements());
  const history=document.getElementById("history");
  if(history) observer.observe(history,{childList:true,subtree:true});
  const marketsEl=document.getElementById("markets");
  if(marketsEl) observer.observe(marketsEl,{childList:true,subtree:true});
  refreshEnhancements();
})();
