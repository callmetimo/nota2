// Nota — savings goals: progress against a target, and what an asset-backed goal is
// currently worth.
//
// Split out of ui-settings.js, unchanged. getGoalCurrentValue() shares
// computeInvestNetLots() with the net-worth page (data-networth.js) so the two cannot
// drift apart on what a holding is worth.

let GOALS = [];
let goalsEditId = null; // sheet rowNum of the goal being edited, or null for new

let _goalsFetchSeq = 0;
async function fetchGoals() {
  const seq = ++_goalsFetchSeq;
  const container = document.getElementById('goalsListContainer');
  if (container) container.innerHTML = '<div class="chart-loading">Loading…</div>';
  try {
    // Was a raw fetch() — same hang risk as the others fixed alongside this one.
    const res = await fetchWithTimeout(apiGet('type=goals'), { method: 'GET' });
    const j = await res.json();
    if (seq !== _goalsFetchSeq) return; // a newer fetchGoals() call superseded this one
    if (j.status === 'ok' && Array.isArray(j.goals)) GOALS = j.goals;
  } catch(e) { /* silently fall through to empty render */ }
  if (seq !== _goalsFetchSeq) return;
  renderGoals();
}

function onGoalCcyChange(ccy) {
  const prefixEl = document.getElementById('goalCcyPrefix');
  if (!prefixEl) return;
  if (ccy === 'IDR') prefixEl.textContent = 'Rp';
  else if (ccy === 'USD') prefixEl.textContent = '$';
  else if (ccy === 'SGD') prefixEl.textContent = 'S$';
  else if (ccy === 'EUR') prefixEl.textContent = '€';
  else prefixEl.textContent = ccy;
}

function fGoalAmt(n, ccy) {
  ccy = (ccy || 'IDR').toUpperCase();
  if (ccy === 'IDR') {
    return fRpS(n);
  }
  let symbol = ccy + ' ';
  if (ccy === 'USD') symbol = '$';
  else if (ccy === 'SGD') symbol = 'S$';
  else if (ccy === 'EUR') symbol = '€';
  
  if (!n) return symbol + '0';
  if (document.documentElement.classList.contains('wide')) return symbol + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  if (n >= 1000000000) return symbol + (n / 1000000000).toFixed(1) + 'B';
  if (n >= 1000000) return symbol + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return symbol + (n / 1000).toFixed(0) + 'K';
  
  return symbol + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function getAssetValue(stock) {
  const allInvest = getAllInvestRows();
  const { buyLots, sellLots, buyTotalIdr } = computeInvestNetLots(allInvest);
  
  const manualUSD = parsePrice(stockPrices['USDIDR']);
  const manualCHF = parsePrice(stockPrices['CHFIDR']);
  const usdRate = manualUSD > 0 ? manualUSD : (fxRates.USD || 16500);
  const chfRate = manualCHF > 0 ? manualCHF : (fxRates.CHF || 19000);

  const navStar = parsePrice(stockPrices['StarStable']);
  const priceQQQ  = parsePrice(stockPrices['QQQ']);
  const priceJNJ  = parsePrice(stockPrices['JNJ']);
  const priceVYM  = parsePrice(stockPrices['VYM']);
  const priceAAPL = parsePrice(stockPrices['AAPL']);

  const netLot = (buyLots[stock] || 0) - (sellLots[stock] || 0);

  if (netLot <= 0) {
    const sItem = CONFIG_ITEMS.find(i => i.kind === 'stock' && i.name && i.name.toLowerCase() === stock.toLowerCase() && !i.archived);
    if (sItem) {
      let rawBal = sItem.balance;
      if (rawBal == null && rawAccountBalances[sItem.name]) {
        rawBal = rawAccountBalances[sItem.name].amount;
      }
      const balNum = parseConfigBalance(rawBal);
      if (balNum !== null && balNum > 0) {
        return balNum;
      }
    }
    return 0;
  }

  const stockConfig = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === stock.toLowerCase());
  let type = getAssetTypeForItem(stock, stockConfig?.assetType || STOCK_TYPE[stock], false);
  const buyRatio = buyLots[stock] > 0 ? netLot / buyLots[stock] : 0;
  const costBasis = buyTotalIdr[stock] * buyRatio;

  let currentValue = 0;
  if (stock === 'Star Stable Income Fund') currentValue = navStar > 0 ? netLot * navStar : 0;
  else if (stock.startsWith('USDIDR')) currentValue = netLot * usdRate;
  else if (stock === 'CHFIDR') currentValue = netLot * chfRate;
  else if (stock === 'QQQ')  currentValue = priceQQQ  > 0 ? netLot * priceQQQ  * usdRate : 0;
  else if (stock === 'JNJ')  currentValue = priceJNJ  > 0 ? netLot * priceJNJ  * usdRate : 0;
  else if (stock === 'VYM')  currentValue = priceVYM  > 0 ? netLot * priceVYM  * usdRate : 0;
  else if (stock === 'AAPL') currentValue = priceAAPL > 0 ? netLot * priceAAPL * usdRate : 0;
  else if (parsePrice(stockPrices[stock]) > 0) {
    currentValue = netLot * parsePrice(stockPrices[stock]) * (type === 'US Stock' ? usdRate : 1);
  } else {
    currentValue = costBasis;
  }
  return currentValue;
}

