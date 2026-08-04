// ── INSIGHTS ──────────────────────────────────────────────────
let insightsSubPage = 'accounts';
let ccMonitorDate = new Date();
let ccMonitorPmFilter = 'all';

function setInsightsSubPage(sub, el) {
  insightsSubPage = sub || 'accounts';
  const toggle = document.getElementById('insightsSubPageToggle');
  if (toggle) {
    toggle.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sub === insightsSubPage);
    });
  }

  const subAccounts = document.getElementById('insightsSubAccounts');
  const subExpense = document.getElementById('insightsSubExpense');

  if (subAccounts) subAccounts.style.display = (insightsSubPage === 'accounts' ? 'block' : 'none');
  if (subExpense) subExpense.style.display = (insightsSubPage === 'expense' ? 'block' : 'none');

  if (insightsSubPage === 'accounts') {
    renderAccountBalanceCards();
  } else if (insightsSubPage === 'expense') {
    renderInsightsAccountFilter();
    renderChartTab(insightsMode);
  }
}

function changeCCMonth(delta) {
  ccMonitorDate.setMonth(ccMonitorDate.getMonth() + delta);
  renderCCMonitor();
}

function onCCPmChange(val) {
  ccMonitorPmFilter = val;
  renderCCMonitor();
}

function renderInsightsAccountFilter() {
  const select = document.getElementById('insightsAccountFilter');
  if (!select) return;
  const pmList = Array.from(new Set(allPMs || []));
  let html = `<option value="all"${insightsAccountFilterVal === 'all' ? ' selected' : ''}>All Accounts</option>`;
  html += pmList.map(pm => `<option value="${esc(pm)}"${insightsAccountFilterVal === pm ? ' selected' : ''}>${esc(pm)}</option>`).join('');
  select.innerHTML = html;
}

function onInsightsAccountFilterChange(val) {
  insightsAccountFilterVal = val;
  wView = val;
  mView = val;
  yView = val;
  cView = val;
  renderChartTab(insightsMode);
}