function getGoalAssetList() {
  const allInvest = getAllInvestRows();
  const stocks = new Set();
  allInvest.forEach(r => { if (r.stock) stocks.add(r.stock); });
  CONFIG_ITEMS.filter(i => i.kind === 'stock' && !i.archived).forEach(i => { if (i.name) stocks.add(i.name); });
  return Array.from(stocks).sort((a, b) => a.localeCompare(b));
}

function getGoalCurrentValue(goal) {
  let totalIdr = 0;
  (goal.sources || []).forEach(source => {
    if (source === 'Cash') { totalIdr += computeCashBalance(); return; }
    if (accountBalances[source]) {
      totalIdr += accountBalances[source].amount || 0;
      return;
    }
    totalIdr += getAssetValue(source);
  });

  const ccy = (goal.ccy || 'IDR').toUpperCase();
  if (ccy === 'IDR') return totalIdr;

  const manualUSD = parsePrice(stockPrices['USDIDR']);
  const manualCHF = parsePrice(stockPrices['CHFIDR']);
  const usdRate = manualUSD > 0 ? manualUSD : (fxRates.USD || 16500);
  const chfRate = manualCHF > 0 ? manualCHF : (fxRates.CHF || 19000);

  if (ccy === 'USD') return totalIdr / usdRate;
  if (ccy === 'CHF') return totalIdr / chfRate;
  if (fxRates[ccy]) return totalIdr / fxRates[ccy];

  return totalIdr;
}

function renderGoals() {
  const container = document.getElementById('goalsListContainer');
  if (!container) return;
  if (!GOALS.length) {
    container.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--text2);font-size:14px;line-height:1.6">No goals yet.<br>' + notaTap(1) + ' <strong style="color:var(--accent)">+</strong> to add your first goal.</div>';
    return;
  }
  const active = GOALS.filter(g => !g.completed);
  const done   = GOALS.filter(g =>  g.completed);
  let html = '';
  const renderCard = g => {
    const current = getGoalCurrentValue(g);
    const pct = Math.min(100, g.targetAmount > 0 ? (current / g.targetAmount * 100) : 0);
    const opacity = g.completed ? '0.45' : '1';
    return `<div class="goal-card" style="opacity:${opacity}" onclick="openGoalsOverlay('edit','${g.id}')">
      <div class="goal-card-header">
        <div class="goal-card-name">${g.name}</div>
        ${g.completed ? '<span style="font-size:10px;color:var(--green);font-weight:600;background:var(--green-dim);padding:2px 8px;border-radius:20px">Done</span>' : ''}
      </div>
      <div style="font-size:11px;color:var(--text2);margin-top:2px">${g.startDate} – ${g.endDate||'…'}</div>
      <div class="goal-progress-wrap"><div class="goal-progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:12px">
        <span style="color:var(--text2)">${fGoalAmt(current, g.ccy)} of ${fGoalAmt(g.targetAmount, g.ccy)}</span>
        <span style="color:var(--accent);font-weight:600">${pct.toFixed(0)}%</span>
      </div>
    </div>`;
  };
  active.forEach(g => { html += renderCard(g); });
  if (done.length) {
    html += `<div class="section-header" style="margin-top:8px"><span class="section-title">Completed</span></div>`;
    done.forEach(g => { html += renderCard(g); });
  }
  container.innerHTML = html;
}

function openGoalsOverlay(mode, goalId) {
  goalsEditId = mode === 'edit' ? goalId : null;
  const goal = goalsEditId ? GOALS.find(g => g.id === goalsEditId) : null;
  document.getElementById('goalsOverlayTitle').textContent = mode === 'new' ? 'New Goal' : 'Edit Goal';
  document.getElementById('goalDeleteBtn').style.display = mode === 'edit' ? 'block' : 'none';
  const completeBtn = document.getElementById('goalMarkCompleteBtn');
  completeBtn.style.display = mode === 'edit' ? 'block' : 'none';

  document.getElementById('goalName').value = goal ? goal.name : '';
  const startDate = goal ? goal.startDate : todayISO();
  document.getElementById('goalStartDateRaw').value = startDate;
  document.getElementById('goalStartDateText').textContent = isoDisp(startDate);
  const endDate = goal ? (goal.endDate || '') : '';
  document.getElementById('goalEndDateRaw').value = endDate;
  document.getElementById('goalEndDateText').textContent = endDate ? isoDisp(endDate) : 'Select date';
  document.getElementById('goalTargetAmount').value = goal ? formatGroupedAmt(goal.targetAmount) : '';
  
  const ccy = goal ? (goal.ccy || 'IDR') : 'IDR';
  document.getElementById('goalCcy').value = ccy;
  onGoalCcyChange(ccy);

  const selectedSources = goal ? (goal.sources || []) : [];
  const assets = getGoalAssetList();
  document.getElementById('goalSourceFundList').innerHTML = assets.map(asset =>
    `<label class="goal-source-row">
      <input type="checkbox" value="${esc(asset)}" ${selectedSources.includes(asset) ? 'checked' : ''}>
      <span style="font-size:14px">${esc(asset)}</span>
    </label>`
  ).join('');

  if (goal) {
    completeBtn.textContent = goal.completed ? 'Mark Incomplete' : 'Mark Complete';
    completeBtn.className = 'goal-complete-btn' + (goal.completed ? ' done' : '');
  }
  const ov = document.getElementById('goalsOverlay');
  ov.classList.add('open');
  adjustOverlayForVisualViewport();
}

function closeGoalsOverlay() {
  const ov = document.getElementById('goalsOverlay');
  if (ov) {
    ov.classList.remove('open');
    ov.style.top = '';
    ov.style.height = '';
  }
  goalsEditId = null;
}

async function saveGoal() {
  const name = document.getElementById('goalName').value.trim();
  const startDate = document.getElementById('goalStartDateRaw').value;
  const endDate = document.getElementById('goalEndDateRaw').value;
  const targetAmount = parseAmt('goalTargetAmount');
  const sources = Array.from(document.querySelectorAll('#goalSourceFundList input[type=checkbox]:checked')).map(cb => cb.value);
  const ccy = document.getElementById('goalCcy').value;
  if (!name || !targetAmount) return;
  const saveBtn = document.querySelector('#goalsOverlay .submit-btn');
  if (saveBtn) saveBtn.textContent = 'Saving…';
  const existing = goalsEditId ? GOALS.find(g => g.id === goalsEditId) : null;
  const payload = {
    type: 'goals', action: 'save',
    id: goalsEditId || null,
    name, startDate, endDate, targetAmount, sources, ccy,
    completed: existing ? existing.completed : false,
    completedDate: existing ? (existing.completedDate || '') : ''
  };
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      if (goalsEditId) {
        const idx = GOALS.findIndex(g => g.id === goalsEditId);
        if (idx >= 0) GOALS[idx] = { ...GOALS[idx], name, startDate, endDate, targetAmount, sources, ccy };
      } else {
        GOALS.push({ id: j.id, name, startDate, endDate, targetAmount, sources, ccy, completed: false, completedDate: null });
      }
      closeGoalsOverlay();
      renderGoals();
    }
  } finally {
    if (saveBtn) saveBtn.textContent = 'Save Goal';
  }
}

async function deleteGoal() {
  if (!goalsEditId) return;
  const delBtn = document.getElementById('goalDeleteBtn');
  if (delBtn) delBtn.textContent = 'Deleting…';
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody({ type: 'goals', action: 'delete', id: goalsEditId }) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      GOALS = GOALS.filter(g => g.id !== goalsEditId);
      closeGoalsOverlay();
      renderGoals();
    }
  } finally {
    if (delBtn) delBtn.textContent = 'Delete Goal';
  }
}

async function toggleGoalComplete() {
  if (!goalsEditId) return;
  const goal = GOALS.find(g => g.id === goalsEditId);
  if (!goal) return;
  const newCompleted = !goal.completed;
  const newCompletedDate = newCompleted ? todayISO() : null;
  const completeBtn = document.getElementById('goalMarkCompleteBtn');
  if (completeBtn) completeBtn.textContent = 'Saving…';
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, {
      method: 'POST', headers: {'Content-Type': 'text/plain'},
      body: apiBody({
        type: 'goals', action: 'save', id: goalsEditId,
        name: goal.name, startDate: goal.startDate, endDate: goal.endDate,
        targetAmount: goal.targetAmount, sources: goal.sources, ccy: goal.ccy || 'IDR',
        completed: newCompleted, completedDate: newCompletedDate || ''
      })
    });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      goal.completed = newCompleted;
      goal.completedDate = newCompletedDate;
    }
  } finally {
    if (completeBtn) {
      completeBtn.textContent = goal.completed ? 'Mark Incomplete' : 'Mark Complete';
      completeBtn.className = 'goal-complete-btn' + (goal.completed ? ' done' : '');
    }
  }
}

// ── PROFILE HUB NAVIGATION ────────────────────────────────────