function renderCCMonitor() {
  const container = document.getElementById('searchMonitorContainer');
  if (!container) return;

  const curY = ccMonitorDate.getFullYear();
  const curM = ccMonitorDate.getMonth() + 1; // 1-12
  const monthNameStr = new Date(curY, curM - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // 1. Get all available payment methods (from settings/history config)
  const pmList = Array.from(new Set(allPMs || []));

  const targetPms = (ccMonitorPmFilter === 'all')
    ? pmList.map(p => p.toLowerCase())
    : [ccMonitorPmFilter.toLowerCase()];

  function isMatchPM(pmVal) {
    if (!pmVal) return false;
    const low = String(pmVal).toLowerCase().trim();
    return targetPms.some(t => low.includes(t) || t.includes(low));
  }

  // 2. Fetch current month opex transactions (both expenses and incomes)
  const currentTxns = [];
  (HIST.opex || []).forEach((r, i) => {
    if (r.y === curY && r.m === (curM - 1) && isMatchPM(r.pm)) {
      const isInc = (r.inc || 0) > 0;
      currentTxns.push({
        source: 'hist-opex',
        idx: i,
        day: r.d,
        desc: r.tx || r.notes || (isInc ? 'Income' : 'Expense'),
        category: r.cat || (isInc ? 'Income' : 'Other'),
        pm: r.pm || '',
        amount: Number(isInc ? r.inc : r.exp) || 0,
        type: isInc ? 'income' : 'expense',
        row: r
      });
    }
  });

  const isCurrentCalMonth = (curY === new Date().getFullYear() && curM === (new Date().getMonth() + 1));
  (txHistory || []).forEach((r, i) => {
    if (isCurrentCalMonth && r.synced) return;
    if (!r.date) return;
    const parts = r.date.split('-');
    if (+parts[0] === curY && +parts[1] === curM && isMatchPM(r.pm)) {
      const isInc = r.type === 'income';
      currentTxns.push({
        source: 'local-opex',
        idx: i,
        day: parseInt(parts[2], 10),
        desc: r.tx || r.notes || (isInc ? 'Income' : 'Expense'),
        category: r.category || (isInc ? 'Income' : 'Other'),
        pm: r.pm || '',
        amount: Number(r.amount) || 0,
        type: r.type,
        row: r
      });
    }
  });

  // Previous month opex expenses and income total for comparison
  let prevY = curY;
  let prevM = curM - 1;
  if (prevM < 1) { prevM = 12; prevY--; }
  let prevTotal = 0;
  let prevIncomeTotal = 0;
  (HIST.opex || []).forEach(r => {
    if (r.y === prevY && r.m === (prevM - 1) && isMatchPM(r.pm)) {
      if ((r.exp || 0) > 0) prevTotal += Number(r.exp) || 0;
      if ((r.inc || 0) > 0) prevIncomeTotal += Number(r.inc) || 0;
    }
  });

  currentTxns.sort((a, b) => b.day - a.day || b.amount - a.amount);
  const currentTotalExpenses = currentTxns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const currentTotalIncome = currentTxns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const txCount = currentTxns.length;

  let compDiffHtml = '';
  if (prevTotal > 0) {
    const diffPct = Math.round(((currentTotalExpenses - prevTotal) / prevTotal) * 100);
    const sign = diffPct > 0 ? '+' : '';
    const color = diffPct > 0 ? 'var(--red)' : 'var(--accent)';
    compDiffHtml = `<span style="color:${color};font-weight:600">${sign}${diffPct}%</span> vs prev month`;
  } else {
    compDiffHtml = 'No prev month comparison';
  }

  let compIncomeDiffHtml = '';
  if (prevIncomeTotal > 0) {
    const diffPct = Math.round(((currentTotalIncome - prevIncomeTotal) / prevIncomeTotal) * 100);
    const sign = diffPct > 0 ? '+' : '';
    const color = diffPct > 0 ? 'var(--green)' : 'var(--red)';
    compIncomeDiffHtml = `<span style="color:${color};font-weight:600">${sign}${diffPct}%</span> vs prev month`;
  } else {
    compIncomeDiffHtml = 'No prev month comparison';
  }

  let html = `
    <!-- Header Controls -->
    <div class="chart-card" style="margin-bottom:12px;padding:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <button class="toggle-btn" style="flex:0 0 auto;padding:6px 12px;font-size:12px" onclick="changeCCMonth(-1)">‹ Prev</button>
        <div style="font-size:15px;font-weight:700;color:var(--text)">${monthNameStr}</div>
        <button class="toggle-btn" style="flex:0 0 auto;padding:6px 12px;font-size:12px" onclick="changeCCMonth(1)">Next ›</button>
      </div>

      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:12px;color:var(--text2);white-space:nowrap">Account Filter:</span>
        <select class="form-input" style="padding:6px 10px;font-size:12px;border-radius:var(--radius-sm)" onchange="onCCPmChange(this.value)">
          <option value="all"${ccMonitorPmFilter==='all'?' selected':''}>All Accounts</option>
          ${pmList.map(pm => `<option value="${esc(pm)}"${ccMonitorPmFilter===pm?' selected':''}>${esc(pm)}</option>`).join('')}
        </select>
      </div>
    </div>

    <!-- Summary Stats -->
    <div class="summary-row" style="grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
      <div class="summary-card">
        <div class="s-label">Total Expenses</div>
        <div class="s-value" style="color:var(--text);font-size:19px">${fRp(currentTotalExpenses)}</div>
        <div class="s-sub">${compDiffHtml}</div>
      </div>
      <div class="summary-card">
        <div class="s-label">Total Income</div>
        <div class="s-value" style="color:var(--green);font-size:19px">${fRp(currentTotalIncome)}</div>
        <div class="s-sub">${compIncomeDiffHtml}</div>
      </div>
    </div>

    <!-- Transaction List -->
    <div class="chart-card">
      <div class="chart-card-title">Transactions (${txCount})</div>
      ${currentTxns.length === 0 ? `
        <div style="text-align:center;padding:24px 0;color:var(--text2);font-size:13px">
          No transactions recorded for ${monthNameStr}
        </div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:0">
          ${currentTxns.map(item => {
            const t = item.row;
            const isInc = item.type === 'income';
            const catColor = CAT_COLORS[t.cat || t.category] || 'var(--text2)';
            const amountStr = (isInc ? '+' : '-') + fRpS(item.amount);
            const amountColor = isInc ? 'var(--green)' : 'var(--text)';
            const dispDate = monthNameStr.split(' ')[0] + ' ' + item.day;
            const tapAttrs = `data-idx="${item.idx}" data-source="${item.source}" data-type="opex" style="cursor:pointer"`;
            return `
              <div class="detail-item" style="padding:10px 0" ${tapAttrs}>
                <div style="flex:1;min-width:0;padding-right:8px">
                  <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                    ${esc(t.tx || t.desc || '')}
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                    <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg3);color:${catColor};font-weight:600">
                      ${esc(t.cat || t.category || '')}
                    </span>
                    <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg3);color:var(--text2)">
                      ${esc(t.pm || '')}
                    </span>
                    <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg3);color:var(--text2)">
                      ${dispDate}
                    </span>
                  </div>
                </div>
                <div style="font-size:14px;font-weight:700;color:${amountColor};white-space:nowrap">
                  ${amountStr}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;

  container.innerHTML = html;
}

function setIM(mode,el){
  insightsMode=mode;
  toggleActive('#insightsModeToggle .toggle-btn',el);
  const wCtrl=document.getElementById('weeklyControls');if(wCtrl)wCtrl.style.display=mode==='weekly'?'block':'none';
  const mCtrl=document.getElementById('monthlyControls');if(mCtrl)mCtrl.style.display=mode==='monthly'?'block':'none';
  const yCtrl=document.getElementById('yearlyControls');if(yCtrl)yCtrl.style.display=mode==='yearly'?'block':'none';
  const cCtrl=document.getElementById('categoryControls');if(cCtrl)cCtrl.style.display=mode==='category'?'block':'none';
  const wEls=['weeklySummary','weeklyBarCard','weeklyDonutCard'];
  const mEls=['monthlySummary','monthlyBarCard','monthlyDonutCard'];
  const yEls=['yearlySummary','yearlyBarCard','yearlyMonthCard','yearlyDonutCard'];
  const cEls=['catRankingCard','catTrendCard'];
  wEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=mode==='weekly'?'block':'none'});
  mEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=mode==='monthly'?'block':'none'});
  yEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=mode==='yearly'?'block':'none'});
  cEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=mode==='category'?'block':'none'});
  renderChartTab(mode);
}
function setWV(v,el){wView=v;wSelWeek=null;wSelCat=null;toggleActive('#weeklySourceToggle .toggle-btn',el);renderWeekly()}
function setWR(r,el){wRange=r;wSelWeek=null;wSelCat=null;toggleActive('#weeklyRangeToggle .toggle-btn',el);renderWeekly()}
function setMV(v,el){mView=v;mSelMonth=null;mSelCat=null;toggleActive('#monthlySourceToggle .toggle-btn',el);renderMonthly()}
function setMR(r,el){mRange=r;mSelMonth=null;mSelCat=null;toggleActive('#monthlyRangeToggle .toggle-btn',el);renderMonthly()}
function setYV(v,el){yView=v;ySelYear=null;ySelCat=null;toggleActive('#yearlySourceToggle .toggle-btn',el);renderYearly()}
function setYR(r,el){yRange=r;ySelYear=null;ySelCat=null;toggleActive('#yearlyRangeToggle .toggle-btn',el);renderYearly()}
function setCV(v,el){cView=v;cSelCat=null;toggleActive('#catSourceToggle .toggle-btn',el);renderCategory()}
function setCR(r,el){cRange=r;cSelCat=null;toggleActive('#catRangeToggle .toggle-btn',el);renderCategory()}

function renderChartTab(tab){
  if(tab==='weekly')renderWeekly();
  else if(tab==='monthly')renderMonthly();
  else if(tab==='yearly')renderYearly();
  else renderCategory();
}

function getMondayOfDate(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return date;
}
function formatWeekRange(mon, sun) {
  if (mon.getFullYear() === sun.getFullYear()) {
    if (mon.getMonth() === sun.getMonth()) {
      return `${mon.getDate()}-${sun.getDate()} ${MO[mon.getMonth()]} ${mon.getFullYear()}`;
    } else {
      return `${mon.getDate()} ${MO[mon.getMonth()]} - ${sun.getDate()} ${MO[sun.getMonth()]} ${mon.getFullYear()}`;
    }
  } else {
    return `${mon.getDate()} ${MO[mon.getMonth()]} ${mon.getFullYear()} - ${sun.getDate()} ${MO[sun.getMonth()]} ${sun.getFullYear()}`;
  }
}
function getShortWeekLabelFromKey(k) {
  return String(k || '').replace(/ \d{4}$/, '');
}
function getWeekKeyOfRow(r) {
  if (!r || !r.y || r.m === undefined || !r.d) return '';
  const date = new Date(r.y, r.m, r.d);
  const mon = getMondayOfDate(date);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return formatWeekRange(mon, sun);
}
function getWeeklyKeys() {
  const now = new Date();
  const curMon = getMondayOfDate(now);
  const keys = [];
  if (wRange === 'ytd') {
    const startMon = getMondayOfDate(new Date(now.getFullYear(), 0, 1));
    let iter = new Date(startMon);
    while (iter <= curMon) {
      const sun = new Date(iter.getFullYear(), iter.getMonth(), iter.getDate() + 6);
      keys.push(formatWeekRange(iter, sun));
      iter.setDate(iter.getDate() + 7);
    }
  } else {
    const n = parseInt(wRange) || 4;
    for (let i = n - 1; i >= 0; i--) {
      const mon = new Date(curMon.getFullYear(), curMon.getMonth(), curMon.getDate() - i * 7);
      const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      keys.push(formatWeekRange(mon, sun));
    }
  }
  return keys;
}

function renderWeekly(){
  const rows=getRows(wView),keys=getWeeklyKeys();
  const {totals,catMap,rawRows}=aggregateExpenses(rows,keys,getWeekKeyOfRow);
  const selKey=wSelWeek||keys[keys.length-1];
  if(!wSelWeek)wSelWeek=selKey;
  const maxT=Math.max(...keys.map(k=>totals[k]),1);
  const curTotal=totals[selKey]||0;
  const prevKey=keys[keys.indexOf(selKey)-1];
  const prevTotal=prevKey?totals[prevKey]:0;
  const avgTotal=keys.slice(0,-1).reduce((s,k)=>s+(totals[k]||0),0)/Math.max(keys.length-1,1);
  const trend=prevTotal>0?((curTotal-prevTotal)/prevTotal*100):null;
  const trendStr=trend!==null?`${trend>0?'+':''}${trend.toFixed(0)}%`:'—';
  const trendColor=trend===null?'var(--text2)':trend>0?'var(--red)':'var(--accent)';

  const sumEl=document.getElementById('weeklySummary');
  if(sumEl)sumEl.innerHTML=`
    <div class="summary-row">
      <div class="summary-card"><div class="s-label">${selKey}</div><div class="s-value" style="font-size:15px">${'Rp'+Math.round(curTotal).toLocaleString('id-ID')}</div><div class="s-sub">${wView === 'all' ? 'All Accounts' : wView}</div></div>
      <div class="summary-card"><div class="s-label">vs Last Week</div><div class="s-value" style="color:${trendColor}">${trendStr}</div><div class="s-sub">Avg ${fRpS(Math.round(avgTotal))}/wk</div></div>
    </div>`;

  const barCols=keys.map(k=>{
    const t=totals[k]||0;
    const shortLabel=getShortWeekLabelFromKey(k);
    return barColHTML({
      label:shortLabel,
      amount:t>0?fRpS(t):'',
      pct:maxT>0?(t/maxT*100):0,
      selected:k===selKey?'selected':'',
      onclick:`selectWeek('${escJsAttr(k)}')`
    });
  }).join('');
  const barEl=document.getElementById('weeklyBarCard');
  if(barEl)barEl.innerHTML=`<div class="chart-card"><div class="chart-card-title">Weekly Total — tap week for breakdown</div><div class="bar-chart-wrap"><div class="bar-chart">${barCols}</div></div></div>`;

  const catData=catMap[selKey]||{},total=Object.values(catData).reduce((a,b)=>a+b,0),selRows=rawRows[selKey]||{};
  const sorted=Object.entries(catData).sort((a,b)=>b[1]-a[1]);
  if(!wSelCat||!catData[wSelCat])wSelCat=sorted.length?sorted[0][0]:null;
  const donutEl=document.getElementById('weeklyDonutCard');
  if(donutEl){
    if(total>0){
      const legendHTML=legendRowsHTML(sorted,total,wSelCat,'selectWeeklyCat');
      let detailHTML='';
      if(wSelCat&&selRows[wSelCat]){
        const color=CAT_COLORS[wSelCat]||CAT_COLORS['Other'];
        const txList=[...selRows[wSelCat]].sort((a,b)=>(b.exp||0)-(a.exp||0));
        detailHTML=detailSectionHTML(`${esc(wSelCat)} · ${fRp(catData[wSelCat])}`,color,txList,r=>`${r.d} ${MO[r.m]}`);
      }
      donutEl.innerHTML=`<div class="chart-card">
        <div class="chart-card-title">Breakdown ${selKey} — tap category for transactions</div>
        <div class="donut-wrap"><div>${buildDonut(catData,100)}</div><div class="donut-legend">${legendHTML}</div></div>
        ${detailHTML}</div>`;
    } else {
      donutEl.innerHTML=`<div class="chart-card"><div class="chart-card-title">Breakdown ${selKey}</div><div class="empty-state" style="padding:20px">No data</div></div>`;
    }
  }
}
function selectWeek(k){wSelWeek=k;wSelCat=null;renderWeekly()}
function selectWeeklyCat(cat){wSelCat=cat;renderWeekly()}

function getMonthlyKeys(){
  const now=new Date();
  if(mRange==='ytd'){const k=[];for(let m=0;m<=now.getMonth();m++)k.push(`${MO[m]} ${now.getFullYear()}`);return k}
  const n=parseInt(mRange),k=[];
  for(let i=n-1;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);k.push(`${MO[d.getMonth()]} ${d.getFullYear()}`)}
  return k;
}
function getYearlyKeys(){
  const rows=getRows(yView),nowY=new Date().getFullYear();
  if(yRange==='all'){const ys=[...new Set(rows.map(r=>r.y).filter(Boolean))].sort();return ys.length?ys:[nowY]}
  const n=parseInt(yRange),ys=[];for(let i=n-1;i>=0;i--)ys.push(nowY-i);return ys;
}
function getCatKeys(){
  const now=new Date();
  if(cRange==='ytd'){const k=[];for(let m=0;m<=now.getMonth();m++)k.push(`${MO[m]} ${now.getFullYear()}`);return k}
  const n=parseInt(cRange),k=[];
  for(let i=n-1;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);k.push(`${MO[d.getMonth()]} ${d.getFullYear()}`)}
  return k;
}

// ── Shared insights chart builders ────────────────────────────
// Aggregate expense rows into {totals, catMap, rawRows} keyed by keyFn(row);
// rows whose key is not in `keys` are ignored
function aggregateExpenses(rows,keys,keyFn){
  const totals={},catMap={},rawRows={};
  keys.forEach(k=>{totals[k]=0;catMap[k]={};rawRows[k]={}});
  rows.forEach(r=>{
    const k=keyFn(r);
    if(totals[k]===undefined)return;
    const amt=r.exp||0;
    totals[k]+=amt;
    catMap[k][r.cat]=(catMap[k][r.cat]||0)+amt;
    if(!rawRows[k][r.cat])rawRows[k][r.cat]=[];
    rawRows[k][r.cat].push(r);
  });
  return {totals,catMap,rawRows};
}
// One column of a bar chart; fillStyle is appended after the height rule (e.g. ';opacity:0.7')
function barColHTML({label,amount,pct,selected='',onclick='',fillStyle=''}){
  return`<div class="bar-col ${selected}"${onclick?` onclick="${onclick}"`:''}>
    <div class="bar-amount">${amount}</div>
    <div class="bar-fill" style="height:${Math.max(pct,2)}%${fillStyle}"></div>
    <div class="bar-label">${label}</div>
  </div>`;
}
// Donut legend rows; clickFnName is a global function that receives the category name
function legendRowsHTML(sorted,total,activeCat,clickFnName){
  return sorted.map(([cat,val])=>{
    const color=CAT_COLORS[cat]||CAT_COLORS['Other'],pct=((val/total)*100).toFixed(0);
    return`<div class="legend-row${activeCat===cat?' active':''}" onclick="${clickFnName}('${escJsAttr(cat)}')">
      <div class="legend-dot" style="background:${color}"></div>
      <div class="legend-name">${esc(cat)}</div>
      <div class="legend-pct">${pct}%</div>
      <div class="legend-amt">${fRpS(val)}</div>
    </div>`;
  }).join('');
}
// Transaction list under a chart; dateFn renders the per-row date label (pre-escaped)
function detailSectionHTML(title,color,txList,dateFn){
  return`<div class="detail-section">
    <div class="detail-title"><div class="detail-title-dot" style="background:${color}"></div>${title}</div>
    ${txList.map(r=>`<div class="detail-item">
      <div class="detail-name">${esc(r.tx||'')}</div>
      <div class="detail-date">${dateFn(r)}</div>
      <div class="detail-amt">${fRp(r.exp||0)}</div>
    </div>`).join('')}
  </div>`;
}

function renderMonthly(){
  const rows=getRows(mView),keys=getMonthlyKeys();
  const {totals,catMap,rawRows}=aggregateExpenses(rows,keys,r=>r.mk);
  const selKey=mSelMonth||keys[keys.length-1];
  if(!mSelMonth)mSelMonth=selKey;
  const maxT=Math.max(...keys.map(k=>totals[k]),1);
  const curTotal=totals[selKey]||0;
  const prevKey=keys[keys.indexOf(selKey)-1];
  const prevTotal=prevKey?totals[prevKey]:0;
  const avgTotal=keys.slice(0,-1).reduce((s,k)=>s+(totals[k]||0),0)/Math.max(keys.length-1,1);
  const trend=prevTotal>0?((curTotal-prevTotal)/prevTotal*100):null;
  const trendStr=trend!==null?`${trend>0?'+':''}${trend.toFixed(0)}%`:'—';
  const trendColor=trend===null?'var(--text2)':trend>0?'var(--red)':'var(--accent)';

  document.getElementById('monthlySummary').innerHTML=`
    <div class="summary-row">
      <div class="summary-card"><div class="s-label">${selKey}</div><div class="s-value" style="font-size:15px">${'Rp'+Math.round(curTotal).toLocaleString('id-ID')}</div><div class="s-sub">${mView === 'all' ? 'All Accounts' : mView}</div></div>
      <div class="summary-card"><div class="s-label">vs Last Month</div><div class="s-value" style="color:${trendColor}">${trendStr}</div><div class="s-sub">Avg ${fRpS(Math.round(avgTotal))}/mo</div></div>
    </div>`;

  const barCols=keys.map(k=>{
    const t=totals[k]||0;
    return barColHTML({
      label:k.split(' ')[0],
      amount:t>0?fRpS(t):'',
      pct:maxT>0?(t/maxT*100):0,
      selected:k===selKey?'selected':'',
      onclick:`selectMonth('${escJsAttr(k)}')`
    });
  }).join('');
  document.getElementById('monthlyBarCard').innerHTML=`<div class="chart-card"><div class="chart-card-title">Monthly Total — tap month for breakdown</div><div class="bar-chart-wrap"><div class="bar-chart">${barCols}</div></div></div>`;

  const catData=catMap[selKey]||{},total=Object.values(catData).reduce((a,b)=>a+b,0),selRows=rawRows[selKey]||{};
  const sorted=Object.entries(catData).sort((a,b)=>b[1]-a[1]);
  if(!mSelCat||!catData[mSelCat])mSelCat=sorted.length?sorted[0][0]:null;
  if(total>0){
    const legendHTML=legendRowsHTML(sorted,total,mSelCat,'selectMonthlyCat');
    let detailHTML='';
    if(mSelCat&&selRows[mSelCat]){
      const color=CAT_COLORS[mSelCat]||CAT_COLORS['Other'];
      const txList=[...selRows[mSelCat]].sort((a,b)=>(b.exp||0)-(a.exp||0));
      detailHTML=detailSectionHTML(`${esc(mSelCat)} · ${fRp(catData[mSelCat])}`,color,txList,r=>`${r.d} ${MO[r.m]}`);
    }
    document.getElementById('monthlyDonutCard').innerHTML=`<div class="chart-card">
      <div class="chart-card-title">Breakdown ${selKey} — tap category for transactions</div>
      <div class="donut-wrap"><div>${buildDonut(catData,100)}</div><div class="donut-legend">${legendHTML}</div></div>
      ${detailHTML}</div>`;
  } else {
    document.getElementById('monthlyDonutCard').innerHTML=`<div class="chart-card"><div class="chart-card-title">Breakdown ${selKey}</div><div class="empty-state" style="padding:20px">No data</div></div>`;
  }
}
function selectMonth(k){mSelMonth=k;mSelCat=null;renderMonthly()}
function selectMonthlyCat(cat){mSelCat=cat;renderMonthly()}

function renderYearly(){
  const rows=getRows(yView),years=getYearlyKeys();
  const {totals,catMap:cats,rawRows:rawCats}=aggregateExpenses(rows,years,r=>r.y);
  // Per-month breakdown within each year (not covered by aggregateExpenses)
  const monthBreak={};
  years.forEach(y=>monthBreak[y]={});
  rows.forEach(r=>{
    if(monthBreak[r.y]===undefined)return;
    monthBreak[r.y][r.mk]=(monthBreak[r.y][r.mk]||0)+(r.exp||0);
  });
  const selY=ySelYear||years[years.length-1];
  if(!ySelYear)ySelYear=selY;
  const maxT=Math.max(...years.map(y=>totals[y]||0),1);
  const curTotal=totals[selY]||0;
  const prevY=years[years.indexOf(selY)-1];
  const prevTotal=prevY?totals[prevY]:0;
  const trend=prevTotal>0?((curTotal-prevTotal)/prevTotal*100):null;
  const trendStr=trend!==null?`${trend>0?'+':''}${trend.toFixed(0)}%`:'—';
  const trendColor=trend===null?'var(--text2)':trend>0?'var(--red)':'var(--accent)';

  document.getElementById('yearlySummary').innerHTML=`
    <div class="summary-row">
      <div class="summary-card"><div class="s-label">${selY}</div><div class="s-value">${fRpS(curTotal)}</div><div class="s-sub">${yView === 'all' ? 'All Accounts' : yView}</div></div>
      <div class="summary-card"><div class="s-label">vs Last Year</div><div class="s-value" style="color:${trendColor}">${trendStr}</div><div class="s-sub">Prev: ${fRpS(prevTotal)}</div></div>
    </div>`;

  const barCols=years.map(y=>{
    const t=totals[y]||0;
    return barColHTML({
      label:y,
      amount:fRpS(t),
      pct:maxT>0?(t/maxT*100):0,
      selected:y===selY?'selected':'',
      onclick:`selectYear(${y})`
    });
  }).join('');
  document.getElementById('yearlyBarCard').innerHTML=`<div class="chart-card"><div class="chart-card-title">Yearly Total — tap year for detail</div><div class="bar-chart-wrap"><div class="bar-chart">${barCols}</div></div></div>`;

  const mbData=monthBreak[selY]||{},mbKeys=MO.map(m=>`${m} ${selY}`);
  const mbMax=Math.max(...mbKeys.map(k=>mbData[k]||0),1);
  const mbCols=mbKeys.map(k=>{
    const t=mbData[k]||0;
    return barColHTML({
      label:k.split(' ')[0],
      amount:t>0?fRpS(t):'',
      pct:mbMax>0?(t/mbMax*100):0,
      fillStyle:';opacity:0.7'
    });
  }).join('');
  document.getElementById('yearlyMonthCard').innerHTML=`<div class="chart-card"><div class="chart-card-title">Monthly Breakdown ${selY}</div><div class="bar-chart-wrap"><div class="bar-chart">${mbCols}</div></div></div>`;

  const catData=cats[selY]||{},catTotal=Object.values(catData).reduce((a,b)=>a+b,0);
  const sorted=Object.entries(catData).sort((a,b)=>b[1]-a[1]);
  if(!ySelCat||!catData[ySelCat])ySelCat=sorted.length?sorted[0][0]:null;
  if(catTotal>0){
    const legendHTML=legendRowsHTML(sorted,catTotal,ySelCat,'selectYearlyCat');
    let detailHTML='';
    if(ySelCat&&rawCats[selY][ySelCat]){
      const color=CAT_COLORS[ySelCat]||CAT_COLORS['Other'];
      const txList=[...rawCats[selY][ySelCat]].sort((a,b)=>(b.exp||0)-(a.exp||0));
      detailHTML=detailSectionHTML(`${esc(ySelCat)} ${selY} · ${fRp(catData[ySelCat])}`,color,txList,r=>esc(r.mk));
    }
    document.getElementById('yearlyDonutCard').innerHTML=`<div class="chart-card">
      <div class="chart-card-title">Category Breakdown ${selY} — tap for transactions</div>
      <div class="donut-wrap"><div>${buildDonut(catData,100)}</div><div class="donut-legend">${legendHTML}</div></div>
      ${detailHTML}</div>`;
  } else document.getElementById('yearlyDonutCard').innerHTML='';
}
function selectYear(y){ySelYear=y;ySelCat=null;renderYearly()}
function selectYearlyCat(cat){ySelCat=cat;renderYearly()}

function renderCategory(){
  const rows=getRows(cView),keys=getCatKeys();
  const catTotals={},catMonthly={},catRaw={};
  rows.forEach(r=>{
    if(!keys.includes(r.mk))return;
    const cat=r.cat||'Other',amt=r.exp||0;
    catTotals[cat]=(catTotals[cat]||0)+amt;
    if(!catMonthly[cat])catMonthly[cat]={};
    catMonthly[cat][r.mk]=(catMonthly[cat][r.mk]||0)+amt;
    if(!catRaw[cat])catRaw[cat]=[];
    catRaw[cat].push(r);
  });
  const sorted=Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
  const maxCat=sorted.length?sorted[0][1]:1;
  if(!cSelCat&&sorted.length)cSelCat=sorted[0][0];

  const CAT_SHORT={'Administration':'Admin','Entertainment':'Entertain.','Self Care':'Self Care'};
  let pillHTML='<div class="pill-grid">';
  sorted.forEach(([cat,total])=>{
    const color=CAT_COLORS[cat]||CAT_COLORS['Other'];
    const barW=maxCat>0?((total/maxCat)*100).toFixed(0):0;
    const isActive=cSelCat===cat;
    const displayName=CAT_SHORT[cat]||cat;
    pillHTML+=`<div class="cat-pill${isActive?' active':''}" onclick="selectCat('${escJsAttr(cat)}')">
      <div class="cat-pill-bar" style="width:${barW}%;background:${color}"></div>
      <div class="cat-pill-name">${esc(displayName)}</div>
      <div class="cat-pill-amt">${fRpS(total)}</div>
    </div>`;
  });
  pillHTML+='</div>';
  document.getElementById('catRankingCard').innerHTML=pillHTML;

  if(cSelCat&&catMonthly[cSelCat]){
    const color=CAT_COLORS[cSelCat]||CAT_COLORS['Other'];
    const mData=catMonthly[cSelCat];
    const mMax=Math.max(...keys.map(k=>mData[k]||0),1);
    const avg=keys.reduce((s,k)=>s+(mData[k]||0),0)/keys.length;
    const txList=(catRaw[cSelCat]||[]).sort((a,b)=>(b.exp||0)-(a.exp||0)).slice(0,10);
    const barCols=keys.map(k=>{
      const t=mData[k]||0;
      return barColHTML({
        label:k.split(' ')[0],
        amount:t>0?fRpS(t):'',
        pct:mMax>0?(t/mMax*100):0,
        fillStyle:`;background:${color};border-color:${color}`
      });
    }).join('');
    document.getElementById('catTrendCard').innerHTML=`<div class="cat-trend-card">
      <div class="cat-trend-header">
        <div class="cat-trend-dot" style="background:${color}"></div>
        <span style="color:var(--text);font-size:13px;font-weight:600">${esc(cSelCat)}</span>
        <span style="color:var(--text2);font-size:12px"> · avg ${fRpS(Math.round(avg))}/mo · total ${fRpS(catTotals[cSelCat])}</span>
      </div>
      <div class="bar-chart-wrap"><div class="bar-chart">${barCols}</div></div>
      ${txList.length?detailSectionHTML('Top transactions',color,txList,r=>esc(r.mk)):''}
    </div>`;
  } else document.getElementById('catTrendCard').innerHTML='';
}
function selectCat(cat){cSelCat=cat;renderCategory()}

function buildDonut(data,size){
  const total=Object.values(data).reduce((a,b)=>a+b,0);
  if(!total)return'';
  const sorted=Object.entries(data).sort((a,b)=>b[1]-a[1]);
  const r=size/2-10,cx=size/2,cy=size/2,circ=2*Math.PI*r;
  let offset=0,paths='';
  sorted.forEach(([cat,val])=>{
    const pct=val/total,dash=pct*circ,color=CAT_COLORS[cat]||CAT_COLORS['Other'];
    paths+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="13" stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset+=dash;
  });
  return`<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg3)" stroke-width="13"/>
    ${paths}
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="var(--text)" font-size="10" font-weight="700">${fRpS(total)}</text>
  </svg>`;
}

// ── NET WORTH ─────────────────────────────────────────────────
function setNWMode(mode,el){
  nwMode=mode;
  toggleActive('.nw-mode-btn',el);
  if(!histLoaded) onHistLoaded(()=>renderNetWorth());
  else renderNetWorth();
}
function initNetWorth() {
  const render = () => Promise.all([fetchSheetPrices(false), fetchLiveInvest(), fetchAccountBalances()]).then(() => renderNetWorth());
  if (!histLoaded) onHistLoaded(render);
  else render();
}

async function fetchFxRates(){
  const now=Date.now();
  if(fxRates.USD && (now-fxLastFetch)<3600000)return; 
  try {
    const res=await fetch('https://api.frankfurter.app/latest?from=USD,CHF&to=IDR');
    const j=await res.json();
    fxRates.USD = j.rates?.USD?.IDR || j.rates?.IDR;
    const [usdRes, chfRes] = await Promise.all([
      fetch('https://api.frankfurter.app/latest?from=USD&to=IDR'),
      fetch('https://api.frankfurter.app/latest?from=CHF&to=IDR'),
    ]);
    const usdJ = await usdRes.json();
    const chfJ = await chfRes.json();
    fxRates.USD = usdJ.rates?.IDR;
    fxRates.CHF = chfJ.rates?.IDR;
    fxLastFetch = now;
    localStorage.setItem('notapub_fx', JSON.stringify(fxRates));
    localStorage.setItem('notapub_fx_ts', String(now));
  } catch(e){
    fxRates.USD = fxRates.USD || 16500;
    fxRates.CHF = fxRates.CHF || 19000;
  }
}

function computeCashBalance() {
  const base = HIST.cashBalance || 0;
  const cutoff = HIST.cashBalanceAsOf || null; // e.g. '2026-06-01'
  if (!cutoff) return base;
  let delta = 0;
  (txHistory || []).forEach(r => {
    if (!r.date || r.date <= cutoff) return;
    if (r.type === 'income')  delta += (r.amount || 0);
    else if (r.type === 'expense') delta -= (r.amount || 0);
  });
  (investHistory || []).forEach(r => {
    if (!r.date || r.date <= cutoff) return;
    const fromUsdAcct = r.account && ACCOUNT_CCY[r.account] === 'USD';
    if (!fromUsdAcct) {
      if (r.action === 'Buy')  delta -= (r.totalIdr || 0);
      else if (r.action === 'Sell') delta += (r.totalIdr || 0);
    }
  });
  (liveInvest || []).forEach(r => {
    if (!r.date || r.date <= cutoff) return;
    const fromUsdAcct = r.account && ACCOUNT_CCY[r.account] === 'USD';
    if (!fromUsdAcct) {
      if (r.action === 'Buy')  delta -= (r.totalIdr || 0);
      else if (r.action === 'Sell') delta += (r.totalIdr || 0);
    }
  });
  return base + delta;
}

// Shared buy/sell aggregation for every Invest row, keyed by stock. A stock that is
// also registered as a USD-currency Account (e.g. "USDIDR Pluang Febri" funding QQQ
// buys) gets its balance depleted by whatever was spent buying OTHER assets through
// it — otherwise that money would look like it's still sitting in the FX pool when
// it's actually been converted into stock. Used by both renderNetWorth() and
// getGoalCurrentValue() so neither drifts out of sync with the other.
function computeInvestNetLots(allInvest) {
  const buyLots={}, sellLots={}, buyTotalIdr={}, buyPriceWeighted={};
  allInvest.forEach(r=>{
    const s=r.stock;
    if(!(s in buyLots)){buyLots[s]=0;sellLots[s]=0;buyTotalIdr[s]=0;buyPriceWeighted[s]=0;}
    if(r.action==='Buy'){
      buyLots[s]  += r.lot;
      buyTotalIdr[s] += r.totalIdr||0;
      buyPriceWeighted[s] += (r.price||0) * r.lot;
    } else {
      sellLots[s] += r.lot;
    }
  });

  const forexStockKeys = Object.keys(buyLots).filter(s => {
    const cfg = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === s.toLowerCase());
    return getAssetTypeForItem(s, cfg?.assetType || STOCK_TYPE[s], false) === 'Forex';
  });

  allInvest.forEach(r => {
    if (r.action !== 'Buy') return;
    if (!r.account) return;
    const fxSpent = (r.lot || 0) * (r.price || 0);
    if (fxSpent <= 0) return;

    const acctCcy = (ACCOUNT_CCY[r.account] || '').toUpperCase();
    // Direct match: the Invest sheet's Account text names a Config account verbatim.
    let targetKey = (acctCcy && acctCcy !== 'IDR') ? r.account : null;
    // Fallback: no Config account is named exactly this (e.g. Invest says "Pluang USD"
    // but Config's account row is just "Pluang") — fuzzy-match it against known forex
    // holdings instead of silently dropping the depletion.
    if (!targetKey) {
      targetKey = forexStockKeys.find(s => isFxAccountMatch(r.account, ACCOUNT_CCY[s] || 'USD', s));
    }
    if (!targetKey) return;

    if (!(targetKey in sellLots)) { buyLots[targetKey] = buyLots[targetKey] || 0; sellLots[targetKey] = 0; }
    sellLots[targetKey] += fxSpent;
  });

  return { buyLots, sellLots, buyTotalIdr, buyPriceWeighted };
}

async function renderNetWorth(){
  await fetchFxRates();
  const manualUSD = parsePrice(stockPrices['USDIDR']);
  const manualCHF = parsePrice(stockPrices['CHFIDR']);
  const usdRate = manualUSD > 0 ? manualUSD : (fxRates.USD || 16500);
  const chfRate = manualCHF > 0 ? manualCHF : (fxRates.CHF || 19000);

  const navStar = parsePrice(stockPrices['StarStable']);
  const priceQQQ  = parsePrice(stockPrices['QQQ']);
  const priceJNJ  = parsePrice(stockPrices['JNJ']);
  const priceVYM  = parsePrice(stockPrices['VYM']);
  const priceAAPL = parsePrice(stockPrices['AAPL']);

  const allInvest = getAllInvestRows();
  const { buyLots, sellLots, buyTotalIdr, buyPriceWeighted } = computeInvestNetLots(allInvest);

  const holdings = Object.keys(buyLots).map(stock=>{
    const netLot = buyLots[stock] - (sellLots[stock]||0);
    if(netLot <= 0) return null;
    const stockConfig = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === stock.toLowerCase());
    let type = getAssetTypeForItem(stock, stockConfig?.assetType || STOCK_TYPE[stock], false);
    const buyRatio = buyLots[stock] > 0 ? netLot / buyLots[stock] : 0;
    const costBasis = buyTotalIdr[stock] * buyRatio;
    const avgCostPerUnit = buyLots[stock] > 0 ? buyTotalIdr[stock] / buyLots[stock] : 0;
    // avgNativePrice uses r.price×r.lot (native currency) — accurate for USD stocks too
    const avgNativePrice = buyLots[stock] > 0 ? buyPriceWeighted[stock] / buyLots[stock] : 0;

    let currentValue = 0;
    if (stock==='Star Stable Income Fund') currentValue = navStar > 0 ? netLot * navStar : 0;
    else if (stock.startsWith('USDIDR')) currentValue = netLot * usdRate;
    else if (stock==='CHFIDR') currentValue = netLot * chfRate;
    else if (stock==='QQQ')  currentValue = priceQQQ  > 0 ? netLot * priceQQQ  * usdRate : 0;
    else if (stock==='JNJ')  currentValue = priceJNJ  > 0 ? netLot * priceJNJ  * usdRate : 0;
    else if (stock==='VYM')  currentValue = priceVYM  > 0 ? netLot * priceVYM  * usdRate : 0;
    else if (stock==='AAPL') currentValue = priceAAPL > 0 ? netLot * priceAAPL * usdRate : 0;
    else if (parsePrice(stockPrices[stock]) > 0) {
      currentValue = netLot * parsePrice(stockPrices[stock]) * (type === 'US Stock' ? usdRate : 1);
    } else {
      currentValue = costBasis;
    }

    return {stock, type, netLot, costBasis, currentValue, avgCostPerUnit, avgNativePrice};
  }).filter(Boolean);

  // Also include stock items from CONFIG_ITEMS that have a balance/value configured but no Invest sheet transactions
  const stockConfigItems = CONFIG_ITEMS.filter(i => i.kind === 'stock' && !i.archived);
  stockConfigItems.forEach(sItem => {
    const hasInvestLots = buyLots[sItem.name] && (buyLots[sItem.name] - (sellLots[sItem.name] || 0)) > 0;
    if (hasInvestLots) return;

    let rawBal = sItem.balance;
    if (rawBal == null && rawAccountBalances[sItem.name]) {
      rawBal = rawAccountBalances[sItem.name].amount;
    }
    const balNum = parseConfigBalance(rawBal);
    if (balNum !== null && balNum > 0) {
      let type = getAssetTypeForItem(sItem.name, sItem.assetType || STOCK_TYPE[sItem.name], false);

      holdings.push({
        stock: sItem.name,
        type,
        netLot: 1,
        costBasis: balNum,
        currentValue: balNum,
        avgCostPerUnit: balNum,
        avgNativePrice: balNum
      });
    }
  });

  const cashBal = computeCashBalance();
  buildAccountBalances();

  if(nwMode==='holdings'){
    renderHoldings(holdings, usdRate, chfRate, accountBalances);
  } else {
    renderOverview(holdings, usdRate, chfRate, cashBal, accountBalances);
  }
}

function getAssetTypeForItem(name, explicitType, isAccount) {
  const sName = (name || '').trim();
  const sUpper = sName.toUpperCase();
  if (sUpper.includes('JHT')) return 'JHT';

  const cfg = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === sName.toLowerCase());

  let t = (explicitType || cfg?.assetType || STOCK_TYPE[sName] || '').trim();
  if (t && t !== 'Other') return t;

  const ccy = (ACCOUNT_CCY[sName] || cfg?.ccy || '').toUpperCase();

  if (
    sName.startsWith('USDIDR') ||
    sName.startsWith('CHFIDR') ||
    sName.startsWith('EURIDR') ||
    sName.startsWith('SGDIDR') ||
    sUpper.includes('USD') ||
    sUpper.includes('CHF') ||
    sUpper.includes('EUR') ||
    sUpper.includes('SGD') ||
    sUpper.includes('FOREX') ||
    (ccy && ccy !== 'IDR')
  ) {
    return 'Forex';
  }

  if (
    sName === 'Star Stable Income Fund' ||
    sUpper.includes('REKSA DANA') ||
    sUpper.includes('MUTUAL FUND') ||
    sUpper.includes('INCOME FUND')
  ) {
    return 'Reksa Dana';
  }

  if (isAccount || cfg?.kind === 'account') {
    return 'Cash';
  }

  return 'US Stock';
}

function getTypeColor(type) {
  const DYNAMIC_TYPE_COLORS = {
    'US Stock': '#5b8ef0',
    'Cash': '#888780',
    'Reksa Dana': '#4ade80',
    'Forex': '#f59e0b',
    'JHT': '#a855f7',
    'Deposit': '#06b6d4',
    'Gold': '#eab308',
    'Crypto': '#ec4899',
    'Bonds': '#14b8a6'
  };
  if (DYNAMIC_TYPE_COLORS[type]) return DYNAMIC_TYPE_COLORS[type];
  const FALLBACK_PALETTE = ['#f43f5e', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#3b82f6'];
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = type.charCodeAt(i) + ((hash << 5) - hash);
  return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length];
}

function getHoldingTheme(type) {
  const color = getTypeColor(type);
  return { color, bg: `${color}25` };
}

function isFxAccountMatch(acctName, ccy, stockName) {
  const aName = (acctName || '').trim();
  const sName = (stockName || '').trim();
  if (!aName || !sName) return false;

  const aLower = aName.toLowerCase();
  const sLower = sName.toLowerCase();

  // 1. Exact match (case-insensitive)
  if (aLower === sLower) return true;

  // 2. Normalized token match (e.g., "USD CIMB" <-> "USDIDR CIMB") — only applies to
  // foreign-currency accounts. A plain IDR cash account (ccy IDR/blank) is never an
  // FX-holding's funding account, so it must not be matched here even if stripping
  // the trailing "IDR" token happens to collide with another instrument's name.
  const ccyUpper = (ccy || '').toUpperCase();
  if (ccyUpper && ccyUpper !== 'IDR') {
    const normA = aLower.replace(/^(usdidr|chfidr|euridr|sgdidr|idr|usd|chf|eur|sgd)\s+/i, '')
                        .replace(/\s+(usdidr|chfidr|euridr|sgdidr|idr|usd|chf|eur|sgd)$/i, '')
                        .replace(/\s+/g, ' ').trim();

    const normS = sLower.replace(/^(usdidr|chfidr|euridr|sgdidr|idr|usd|chf|eur|sgd)\s+/i, '')
                        .replace(/\s+(usdidr|chfidr|euridr|sgdidr|idr|usd|chf|eur|sgd)$/i, '')
                        .replace(/\s+/g, ' ').trim();

    if (normA && normS && normA === normS) {
      return true;
    }
  }

  // 3. Match generic FX pair names like "USDIDR" / "CHFIDR" with currency accounts
  if ((sLower === 'usdidr' || sLower === 'chfidr') && (ccy === 'USD' || ccy === 'CHF' || aLower.includes(ccy?.toLowerCase() || ''))) {
    return true;
  }

  return false;
}

function getNetWorthAllocations(holdings, activeAccounts, acctBals, rawAccountBalances) {
  acctBals = acctBals || {};
  rawAccountBalances = rawAccountBalances || {};
  const groups = {};

  // 1. Investment holdings grouped by assetType allocation (processed FIRST to preserve rich lot/cost details)
  holdings.forEach(h => {
    const cfg = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === h.stock.toLowerCase());
    const t = getAssetTypeForItem(h.stock, cfg?.assetType || h.type, false);
    if (!groups[t]) groups[t] = { type: t, cost: 0, value: 0, items: [] };
    groups[t].cost += h.costBasis;
    groups[t].value += h.currentValue;
    groups[t].items.push({
      itemKind: 'stock',
      name: h.stock,
      holding: h,
      costBasis: h.costBasis,
      currentValue: h.currentValue
    });
  });

  // 2. Active Accounts grouped by assetType allocation (deduplicating items already represented in holdings)
  activeAccounts.forEach(acct => {
    const balObj = acctBals[acct.name];
    const amt = Number(balObj?.amount) || 0;
    if (amt <= 0) return;

    // Deduplicate: Skip account if it is already represented by an investment/FX holding
    const isAlreadyInHoldings = holdings.some(h => isFxAccountMatch(acct.name, acct.ccy, h.stock));
    if (isAlreadyInHoldings) return;

    const t = getAssetTypeForItem(acct.name, acct.assetType, true);
    if (!groups[t]) groups[t] = { type: t, cost: 0, value: 0, items: [] };
    groups[t].cost += amt;
    groups[t].value += amt;
    groups[t].items.push({
      itemKind: 'account',
      name: acct.name,
      acct,
      bal: amt,
      balObj,
      costBasis: amt,
      currentValue: amt,
      ccy: acct.ccy || 'IDR'
    });
  });

  // 3. Fallback rawAccountBalances grouped by assetType allocation
  Object.keys(rawAccountBalances).forEach(k => {
    const rawObj = rawAccountBalances[k];
    const amt = Number(rawObj?.amount) || 0;
    if (amt <= 0) return;

    const kSorted = k.toLowerCase().split(/\s+/).sort().join(' ');

    const inAccts = activeAccounts.some(a => {
      const aLower = a.name.toLowerCase();
      const aSorted = aLower.split(/\s+/).sort().join(' ');
      return aLower === k.toLowerCase() || aSorted === kSorted;
    });

    const kCfg = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === k.toLowerCase());
    const inHoldings = holdings.some(h => isFxAccountMatch(k, kCfg?.ccy || ACCOUNT_CCY[k], h.stock));

    const isConfiguredOrArchived = CONFIG_ITEMS.some(i => {
      const iLower = (i.name || '').toLowerCase();
      const iSorted = iLower.split(/\s+/).sort().join(' ');
      return iLower === k.toLowerCase() || iSorted === kSorted;
    });

    if (!inAccts && !inHoldings && !isConfiguredOrArchived) {
      const cfg = CONFIG_ITEMS.find(i => i.name.toLowerCase() === k.toLowerCase());
      const kType = getAssetTypeForItem(k, cfg?.assetType, cfg ? cfg.kind !== 'stock' : true);
      if (!groups[kType]) groups[kType] = { type: kType, cost: 0, value: 0, items: [] };
      groups[kType].cost += amt;
      groups[kType].value += amt;
      groups[kType].items.push({
        itemKind: 'raw',
        name: k,
        bal: amt,
        costBasis: amt,
        currentValue: amt,
        ccy: 'IDR'
      });
    }
  });

  return groups;
}

function renderHoldings(holdings, usdRate, chfRate, acctBals){
  acctBals = acctBals || {};
  const activeAccounts = CONFIG_ITEMS.filter(i => i.kind === 'account' && !i.archived);

  const allocGroups = getNetWorthAllocations(holdings, activeAccounts, acctBals, rawAccountBalances);

  // Sort allocation type groups by total group value descending
  const sortedTypes = Object.entries(allocGroups)
    .filter(([, group]) => group.items.length)
    .sort((a, b) => {
      const valA = a[1].value > 0 ? a[1].value : a[1].cost;
      const valB = b[1].value > 0 ? b[1].value : b[1].cost;
      return valB - valA;
    });

  if (!sortedTypes.length) {
    document.getElementById('nwContent').innerHTML = '<div class="empty-state">No holdings found</div>';
    return;
  }

  if (!holdingsGroupFilter || !sortedTypes.some(([type]) => type === holdingsGroupFilter)) {
    holdingsGroupFilter = sortedTypes[0][0];
  }

  const grandCost = sortedTypes.reduce((s, [, g]) => s + g.cost, 0);
  const grandValue = sortedTypes.reduce((s, [, g]) => s + (g.value > 0 ? g.value : g.cost), 0);

  let html = `<div class="holding-item" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">Total net worth</div>
        <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Cost basis</div>
        <div style="font-size:13px;font-weight:600">${fUSD(grandCost, usdRate)}</div>
        <div style="font-size:13px;font-weight:600;opacity:0.7">${fRpS(Math.round(grandCost))}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Est. value</div>
        <div style="font-size:13px;font-weight:600">${fUSD(grandValue, usdRate)}</div>
        <div style="font-size:13px;font-weight:600;opacity:0.7">${fRpS(Math.round(grandValue))}</div>
      </div>
    </div>
  </div>`;

  html += '<div class="toggle-row">';
  sortedTypes.forEach(([type]) => {
    const active = type === holdingsGroupFilter ? ' active' : '';
    html += `<div class="toggle-btn holdings-group-btn${active}" data-type="${esc(type)}" onclick="setHoldingsGroupFilter('${esc(type).replace(/'/g, "\\'")}', this)">${esc(type)}</div>`;
  });
  html += '</div>';

  sortedTypes.forEach(([type, group]) => {
    if (type !== holdingsGroupFilter) return;
    const items = group.items;
    if (!items.length) return;

    items.sort((a, b) => {
      if (a.itemKind === 'stock' && b.itemKind !== 'stock') return -1;
      if (a.itemKind !== 'stock' && b.itemKind === 'stock') return 1;
      if (a.itemKind === 'stock' && b.itemKind === 'stock') return b.currentValue - a.currentValue;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const theme = getHoldingTheme(type);
    const groupCost = group.cost;
    const groupValue = group.value;

    html += `<div class="chart-card-title" style="margin-top:14px;margin-bottom:8px;color:${theme.color};font-size:14px;font-weight:700">${esc(type)}</div>`;

    items.forEach(item => {
      if (item.itemKind === 'account') {
        const acct = item.acct;
        const bal = item.bal;
        const ccy = (ACCOUNT_CCY[acct.name] || acct.ccy || 'IDR').toUpperCase();
        let subText = '';
        if (ccy !== 'IDR' && item.balObj?.nativeAmount != null) {
          subText = `<div style="font-size:10px;color:var(--text2);margin-top:2px">${ccy} ${item.balObj.nativeAmount.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2})}</div>`;
        }

        html += `<div class="holding-item">
          <div class="holding-header">
            <div class="holding-name">${esc(acct.name)}</div>
            <div style="display:flex;gap:4px;align-items:center">
              <span class="holding-badge" style="background:${theme.bg};color:${theme.color}">${esc(type)}</span>
              <span class="holding-badge" style="background:var(--bg3);color:var(--text2)">${ccy}</span>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:6px">
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Balance</div>
              ${dualValSmFull(bal, usdRate)}
              ${subText}
            </div>
          </div>
        </div>`;
      } else if (item.itemKind === 'raw') {
        html += `<div class="holding-item">
          <div class="holding-header">
            <div class="holding-name">${esc(item.name)}</div>
            <span class="holding-badge" style="background:${theme.bg};color:${theme.color}">${esc(type)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:6px">
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Balance</div>
              ${dualValSmFull(item.bal, usdRate)}
            </div>
          </div>
        </div>`;
      } else if (item.itemKind === 'stock') {
        const h = item.holding;
        const hasValue = h.currentValue > 0;
        const pnl = hasValue ? h.currentValue - h.costBasis : null;
        const pnlPct = pnl !== null && h.costBasis > 0 ? (pnl / h.costBasis * 100) : null;
        const isUSDStock = type === 'US Stock';
        const isUSD = h.stock.toUpperCase().includes('USD') || h.stock.startsWith('USDIDR') || isUSDStock;
        const isCHF = h.stock.toUpperCase().includes('CHF') || h.stock === 'CHFIDR';

        const lotStr = isUSDStock ? `${h.netLot.toLocaleString('en-US')} shares` :
                       isUSD ? `${h.netLot.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2})} USD` :
                       isCHF ? `${h.netLot.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2})} CHF` :
                       `${h.netLot.toLocaleString('id-ID')} units`;

        const avgStr = isUSDStock
          ? `Avg $${Number(Math.round(h.avgNativePrice + 'e2') + 'e-2').toFixed(2)}`
          : isUSD
            ? `Avg rate Rp${Math.round(h.avgNativePrice).toLocaleString('id-ID')}/USD`
            : isCHF
              ? `Avg rate Rp${Math.round(h.avgNativePrice).toLocaleString('id-ID')}/CHF`
              : `Avg ${fRp(Math.round(h.avgNativePrice))}/unit`;

        let mktStr = '';
        if (h.stock === 'Star Stable Income Fund' || h.stock.toLowerCase().includes('star stable')) {
          const nav = parsePrice(stockPrices['StarStable']) || parsePrice(stockPrices['Star Stable Income Fund']);
          if (nav > 0) {
            const navUsd = usdRate > 0 ? (nav / usdRate) : 0;
            mktStr = `Mkt Rp${Math.round(nav).toLocaleString('id-ID')}/unit · $${navUsd.toFixed(2)}`;
          }
        } else if (h.stock.startsWith('USDIDR') || (isUSD && !isUSDStock)) {
          const mktRate = parsePrice(stockPrices['USDIDR']) || usdRate;
          if (mktRate > 0) {
            mktStr = `Mkt rate Rp${Math.round(mktRate).toLocaleString('id-ID')}/USD`;
          }
        } else if (h.stock === 'CHFIDR' || isCHF) {
          const mktRate = parsePrice(stockPrices['CHFIDR']) || chfRate;
          if (mktRate > 0) {
            mktStr = `Mkt rate Rp${Math.round(mktRate).toLocaleString('id-ID')}/CHF`;
          }
        } else if (isUSDStock || parsePrice(stockPrices[h.stock]) > 0) {
          const p = parsePrice(stockPrices[h.stock]);
          if (p > 0) {
            const pIdr = p * usdRate;
            mktStr = `Mkt $${Number(Math.round(p + 'e2') + 'e-2').toFixed(2)} · ${fRpS(Math.round(pIdr))}`;
          }
        }

        html += `<div class="holding-item">
          <div class="holding-header">
            <div class="holding-name" style="color:${theme.color}">${esc(h.stock)}</div>
            <span class="holding-badge" style="background:${theme.bg};color:${theme.color}">${lotStr}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:6px">
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Cost basis</div>
              ${dualValSm(h.costBasis, usdRate)}
            </div>
            <div style="text-align:right">
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Value</div>
              ${hasValue ? dualVal(h.currentValue, usdRate) : `<div style="color:var(--text2);font-size:12px">Loading…</div>`}
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:6px;padding-top:6px;border-top:0.5px solid var(--border)">
            <div style="font-size:11px;color:var(--text2);line-height:1.35">
              <div>${avgStr}</div>
              ${mktStr ? `<div style="color:var(--blue);font-weight:500;margin-top:1px">${mktStr}</div>` : ''}
            </div>
            <div style="text-align:right;margin-bottom:1px">
              ${pnl !== null ? pnlDual(pnl, pnlPct, usdRate, pnl >= 0 ? 'var(--green)' : 'var(--red)') : ''}
            </div>
          </div>
        </div>`;
      }
    });

    const gPnl = (groupValue > 0 && groupValue !== groupCost) ? groupValue - groupCost : null;
    const gPnlPct = gPnl !== null && groupCost > 0 ? (gPnl / groupCost * 100) : null;
    html += `<div class="holding-item" style="border-color:${theme.color};background:${theme.bg};margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:12px;font-weight:600;color:${theme.color};margin-bottom:4px">Total ${esc(type)}</div>
          <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Cost basis</div>
          <div style="font-size:13px;font-weight:600;color:${theme.color}">${fUSD(groupCost, usdRate)}</div>
          <div style="font-size:13px;font-weight:600;color:${theme.color};opacity:0.7">${fRpS(Math.round(groupCost))}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Est. value</div>
          <div style="font-size:13px;font-weight:600;color:${theme.color}">${fUSD(groupValue, usdRate)}</div>
          <div style="font-size:13px;font-weight:600;color:${theme.color};opacity:0.7">${fRpS(Math.round(groupValue))}</div>
          ${gPnl !== null ? pnlDual(gPnl, gPnlPct, usdRate, gPnl >= 0 ? 'var(--green)' : 'var(--red)') : ''}
        </div>
      </div>
    </div>`;
  });

  document.getElementById('nwContent').innerHTML = html || '<div class="empty-state">No holdings found</div>';
}

function renderOverview(holdings, usdRate, chfRate, cashBalance, acctBals){
  acctBals = acctBals || {};
  const activeAccounts = CONFIG_ITEMS.filter(i => i.kind === 'account' && !i.archived);

  const allocGroups = getNetWorthAllocations(holdings, activeAccounts, acctBals, rawAccountBalances);

  // Derive top metrics directly from allocGroups so Overview top cards and Holdings total sum match 100%!
  let totalInvestCost = 0;
  let totalInvestValue = 0;
  let cashBalanceVal = 0;

  Object.values(allocGroups).forEach(g => {
    g.items.forEach(item => {
      if (item.itemKind === 'stock') {
        totalInvestCost += item.costBasis || 0;
        totalInvestValue += item.currentValue || 0;
      } else {
        cashBalanceVal += item.currentValue || item.bal || 0;
      }
    });
  });

  const hasValue = totalInvestValue > 0;
  const totalNetWorth = (hasValue ? totalInvestValue : totalInvestCost) + cashBalanceVal;
  const pnl = hasValue ? totalInvestValue - totalInvestCost : null;
  const pnlPct = pnl !== null && totalInvestCost > 0 ? (pnl / totalInvestCost * 100) : null;

  function fRpFull(n){ return 'Rp ' + Math.round(n).toLocaleString('id-ID'); }

  // Dynamic "as of" date
  const todayObj = new Date();
  const asOfStr = `${todayObj.getDate()} ${MO[todayObj.getMonth()]} ${todayObj.getFullYear()}`;

  let html = `
    <div class="chart-card" style="margin-bottom:10px">
      <div class="chart-card-title">Total net worth · as of ${asOfStr}</div>
      <div class="val-usd-lg" style="margin-top:4px">${fUSD(totalNetWorth,usdRate)}</div>
      <div class="val-idr-lg" style="margin-bottom:6px">${fRpFull(totalNetWorth)}</div>
      <div style="border-top:0.5px solid var(--border);padding-top:8px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Cost basis</div>
          <div style="font-size:12px;font-weight:500;color:var(--blue)">${fUSD(totalInvestCost,usdRate)}</div>
          <div style="font-size:12px;font-weight:500;color:var(--text2)">${fRpFull(totalInvestCost)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Unrealized P&L</div>
          ${pnl!==null ? pnlDual(pnl, pnlPct, usdRate, pnl>=0?'var(--green)':'var(--red)') : '<div style="color:var(--text2);font-size:12px">—</div>'}
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-bottom:10px">
      <div class="chart-card">
        <div class="chart-card-title" style="margin-bottom:4px;font-size:9px">Investments</div>
        <div class="val-usd-sm" style="margin-top:3px">${fUSD(hasValue?totalInvestValue:totalInvestCost,usdRate)}</div>
        <div class="val-idr-sm">${fRpS(Math.round(hasValue?totalInvestValue:totalInvestCost))}</div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title" style="margin-bottom:4px;font-size:9px">Cash & Accounts</div>
        <div class="val-idr-sm" style="margin-top:3px;font-size:14px;font-weight:600">${fRpS(Math.round(cashBalanceVal))}</div>
        <div style="font-size:10px;color:var(--text2)">${fUSD(cashBalanceVal,usdRate)}</div>
      </div>
      <div class="chart-card" style="background:var(--blue-dim);border-color:var(--blue)">
        <div class="chart-card-title" style="margin-bottom:4px;font-size:9px;color:var(--blue)">FX Rate</div>
        <div style="font-size:13px;font-weight:600;color:var(--blue);margin-top:3px;line-height:1.2">$1 USD</div>
        <div style="font-size:12px;font-weight:500;color:var(--blue)">= Rp ${Math.round(usdRate).toLocaleString('id-ID')}</div>
      </div>
    </div>`;

  const grandTotal = Object.values(allocGroups).reduce((s, g) => s + (g.value > 0 ? g.value : g.cost), 0);
  const sortedTypes = Object.entries(allocGroups).sort((a, b) => {
    const valA = a[1].value > 0 ? a[1].value : a[1].cost;
    const valB = b[1].value > 0 ? b[1].value : b[1].cost;
    return valB - valA;
  });
  const canvasId = 'nwDonutCanvas';

  const legendRows = sortedTypes.map(([type, data]) => {
    const color = getTypeColor(type);
    const amt = data.value > 0 ? data.value : data.cost;
    return `<div style="display:flex;align-items:center;gap:6px">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--text);white-space:nowrap">${esc(type)}</div>
        <div style="font-size:10px;font-weight:500;color:var(--blue);white-space:nowrap">${fUSD(amt,usdRate)} (${fRpS(Math.round(amt))})</div>
      </div>
    </div>`;
  }).join('');

  html += `<div class="chart-card" style="margin-bottom:10px">
    <div class="chart-card-title">Allocation by type</div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="position:relative;flex:0 0 auto;width:calc(100% - 95px);aspect-ratio:1">
        <canvas id="${canvasId}" role="img" aria-label="Portfolio allocation donut chart"></canvas>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;flex:0 0 88px">${legendRows}</div>
    </div>
    <div style="margin-top:10px;padding-top:8px;border-top:0.5px solid var(--border);font-size:11px;color:var(--text2)">
      FX rates: USD/IDR ${Math.round(usdRate).toLocaleString('id-ID')} · CHF/IDR ${Math.round(chfRate).toLocaleString('id-ID')}
    </div>
  </div>`;

  document.getElementById('nwContent').innerHTML = html;

  // Init donut chart after DOM is set
  requestAnimationFrame(() => {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;

    // Destroy previous instance if exists
    const prev = Chart.getChart(canvas);
    if (prev) prev.destroy();

    const chartData = sortedTypes.map(([type, data]) => ({
      label: type,
      value: data.value > 0 ? data.value : data.cost,
      color: getTypeColor(type)
    }));
    const total = grandTotal;

    // Custom plugin: % inside ring + curved label outside ring
    const arcLabelPlugin = {
      id: 'arcLabels',
      afterDraw(chart) {
        const { ctx, _metasets } = chart;
        const meta = _metasets[0];
        if (!meta || !meta.data.length) return;
        meta.data.forEach((arc, i) => {
          const d = chartData[i];
          const pct = Math.round((d.value / total) * 100);
          const midAngle = (arc.startAngle + arc.endAngle) / 2;
          const midRadius = (arc.innerRadius + arc.outerRadius) / 2;

          // % inside ring — threshold in radians so it works on any canvas size
          // 0.12 rad ≈ 7° which covers smaller slices down to ~2%
          const ix = arc.x + Math.cos(midAngle) * midRadius;
          const iy = arc.y + Math.sin(midAngle) * midRadius;
          const ringWidth = arc.outerRadius - arc.innerRadius;
          const arcSpan = Math.abs(arc.endAngle - arc.startAngle);
          if (arcSpan > 0.12 && ringWidth > 10) {
            ctx.save();
            ctx.font = `bold ${Math.max(8, Math.min(11, ringWidth * 0.28))}px -apple-system, sans-serif`;
            ctx.fillStyle = 'rgba(0,0,0,0.85)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(pct + '%', ix, iy);
            ctx.restore();
          }

          // Curved label outside ring — draw label for every slice
          const labelR = arc.outerRadius + 11;
          const fontSize = 9;
          const charWidth = fontSize * 0.58;

          // isBottom: verified against actual segment midAngles with real data
          // US Stock 342° → false, Reksa Dana 103° → true,
          // Cash 188° → true, JHT 240° → false, Forex 263° → false
          const normalMid = ((midAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          const isBottom = normalMid > Math.PI / 3 && normalMid < 7 * Math.PI / 6;

          const anglePerChar = charWidth / labelR;

          ctx.save();
          ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          ctx.fillStyle = d.color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          if (!isBottom) {
            // Top half: draw L→R clockwise along outer edge
            const startA = midAngle - (d.label.length - 1) * anglePerChar / 2;
            for (let j = 0; j < d.label.length; j++) {
              const a = startA + j * anglePerChar;
              ctx.save();
              ctx.translate(arc.x + Math.cos(a) * labelR, arc.y + Math.sin(a) * labelR);
              ctx.rotate(a + Math.PI / 2);
              ctx.fillText(d.label[j], 0, 0);
              ctx.restore();
            }
          } else {
            // Bottom half: draw L→R counter-clockwise so text is not upside-down
            // Start from the right end of the label arc and go left
            const startA = midAngle + (d.label.length - 1) * anglePerChar / 2;
            for (let j = 0; j < d.label.length; j++) {
              const a = startA - j * anglePerChar;
              ctx.save();
              ctx.translate(arc.x + Math.cos(a) * labelR, arc.y + Math.sin(a) * labelR);
              ctx.rotate(a - Math.PI / 2);
              ctx.fillText(d.label[j], 0, 0);
              ctx.restore();
            }
          }

          ctx.restore();
        });
      }
    };

    new Chart(canvas, {
      type: 'doughnut',
      plugins: [arcLabelPlugin],
      data: {
        labels: chartData.map(d => d.label),
        datasets: [{
          data: chartData.map(d => d.value),
          backgroundColor: chartData.map(d => d.color),
          borderWidth: 3,
          borderColor: '#1c1c1e',
          hoverOffset: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '38%',
        layout: { padding: 28 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const pct = Math.round((ctx.parsed / total) * 100);
                const amt = ctx.parsed >= 1e6
                  ? 'Rp' + (ctx.parsed/1e6).toFixed(1) + 'jt'
                  : 'Rp' + Math.round(ctx.parsed).toLocaleString('id-ID');
                return ` ${amt} · ${pct}%`;
              }
            },
            backgroundColor: 'rgba(30,30,32,0.95)',
            titleColor: 'rgba(255,255,255,0.9)',
            bodyColor: 'rgba(255,255,255,0.55)',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 0.5,
            padding: 10,
            cornerRadius: 8,
          }
        }
      }
    });
  });
}

function updateHeaderHeight(){
  const h=document.querySelector('.header');
  if(h)document.documentElement.style.setProperty('--header-height',h.offsetHeight+'px');
}

// iOS standalone/PWA mode recomputes 100dvh mid-gesture (WebKit quirk), which
// reflows #page-home's height under a finger scrolling #calTxList and makes the
// scroll appear to snap back before reaching the last item. Pin the height to a
// JS-measured value instead, refreshed only on real viewport-size changes (never
// on scroll) so an in-progress touch-scroll can't trigger this reflow.
let _lastAppVh = 0;
function updateAppVh(){
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  if (Math.abs(vh - _lastAppVh) < 1) return;
  _lastAppVh = vh;
  document.documentElement.style.setProperty('--app-vh', vh + 'px');
  window.scrollTo(0, 0);
}
updateAppVh();
window.addEventListener('resize', updateAppVh);
window.addEventListener('orientationchange', updateAppVh);
if (window.visualViewport) window.visualViewport.addEventListener('resize', updateAppVh);

// Prevent window scroll from shifting fixed/absolute overlays on input focus
window.addEventListener('scroll', () => {
  if (window.scrollY !== 0 || window.scrollX !== 0) {
    window.scrollTo(0, 0);
  }
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('scroll', () => {
    if (window.visualViewport.offsetTop !== 0 || window.visualViewport.offsetLeft !== 0) {
      window.scrollTo(0, 0);
    }
  });
}

// Keeps the currently-open input-sheet overlay anchored within the area the
// on-screen keyboard hasn't covered, instead of the full layout viewport —
// otherwise the sheet (and its focused input) ends up hidden below the keyboard.
function adjustOverlayForVisualViewport() {
  const ov = document.querySelector('.input-overlay.open');
  if (!ov) return;
  const vv = window.visualViewport;
  if (!vv) { ov.style.top = ''; ov.style.height = ''; return; }
  ov.style.top = vv.offsetTop + 'px';
  ov.style.height = vv.height + 'px';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', adjustOverlayForVisualViewport);
  window.visualViewport.addEventListener('scroll', adjustOverlayForVisualViewport);
}

