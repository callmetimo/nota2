// ── CONFIG (Categories / PMs / Assets / Accounts, user-editable via Settings) ──
const LS_CONFIG_KEY = 'notapub_config_items';
const LS_RAW_BAL_KEY = 'notapub_raw_account_balances';

let CONFIG_ITEMS = [];
try {
  const cachedCfg = localStorage.getItem(LS_CONFIG_KEY);
  if (cachedCfg) CONFIG_ITEMS = JSON.parse(cachedCfg);
} catch(e) {}

let rawAccountBalances = {}; // {accountName: {date, amount, txId}} latest snapshot per account
try {
  const cachedBal = localStorage.getItem(LS_RAW_BAL_KEY);
  if (cachedBal) rawAccountBalances = JSON.parse(cachedBal);
} catch(e) {}

let accountBalances = {}; // {accountName: {amount}} after applying transaction deltas

function parseConfigBalance(val) {
  return DataStore.parseMoneyCell(val, null);
}

function syncConfigToRawAccountBalances() {
  if (!CONFIG_ITEMS || !CONFIG_ITEMS.length) return;
  const todayStr = new Date().toISOString().slice(0, 10);

  // Clean up legacy or word-reversed keys in rawAccountBalances that belong to configured items (e.g. IDR BCA -> BCA IDR)
  const configuredNames = CONFIG_ITEMS.map(i => i.name).filter(Boolean);
  Object.keys(rawAccountBalances).forEach(k => {
    const kSorted = k.toLowerCase().split(/\s+/).sort().join(' ');
    configuredNames.forEach(cName => {
      const cSorted = cName.toLowerCase().split(/\s+/).sort().join(' ');
      if (k !== cName && kSorted === cSorted) {
        delete rawAccountBalances[k];
      }
    });
  });

  CONFIG_ITEMS.filter(i => (i.kind === 'account' || i.kind === 'stock') && !i.archived).forEach(acct => {
    if (acct.balance != null && acct.balance !== '') {
      const cleanNum = parseConfigBalance(acct.balance);
      if (cleanNum !== null && cleanNum !== 0) {
        const bDate = acct.balanceDate || todayStr;
        const cur = rawAccountBalances[acct.name];
        if (!cur || !cur.amount || cur.amount === 0 || bDate >= (cur.date || '') || (cur.txId && cur.txId.startsWith('config_'))) {
          rawAccountBalances[acct.name] = {
            date: bDate,
            amount: cleanNum,
            txId: 'config_' + acct.name
          };
        }
      }
    }
  });
  try {
    localStorage.setItem(LS_RAW_BAL_KEY, JSON.stringify(rawAccountBalances));
  } catch(e) {}
}

async function fetchConfig() {
  try {
    const res = await fetch(apiGet('type=config'), { method: 'GET' });
    const j = await res.json();
    if (j.status === 'ok' && Array.isArray(j.items)) {
      CONFIG_ITEMS = j.items;
      try { localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(CONFIG_ITEMS)); } catch(e) {}
      applyConfigToGlobals();
      syncConfigToRawAccountBalances();
      buildAccountBalances();
      renderAccountBalanceCards();
      renderSettingsLists();
    }
  } catch (e) { /* offline or first-run race — keep hardcoded defaults as fallback */ }
}

function applyConfigToGlobals() {
  if (!CONFIG_ITEMS.length) return;
  const byKind = k => CONFIG_ITEMS.filter(i => i.kind === k && !i.archived)
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })).map(i => i.name);

  allCategories.length = 0; allCategories.push(...byKind('category'));
  allPMs.length = 0;        allPMs.push(...byKind('pm'));
  allStocks.length = 0;     allStocks.push(...byKind('stock'));
  allAccounts.length = 0;   allAccounts.push(...byKind('account'));

  Object.keys(CAT_COLORS).forEach(k => { if (k !== 'Other') delete CAT_COLORS[k]; });
  CONFIG_ITEMS.filter(i => i.kind === 'category' && i.color).forEach(i => { CAT_COLORS[i.name] = i.color; });

  Object.keys(ACCOUNT_CCY).forEach(k => delete ACCOUNT_CCY[k]);
  CONFIG_ITEMS.filter(i => i.kind === 'account' && i.ccy).forEach(i => { ACCOUNT_CCY[i.name] = i.ccy; });

  Object.keys(STOCK_TYPE).forEach(k => delete STOCK_TYPE[k]);
  CONFIG_ITEMS.filter(i => i.assetType).forEach(i => { STOCK_TYPE[i.name] = i.assetType; });
}

async function saveConfigToServer() {
  try {
    localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(CONFIG_ITEMS));
  } catch(e) {}
  await fetchWithTimeout(APPS_SCRIPT_URL, {
    method: 'POST', headers: {'Content-Type': 'text/plain'},
    body: apiBody({ type: 'config', action: 'saveAll', items: CONFIG_ITEMS })
  });
  applyConfigToGlobals();
}

// Initial hydration from cached CONFIG_ITEMS
if (CONFIG_ITEMS.length) {
  applyConfigToGlobals();
  syncConfigToRawAccountBalances();
}

// ── SETTINGS PAGE (Config CRUD) ───────────────────────────────
const CONFIG_KIND_LABELS = { category: 'Categories', pm: 'Payment Methods', stock: 'Assets', account: 'Accounts' };
let settingsShowArchived = { category: false, pm: false, stock: false, account: false };
let currentSettingsTab = 'category';

function setSettingsTab(tab) {
  currentSettingsTab = tab;
  renderSettingsLists();
}

// Embeds a JS string literal inside a double-quoted HTML attribute (e.g. onclick="fn(...)").
// JSON.stringify alone produces its own double quotes, which would prematurely close the
// HTML attribute — escape & and " so the browser decodes them back before the JS parses it.
function jsAttr(v) {
  return JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

async function installLivePrices() {
  try {
    await DataStore.installLivePriceFormulas();
    showToast('Live stock prices enabled', 'success');
  } catch (e) {
    showToast('Could not enable live prices: ' + e.message, 'error');
  }
}

// ── ACCOUNT BALANCES ──────────────────────────────────────────
async function fetchAccountBalances() {
  try {
    const res = await fetch(apiGet('type=balances'), { method: 'GET' });
    const j = await res.json();
    if (j.status === 'ok') {
      const incoming = j.balances || {};
      Object.keys(incoming).forEach(k => {
        const cur = rawAccountBalances[k];
        if (!cur || (incoming[k].date && incoming[k].date >= cur.date)) {
          rawAccountBalances[k] = incoming[k];
        }
      });
      syncConfigToRawAccountBalances();
      try { localStorage.setItem(LS_RAW_BAL_KEY, JSON.stringify(rawAccountBalances)); } catch(e) {}
      buildAccountBalances();
      renderAccountBalanceCards();
    }
  } catch(e) { /* offline — keep whatever we have */ }
}

function isCreditCardPM(pmName) {
  if (!pmName) return false;
  const item = CONFIG_ITEMS.find(i => i.kind === 'pm' && i.name === pmName);
  return !!(item && item.creditCard);
}

function getAccountMatchNames(acctOrPm) {
  const names = new Set();
  if (typeof acctOrPm === 'string') {
    if (acctOrPm.trim()) names.add(acctOrPm.toLowerCase().trim());
  } else if (acctOrPm && typeof acctOrPm === 'object') {
    if (acctOrPm.name) names.add(acctOrPm.name.toLowerCase().trim());
    if (acctOrPm.name) {
      const stripped = acctOrPm.name.replace(/^(IDR|USD)\s+/i, '').toLowerCase().trim();
      if (stripped) names.add(stripped);
    }
  }
  return Array.from(names);
}

function computeAccountCurrentBalance(baseAmount, baseDate, acctOrPm) {
  baseAmount = Number(baseAmount) || 0;
  const matchNames = getAccountMatchNames(acctOrPm);
  if (!matchNames.length) return baseAmount;
  let delta = 0;

  // 1. Opex: synced and cached sheet transactions (including transfers)
  (HIST.opex || []).forEach(r => {
    const rPm = String(r.pm || '').toLowerCase().trim();
    if (!matchNames.includes(rPm)) return;
    const rowDate = `${r.y}-${String(r.m + 1).padStart(2,'0')}-${String(r.d).padStart(2,'0')}`;
    if (baseDate && rowDate <= baseDate) return;
    delta += (Number(r.inc) || 0) - (Number(r.exp) || 0);
  });

  // 2. Local unsynced transactions and transfers from txHistory
  (txHistory || []).forEach(r => {
    if (r.synced) return;
    if (baseDate && r.date && r.date <= baseDate) return;

    if (r.type === 'transfer') {
      const fromMatch = matchNames.includes(String(r.fromPm || '').toLowerCase().trim());
      const toMatch = matchNames.includes(String(r.toPm || '').toLowerCase().trim());
      const amt = Number(r.amount) || 0;
      if (fromMatch && !toMatch) delta -= amt;
      else if (toMatch && !fromMatch) delta += amt;
    } else {
      const rPm = String(r.pm || '').toLowerCase().trim();
      if (!matchNames.includes(rPm)) return;
      const amt = Number(r.amount) || 0;
      if (r.type === 'income') delta += amt;
      else if (r.type === 'expense') delta -= amt;
    }
  });

  // 3. Local unsynced Invest transactions for IDR accounts
  (investHistory || []).forEach(r => {
    if (r.synced) return;
    if (baseDate && r.date && r.date <= baseDate) return;
    const rAcct = String(r.account || '').toLowerCase().trim();
    if (!matchNames.includes(rAcct)) return;
    if (r.action === 'Buy') delta -= (Number(r.totalIdr) || 0);
    else if (r.action === 'Sell') delta += (Number(r.totalIdr) || 0);
  });

  return baseAmount + delta;
}

function buildAccountBalances() {
  accountBalances = {};
  syncConfigToRawAccountBalances();

  const allInvest = getAllInvestRows();
  const investNetLots = (allInvest && allInvest.length) ? computeInvestNetLots(allInvest) : null;
  const manualUSD = parsePrice(stockPrices['USDIDR']);
  const manualCHF = parsePrice(stockPrices['CHFIDR']);
  const usdRate = manualUSD > 0 ? manualUSD : (fxRates.USD || 16500);
  const chfRate = manualCHF > 0 ? manualCHF : (fxRates.CHF || 19000);

  CONFIG_ITEMS.filter(i => i.kind === 'account' && !i.archived).forEach(acct => {
    const ccy = (ACCOUNT_CCY[acct.name] || acct.ccy || 'IDR').toUpperCase();
    let rate = 1;
    if (ccy === 'USD') rate = usdRate;
    else if (ccy === 'CHF') rate = chfRate;
    else if (fxRates[ccy]) rate = fxRates[ccy];

    const raw = rawAccountBalances[acct.name];
    let baseAmt = 0;
    let baseDate = acct.balanceDate || new Date().toISOString().slice(0, 10);
    if (raw && (raw.amount || raw.amount === 0)) {
      baseAmt = Number(raw.amount) || 0;
      if (raw.date) baseDate = raw.date;
    }
    if (!baseAmt) {
      const cleanConfigBal = parseConfigBalance(acct.balance);
      if (cleanConfigBal) baseAmt = cleanConfigBal;
    }

    if (ccy !== 'IDR') {
      let netLot = 0;
      if (investNetLots) {
        Object.keys(investNetLots.buyLots).forEach(s => {
          if (isFxAccountMatch(acct.name, ccy, s)) {
            netLot += (investNetLots.buyLots[s] || 0) - (investNetLots.sellLots[s] || 0);
          }
        });
      }

      if (netLot > 0) {
        accountBalances[acct.name] = { amount: netLot * rate, nativeAmount: netLot, ccy };
        return;
      }

      const currentNative = computeAccountCurrentBalance(baseAmt, baseDate, acct);
      accountBalances[acct.name] = { amount: currentNative * rate, nativeAmount: currentNative, ccy };
      return;
    }

    // IDR accounts: use Config / Balances snapshot + Opex/Invest deltas
    const current = computeAccountCurrentBalance(baseAmt, baseDate, acct);
    accountBalances[acct.name] = { amount: current, nativeAmount: current, ccy: 'IDR' };
  });
}

function renderAccountBalanceCards() {
  const el = document.getElementById('accountBalanceCards');
  if (!el) return;
  const withBal = CONFIG_ITEMS.filter(i => i.kind === 'account' && !i.archived && i.showOnInsights !== false && accountBalances[i.name] != null);
  if (!withBal.length) {
    el.innerHTML = `<div class="acct-bal-section"><div class="acct-bal-empty">No accounts selected — open <span onclick="switchTabFromMore('settings')">Settings → Accounts</span> to configure.</div></div>`;
    return;
  }
  const totalCash = withBal.reduce((s, a) => s + (accountBalances[a.name]?.amount || 0), 0);
  const cards = withBal.map(a => {
    const balObj = accountBalances[a.name];
    const bal = balObj?.amount || 0;
    const ccy = (ACCOUNT_CCY[a.name] || a.ccy || 'IDR').toUpperCase();
    let subText = '';
    if (ccy !== 'IDR' && balObj?.nativeAmount != null) {
      subText = `<div style="font-size:10px;color:var(--text2);margin-top:2px">${ccy} ${balObj.nativeAmount.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2})}</div>`;
    }
    const highlightStyle = a.color ? ` style="border-color: ${a.color}; background: color-mix(in srgb, ${a.color} 10%, var(--bg2));"` : '';
    return `<div class="acct-bal-card"${highlightStyle} onclick="tapAccountCard('${escJsAttr(a.name)}')">
      <div class="acct-bal-name">${esc(a.name)}</div>
      <div class="acct-bal-amount">${fRp(Math.round(bal))}</div>
      ${subText}
    </div>`;
  }).join('');
  el.innerHTML = `<div class="acct-bal-section">
    <div class="acct-bal-header">
      <div class="acct-bal-label">Accounts</div>
      <div class="acct-bal-link" onclick="goToHoldings()">Net Worth →</div>
    </div>
    <div class="acct-bal-grid">${cards}</div>
    <div class="acct-bal-total">
      <div class="acct-bal-total-label">Total cash</div>
      <div class="acct-bal-total-val">${fRp(Math.round(totalCash))}</div>
    </div>
  </div>`;
}

function goToHoldings() {
  nwMode = 'holdings';
  switchTabFromMore('networth');
}

function tapAccountCard(accountName) {
  const account = CONFIG_ITEMS.find(i => i.kind === 'account' && i.name === accountName);
  let pmToFilter = 'all';
  if (account) {
    if (account.linkedPM) {
      const exactPm = (allPMs || []).find(p => p.toLowerCase() === account.linkedPM.toLowerCase());
      pmToFilter = exactPm || account.linkedPM;
    } else {
      const exactPm = (allPMs || []).find(p => p.toLowerCase() === account.name.toLowerCase());
      pmToFilter = exactPm || account.name;
    }
  }
  ccMonitorPmFilter = pmToFilter;
  ccMonitorDate = new Date();
  
  // Clear search input query
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.value = '';
  searchActiveQuery = '';
  
  switchTab('search');
}

function openSetBalanceFromConfigOverlay() {
  const accountName = document.getElementById('configItemOrigName').value || document.getElementById('configItemName').value.trim();
  if (!accountName) return;
  document.getElementById('setBalanceAccount').value = accountName;
  document.getElementById('setBalanceTitle').textContent = `Set Balance: ${accountName}`;
  const item = CONFIG_ITEMS.find(i => i.kind === 'account' && i.name === accountName);
  const raw = rawAccountBalances[accountName];
  const amtVal = (item && item.balance != null) ? item.balance : (raw ? raw.amount : '');
  const dateVal = (item && item.balanceDate) ? item.balanceDate : (raw ? raw.date : new Date().toISOString().slice(0, 10));
  document.getElementById('setBalanceAmount').value = amtVal !== '' ? formatGroupedAmt(amtVal) : '';
  document.getElementById('setBalanceDate').value = dateVal;
  closeConfigItemOverlay();
  const ov = document.getElementById('setBalanceOverlay');
  ov.classList.add('open');
  adjustOverlayForVisualViewport();
}

function closeSetBalanceOverlay() {
  const ov = document.getElementById('setBalanceOverlay');
  if (ov) {
    ov.classList.remove('open');
    ov.style.top = '';
    ov.style.height = '';
  }
}

async function saveAccountBalance() {
  const account = document.getElementById('setBalanceAccount').value.trim();
  const date    = document.getElementById('setBalanceDate').value;
  const amount  = parseAmt('setBalanceAmount');
  if (!account || !date) { showToast('Account and date required', 'error'); return; }
  const txId = 'bal_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  showToast('Saving…', 'loading');
  try {
    let item = CONFIG_ITEMS.find(i => i.kind === 'account' && i.name.toLowerCase() === account.toLowerCase());
    if (!item) {
      const maxOrder = Math.max(-1, ...CONFIG_ITEMS.filter(i => i.kind === 'account').map(i => i.sortOrder));
      item = { kind: 'account', name: account, color: '', ccy: '', assetType: '', linkedPM: '', archived: false, sortOrder: maxOrder + 1 };
      CONFIG_ITEMS.push(item);
    }
    item.balance = amount;
    item.balanceDate = date;

    rawAccountBalances[item.name] = { date, amount, txId };
    rawAccountBalances[account] = { date, amount, txId };

    try { localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(CONFIG_ITEMS)); } catch(e) {}
    try { localStorage.setItem(LS_RAW_BAL_KEY, JSON.stringify(rawAccountBalances)); } catch(e) {}

    buildAccountBalances();
    renderAccountBalanceCards();
    renderSettingsLists();
    closeSetBalanceOverlay();

    await fetchWithTimeout(APPS_SCRIPT_URL, {
      method: 'POST', headers: {'Content-Type': 'text/plain'},
      body: apiBody({ type: 'balances', action: 'saveBalance', account: item.name, date, amount, txId })
    });

    // Also persist to Config sheet columns I (balance) and J (balanceDate)
    await saveConfigToServer();

    showToast('Balance saved', 'success');
  } catch(e) {
    showToast('Could not save: ' + e.message, 'error');
  }
}

function renderSettingsLists() {
  const container = document.getElementById('settingsListsContainer');
  if (!container) return;
  const kinds = ['category', 'pm', 'stock', 'account'];
  if (!kinds.includes(currentSettingsTab)) {
    currentSettingsTab = 'category';
  }

  const toggleHtml = `
    <div class="settings-tab-toggle">
      ${kinds.map(k => `
        <button class="settings-tab-btn ${currentSettingsTab === k ? 'active' : ''}" onclick="setSettingsTab('${k}')">
          ${CONFIG_KIND_LABELS[k]}
        </button>
      `).join('')}
    </div>
  `;

  const kind = currentSettingsTab;
  const items = CONFIG_ITEMS.filter(i => i.kind === kind).sort((a,b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const active = items.filter(i => !i.archived);
  const archived = items.filter(i => i.archived);
  const showArchived = settingsShowArchived[kind];

  const rowHtml = it => {
    let metaStr = '';
    let accountCheckHtml = '';
    if (kind === 'pm' && !it.archived) {
      const isCc = !!it.creditCard;
      accountCheckHtml = `<label style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text2);cursor:pointer;margin-left:8px" onclick="event.stopPropagation()" title="Credit card (deferred billing)">
        <input type="checkbox" ${isCc ? 'checked' : ''} style="accent-color:var(--accent);width:15px;height:15px;cursor:pointer" onchange="togglePMCreditCard('${escJsAttr(it.name)}', this.checked)">
        <span>Credit card</span>
      </label>`;
    } else if (kind === 'stock') metaStr = it.assetType || 'US Stock';
    else if (kind === 'account') {
      const ccyCode = it.ccy || 'IDR';
      const typeStr = it.assetType || 'Cash';
      if (it.balance != null && it.balanceDate && !isNaN(Number(it.balance))) {
        const formattedBal = Number(it.balance).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        metaStr = `${typeStr} · ${ccyCode} ${formattedBal} (${it.balanceDate})`;
      } else metaStr = `${typeStr} · ${ccyCode}`;

      if (!it.archived) {
        const isChecked = it.showOnInsights !== false;
        accountCheckHtml = `<label style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text2);cursor:pointer;margin-left:8px" onclick="event.stopPropagation()" title="Show on Insights">
          <input type="checkbox" ${isChecked ? 'checked' : ''} style="accent-color:var(--accent);width:15px;height:15px;cursor:pointer" onchange="toggleAccountShowOnInsights('${escJsAttr(it.name)}', this.checked)">
          <span>Insights</span>
        </label>`;
      }
    }
    return `<div class="config-row" onclick="openConfigItemOverlay('${kind}', ${jsAttr(it.name)})">
      <div class="config-row-name">
        ${it.color ? `<span class="config-color-dot" style="background:${it.color}"></span>` : ''}
        <span>${esc(it.name)}</span>
        ${it.archived ? '<span class="config-archived-badge">Deleted</span>' : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span class="config-row-meta">${metaStr}</span>
        ${accountCheckHtml}
      </div>
    </div>`;
  };

  const listHtml = `
    <div class="config-section-header" style="margin-top:0">
      <div class="config-section-title">${CONFIG_KIND_LABELS[kind]}</div>
      <button class="config-add-btn" onclick="openConfigItemOverlay('${kind}', null)">+ Add</button>
    </div>
    ${active.map(rowHtml).join('') || '<div style="color:var(--text2);font-size:13px;padding:8px 0">No items yet.</div>'}
    ${archived.length ? `<button class="config-archived-toggle" onclick="settingsShowArchived['${kind}']=!settingsShowArchived['${kind}'];renderSettingsLists()">${showArchived ? 'Hide' : 'Show'} ${archived.length} deleted</button>` : ''}
    ${showArchived ? archived.map(rowHtml).join('') : ''}
    ${kind === 'stock' ? `<button class="submit-btn" style="background:var(--bg3);color:var(--text);margin-top:20px;font-size:13px" onclick="installLivePrices()">Enable live stock prices (GOOGLEFINANCE)</button>` : ''}
  `;

  container.innerHTML = toggleHtml + listHtml;
}

async function togglePMCreditCard(pmName, checked) {
  const item = CONFIG_ITEMS.find(i => i.kind === 'pm' && i.name === pmName);
  if (!item) return;
  item.creditCard = checked;
  try { localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(CONFIG_ITEMS)); } catch(e) {}
  renderSettingsLists();
  await saveConfigToServer();
}

async function toggleAccountShowOnInsights(accountName, checked) {
  const item = CONFIG_ITEMS.find(i => i.kind === 'account' && i.name === accountName);
  if (!item) return;
  item.showOnInsights = checked;
  try { localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(CONFIG_ITEMS)); } catch(e) {}
  buildAccountBalances();
  renderAccountBalanceCards();
  renderSettingsLists();
  await saveConfigToServer();
}

function _configFieldsForKind(kind) {
  document.getElementById('configItemColorGroup').style.display = (kind === 'category' || kind === 'account') ? 'block' : 'none';
  document.getElementById('configItemAssetTypeGroup').style.display = (kind === 'stock' || kind === 'account') ? 'block' : 'none';
  document.getElementById('configItemCcyGroup').style.display = kind === 'account' ? 'block' : 'none';
  document.getElementById('configItemLinkedPMGroup').style.display = kind === 'account' ? 'block' : 'none';
  if (document.getElementById('configItemBalanceGroup')) document.getElementById('configItemBalanceGroup').style.display = (kind === 'account' || kind === 'stock') ? 'block' : 'none';
  if (document.getElementById('configItemBalanceDateGroup')) document.getElementById('configItemBalanceDateGroup').style.display = (kind === 'account' || kind === 'stock') ? 'block' : 'none';
  if (document.getElementById('configItemShowOnInsightsGroup')) document.getElementById('configItemShowOnInsightsGroup').style.display = kind === 'account' ? 'block' : 'none';
  if (document.getElementById('configItemCreditCardGroup')) document.getElementById('configItemCreditCardGroup').style.display = kind === 'pm' ? 'block' : 'none';
}

function _onConfigCcyChange() {
  const sel = document.getElementById('configItemCcy').value;
  const customEl = document.getElementById('configItemCcyCustom');
  if (sel === 'CUSTOM') {
    customEl.style.display = 'block';
    customEl.focus();
  } else {
    customEl.style.display = 'none';
  }
}

function _onConfigAssetTypeChange() {
  const sel = document.getElementById('configItemAssetType').value;
  const customEl = document.getElementById('configItemAssetTypeCustom');
  if (sel === 'CUSTOM') {
    customEl.style.display = 'block';
    customEl.focus();
  } else {
    customEl.style.display = 'none';
  }
}

function openConfigItemOverlay(kind, name) {
  const item = name ? CONFIG_ITEMS.find(i => i.kind === kind && i.name === name) : null;
  document.getElementById('configItemKind').value = kind;
  document.getElementById('configItemOrigName').value = name || '';
  document.getElementById('configItemOverlayTitle').textContent = item ? `Edit ${CONFIG_KIND_LABELS[kind].replace(/s$/, '')}` : `New ${CONFIG_KIND_LABELS[kind].replace(/s$/, '')}`;
  document.getElementById('configItemName').value = item ? item.name : '';
  document.getElementById('configItemColor').value = (item && item.color) || '#c8f060';

  const typeVal = item && item.assetType ? item.assetType : (kind === 'account' ? 'Cash' : 'US Stock');
  const typeSel = document.getElementById('configItemAssetType');
  const typeCustom = document.getElementById('configItemAssetTypeCustom');
  const typePresets = ['Cash', 'Reksa Dana', 'Forex', 'US Stock', 'JHT'];
  if (typePresets.includes(typeVal)) {
    typeSel.value = typeVal;
    typeCustom.style.display = 'none';
    typeCustom.value = '';
  } else {
    typeSel.value = 'CUSTOM';
    typeCustom.style.display = 'block';
    typeCustom.value = typeVal;
  }

  const ccyVal = (item && item.ccy) ? item.ccy.toUpperCase() : 'IDR';
  const ccySel = document.getElementById('configItemCcy');
  const ccyCustom = document.getElementById('configItemCcyCustom');
  const presets = ['IDR', 'USD', 'SGD', 'EUR', 'AUD', 'JPY', 'GBP', 'MYR', 'THB', 'CNY'];
  if (presets.includes(ccyVal)) {
    ccySel.value = ccyVal;
    ccyCustom.style.display = 'none';
    ccyCustom.value = '';
  } else {
    ccySel.value = 'CUSTOM';
    ccyCustom.style.display = 'block';
    ccyCustom.value = ccyVal;
  }

  const linkedPMSel = document.getElementById('configItemLinkedPM');
  linkedPMSel.innerHTML = `<option value="">(None)</option>` +
    allPMs.map(pm => `<option value="${esc(pm)}"${(item && item.linkedPM === pm) ? ' selected' : ''}>${esc(pm)}</option>`).join('');
  if (document.getElementById('configItemBalance')) {
    const raw = item ? rawAccountBalances[item.name] : null;
    const amtVal = (item && item.balance != null) ? item.balance : (raw ? raw.amount : '');
    document.getElementById('configItemBalance').value = formatGroupedAmt(amtVal);
  }
  if (document.getElementById('configItemBalanceDate')) {
    const raw = item ? rawAccountBalances[item.name] : null;
    const dateVal = (item && item.balanceDate) ? item.balanceDate : (raw ? raw.date : new Date().toISOString().slice(0, 10));
    document.getElementById('configItemBalanceDate').value = dateVal;
  }
  if (document.getElementById('configItemShowOnInsightsCheckbox')) {
    document.getElementById('configItemShowOnInsightsCheckbox').checked = item ? (item.showOnInsights !== false) : true;
  }
  if (document.getElementById('configItemCreditCardCheckbox')) {
    document.getElementById('configItemCreditCardCheckbox').checked = !!(item && item.creditCard);
  }
  document.getElementById('configItemArchiveBtn').style.display = item ? 'block' : 'none';
  document.getElementById('configItemArchiveBtn').textContent = item && item.archived ? 'Restore' : 'Delete';
  _configFieldsForKind(kind);
  const ov = document.getElementById('configItemOverlay');
  ov.classList.add('open');
  adjustOverlayForVisualViewport();
}

function closeConfigItemOverlay() {
  const ov = document.getElementById('configItemOverlay');
  if (ov) {
    ov.classList.remove('open');
    ov.style.top = '';
    ov.style.height = '';
  }
}

async function saveConfigItem() {
  const kind = document.getElementById('configItemKind').value;
  const origName = document.getElementById('configItemOrigName').value;
  const name = document.getElementById('configItemName').value.trim();
  if (!name) return;

  const dup = CONFIG_ITEMS.find(i => i.kind === kind && !i.archived && i.name.toLowerCase() === name.toLowerCase() && i.name !== origName);
  if (dup) { showToast('An active item with that name already exists', 'error'); return; }

  const existing = origName ? CONFIG_ITEMS.find(i => i.kind === kind && i.name === origName) : null;
  const color = (kind === 'category' || kind === 'account') ? document.getElementById('configItemColor').value : '';
  
  let assetType = '';
  if (kind === 'stock' || kind === 'account') {
    const selVal = document.getElementById('configItemAssetType').value;
    if (selVal === 'CUSTOM') {
      assetType = (document.getElementById('configItemAssetTypeCustom').value || '').trim() || (kind === 'account' ? 'Cash' : 'US Stock');
    } else {
      assetType = selVal;
    }
  }

  let ccy = '';
  if (kind === 'account') {
    const selVal = document.getElementById('configItemCcy').value;
    if (selVal === 'CUSTOM') {
      ccy = (document.getElementById('configItemCcyCustom').value || '').trim().toUpperCase() || 'IDR';
    } else {
      ccy = selVal;
    }
  }
  const linkedPM = kind === 'account' ? (document.getElementById('configItemLinkedPM').value || '') : '';
  const balanceEl = document.getElementById('configItemBalance');
  const balanceRaw = balanceEl ? balanceEl.value : null;
  let balance = null;
  if (balanceRaw !== null && String(balanceRaw).trim() !== '') {
    balance = parseAmt('configItemBalance');
  }
  const balanceDate = (document.getElementById('configItemBalanceDate')) ? (document.getElementById('configItemBalanceDate').value || '') : '';
  const showOnInsights = kind === 'account' ? (document.getElementById('configItemShowOnInsightsCheckbox') ? document.getElementById('configItemShowOnInsightsCheckbox').checked : true) : true;
  const creditCard = kind === 'pm' ? (document.getElementById('configItemCreditCardCheckbox') ? document.getElementById('configItemCreditCardCheckbox').checked : false) : false;

  if (existing) {
    existing.name = name; existing.color = color; existing.assetType = assetType; existing.ccy = ccy; existing.linkedPM = linkedPM;
    if (kind === 'account' || kind === 'stock') {
      existing.balance = balance;
      existing.balanceDate = balanceDate;
      if (kind === 'account') existing.showOnInsights = showOnInsights;
    }
    if (kind === 'pm') existing.creditCard = creditCard;
  } else {
    const maxOrder = Math.max(-1, ...CONFIG_ITEMS.filter(i => i.kind === kind).map(i => i.sortOrder));
    CONFIG_ITEMS.push({ kind, name, color, ccy, assetType, linkedPM, balance, balanceDate, showOnInsights, creditCard, archived: false, sortOrder: maxOrder + 1 });
  }

  if (kind === 'stock' && assetType) {
    STOCK_TYPE[name] = assetType;
  }

  if ((kind === 'account' || kind === 'stock') && balance !== null) {
    const effectiveDate = balanceDate || new Date().toISOString().slice(0, 10);
    rawAccountBalances[name] = { amount: balance, date: effectiveDate, txId: 'config_' + name };
  }
  syncConfigToRawAccountBalances();
  try { localStorage.setItem(LS_CONFIG_KEY, JSON.stringify(CONFIG_ITEMS)); } catch(e) {}
  buildAccountBalances();
  renderAccountBalanceCards();
  closeConfigItemOverlay();
  renderSettingsLists();
  showToast('Saving…', 'loading');
  await saveConfigToServer();
  renderSettingsLists();
  showToast('Saved', 'success');
}

async function toggleArchiveCurrentConfigItem() {
  const kind = document.getElementById('configItemKind').value;
  const origName = document.getElementById('configItemOrigName').value;
  const existing = CONFIG_ITEMS.find(i => i.kind === kind && i.name === origName);
  if (!existing) return;
  if (!existing.archived && !confirm(`Delete "${existing.name}"? Past transactions keep showing it, but it won't appear as a picker option anymore.`)) return;
  existing.archived = !existing.archived;
  closeConfigItemOverlay();
  renderSettingsLists();
  showToast(existing.archived ? 'Deleted' : 'Restored', 'loading');
  await saveConfigToServer();
  renderSettingsLists();
  showToast('Saved', 'success');
}

// ── ACCOUNT PAGE ───────────────────────────────────────────────
async function loadAccountUsageInfo() {
  const ssId = DataStore.getSpreadsheetId();
  if (!ssId) return;
  document.getElementById('acctInfoSize').textContent = 'Loading…';
  document.getElementById('acctInfoModified').textContent = 'Loading…';
  document.getElementById('acctInfoOpexCount').textContent = 'Loading…';
  document.getElementById('acctInfoInvestCount').textContent = 'Loading…';
  // Always show build info immediately (no async needed)
  document.getElementById('acctInfoBuild').textContent = `${APP_VERSION} (${APP_BUILD})`;
  try {
    const meta = await SheetsClient.getFileMeta(ssId);
    const sizeKb = meta.size ? Math.round(Number(meta.size) / 1024) : null;
    document.getElementById('acctInfoSize').textContent = sizeKb != null ? `${sizeKb} KB` : '—';
    document.getElementById('acctInfoModified').textContent = meta.modifiedTime ? new Date(meta.modifiedTime).toLocaleString() : '—';
  } catch (e) {
    document.getElementById('acctInfoSize').textContent = '—';
    document.getElementById('acctInfoModified').textContent = '—';
  }
  try {
    const [opexRes, investRes] = await Promise.all([
      SheetsClient.getValues(ssId, 'Opex!K2:K'),
      SheetsClient.getValues(ssId, 'Invest!A2:A'),
    ]);
    document.getElementById('acctInfoOpexCount').textContent = String((opexRes.values || []).length);
    document.getElementById('acctInfoInvestCount').textContent = String((investRes.values || []).length);
  } catch (e) {
    document.getElementById('acctInfoOpexCount').textContent = '—';
    document.getElementById('acctInfoInvestCount').textContent = '—';
  }
}

function openDeleteAccountConfirm1() {
  document.getElementById('deleteAccountModal1').classList.add('open');
}
function closeDeleteAccountModal1() {
  document.getElementById('deleteAccountModal1').classList.remove('open');
}
function openDeleteAccountConfirm2() {
  closeDeleteAccountModal1();
  document.getElementById('deleteAccountConfirmInput').value = '';
  document.getElementById('deleteAccountFinalBtn').disabled = true;
  document.getElementById('deleteAccountFinalBtn').style.opacity = '0.4';
  document.getElementById('deleteAccountModal2').classList.add('open');
}
function closeDeleteAccountModal2() {
  document.getElementById('deleteAccountModal2').classList.remove('open');
}
function _onDeleteAccountConfirmInput() {
  const ok = document.getElementById('deleteAccountConfirmInput').value.trim() === 'DELETE';
  const btn = document.getElementById('deleteAccountFinalBtn');
  btn.disabled = !ok;
  btn.style.opacity = ok ? '1' : '0.4';
}
async function deleteAccountAndData() {
  const btn = document.getElementById('deleteAccountFinalBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const ssId = DataStore.getSpreadsheetId();
    if (ssId) await SheetsClient.trashFile(ssId);
  } catch (e) {
    console.error('[account] trash failed', e);
  }
  Auth.signOut();
}


// ── GOALS ─────────────────────────────────────────────────────
let GOALS = [];
let goalsEditId = null; // sheet rowNum of the goal being edited, or null for new

let _goalsFetchSeq = 0;
async function fetchGoals() {
  const seq = ++_goalsFetchSeq;
  const container = document.getElementById('goalsListContainer');
  if (container) container.innerHTML = '<div class="chart-loading">Loading…</div>';
  try {
    const res = await fetch(apiGet('type=goals'), { method: 'GET' });
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
    container.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--text2);font-size:14px;line-height:1.6">No goals yet.<br>Tap <strong style="color:var(--accent)">+</strong> to add your first goal.</div>';
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
      <input type="checkbox" value="${asset}" ${selectedSources.includes(asset) ? 'checked' : ''}>
      <span style="font-size:14px">${asset}</span>
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
function switchTabFromMore(tab) {
  switchTab(tab, null);
  document.getElementById('nav-more').classList.remove('active');
  document.getElementById('nav-more').classList.add('sub-active');
}

function openFABAction() {
  if (document.getElementById('page-goals').classList.contains('active')) {
    openGoalsOverlay('new', null);
  } else if (document.getElementById('page-recurring').classList.contains('active')) {
    openAddRecurring();
  } else {
    openInputOverlay();
  }
}

// Fetch current month and return true if data changed vs cache
async function fetchCurrentMonthFresh() {
  const mySeq = ++curMonthFetchSeq;
  const now = Date.now();
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth() + 1;
  const cacheKey = curMonthCacheKey(y, m);
  try {
    const res = await fetch(apiGet(`type=month&y=${y}&m=${m}`), { method: 'GET' });
    const j = await res.json();
    if (j.status === 'ok' && Array.isArray(j.rows)) {
      const prev = localStorage.getItem(cacheKey);
      const next = JSON.stringify(j.rows);
      const changed = prev !== next;
      localStorage.setItem(cacheKey, next);
      curMonthLastFetch = now;
      _reconcileUnsyncedWithSheet(j.rows, y, m);
      if (mySeq !== curMonthFetchSeq) {
        dupDebugLog('fetchCurrentMonthFresh:staleFetchDiscarded', { y, m, mySeq, curMonthFetchSeq });
        return changed;
      }
      _applyCurrentMonthRows(j.rows, y, m);
      return changed;
    }
    return false;
  } catch(e) {
    console.warn('fetchCurrentMonthFresh failed:', e.message);
    return false;
  }
}
window.addEventListener('error', e => console.error('[runtime]', e.message, e.filename + ':' + e.lineno));

// ── RECURRING TRANSACTIONS ────────────────────────────────────────────────────

function loadRecurring() {
  return RECURRING_RULES;
}
function saveRecurring(rules) {
  RECURRING_RULES = rules;
  localStorage.setItem('notapub_recurring_v1', JSON.stringify(rules));
  _recurringDirty = true;
  localStorage.setItem('notapub_recurring_dirty', 'true');
  _pushRecurringToServer(rules);
}

async function fetchRecurring() {
  try {
    const res = await fetch(apiGet('type=recurring'), { method: 'GET' });
    const j = await res.json();
    if (j.status === 'ok' && Array.isArray(j.rules)) {
      if (j.rules.length > 0) {
        // Server has data — merge rather than overwrite so that local-ahead fields
        // are preserved when the debounced push hadn't fired before app closed.
        // Use nota_recurring_pending to identify which rules have unsync'd edits.
        const localById = Object.fromEntries(RECURRING_RULES.map(r => [r.id, r]));
        const serverIds = new Set(j.rules.map(r => r.id));

        // Build set of dirty rule IDs from localStorage (persisted across reloads)
        const pendingRules = JSON.parse(localStorage.getItem('notapub_recurring_pending') || '[]');
        const dirtyIds = new Set(pendingRules.map(r => r.id));

        // Build set of rule IDs that exist in pending (to detect deleted rules)
        // If a rule was deleted locally and pushed, the new pending won't include it
        const pendingIds = new Set(pendingRules.map(r => r.id));

        // Merge: for any rule in dirtyIds, preserve ALL local fields (full override)
        // Otherwise take server values but preserve critical fields like lastFired
        const serverRules = j.rules.map(r => {
          if (dirtyIds.has(r.id)) {
            // This rule has unsync'd edits — keep the full local version
            const local = localById[r.id];
            return local;
          }
          // Not dirty — take server but preserve local values that might be more recent
          const local = localById[r.id];
          return {
            ...r,
            // Preserve local endMonth: if local has a value, prefer it (may be in-flight edit)
            // If local and server both empty, stay empty. If server has it and local doesn't, use server.
            endMonth: (local?.endMonth) ? local.endMonth : (r.endMonth || null),
            lastFired: (local?.lastFired && local.lastFired > (r.lastFired || ''))
              ? local.lastFired
              : (r.lastFired || '')
          };
        });
        // Keep any local rule the server doesn't know about yet
        const localOnlyRules = RECURRING_RULES.filter(r => !serverIds.has(r.id));
        const merged = [...serverRules, ...localOnlyRules];

        // Filter out any rules the user explicitly deleted (tombstoned), so a delete that
        // hasn't pushed yet doesn't get resurrected by this merge. Deliberately NOT using
        // "absent from local RECURRING_RULES" as the signal — local can be empty/incomplete
        // for reasons other than a delete (e.g. iOS PWA localStorage eviction), and treating
        // that as "delete everything" is what wiped the sheet. See _recurringDeletedIds above.
        const tombstoned = new Set(_recurringDeletedIds.map(t => t.id));
        const finalRules = merged.filter(r => !tombstoned.has(r.id));

        RECURRING_RULES = finalRules;
        localStorage.setItem('notapub_recurring_v1', JSON.stringify(finalRules));
        // Don't clear _recurringDirty here — only _doRecurringPush success should clear it.
        // Clearing it here would lose the signal that a local save is still in flight.
        // Push unsynced local rules to server immediately
        if (localOnlyRules.length > 0) {
          _pushRecurringToServer(merged);
        }
      } else if (RECURRING_RULES.length > 0 && !_recurringDirty) {
        // Server is empty but we have local rules → migrate them immediately
        _recurringDirty = true;
        localStorage.setItem('notapub_recurring_dirty', 'true');
        _pushRecurringToServer(RECURRING_RULES);
      }
    }
  } catch(e) { /* offline — silently fall through */ }
}

let _recurringPushTimer = null;
function _pushRecurringToServer(rules) {
  clearTimeout(_recurringPushTimer);
  _recurringPushTimer = setTimeout(() => _doRecurringPush(rules), 1000);
}

async function _doRecurringPush(rules) {
  // Save pending state immediately, before server call (fallback if app closes before response)
  localStorage.setItem('notapub_recurring_pending', JSON.stringify(rules));
  localStorage.setItem('notapub_recurring_pending_ts', String(Date.now()));
  // clientTs lets the server reject this write if a newer one already landed —
  // fetchWithTimeout's Promise.race does NOT cancel the underlying fetch, so an
  // abandoned (client-timed-out) request can still complete server-side minutes
  // later and silently overwrite newer data without this guard.
  const clientTs = Date.now();
  try {
    // allowEmpty confirms to the server this is a deliberate "delete the last rule" push,
    // not an accidental empty array from a client-side bug — the server refuses to wipe an
    // already-populated sheet with an empty saveAll unless this is set (appsscript_v40).
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: apiBody({ type: 'recurring', action: 'saveAll', rules, clientTs, allowEmpty: rules.length === 0 })
    });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      _recurringDirty = false;
      localStorage.removeItem('notapub_recurring_dirty');
      // CRITICAL: Keep nota_recurring_pending for 3+ seconds after success to prevent
      // a race condition where fetchRecurring() is called before server fully updates,
      // overwrites local edits with stale data, then second push sends incomplete data.
      // This timeout ensures merge logic can use dirtyIds to protect local-ahead edits.
      setTimeout(() => {
        localStorage.removeItem('notapub_recurring_pending');
        localStorage.removeItem('notapub_recurring_pending_ts');
      }, 3000);
    }
  } catch(e) {
    // Keep nota_recurring_pending for retry; it was already saved above
  }
}

function retryPendingRecurring() {
  const pending = localStorage.getItem('notapub_recurring_pending');
  if (!pending && !localStorage.getItem('notapub_recurring_dirty')) return;

  // Always push current RECURRING_RULES (not the stale snapshot in pending).
  // Stale pending data can hold an old lastFired that would overwrite the
  // more-recent value already in memory, re-triggering the recurring prompt.
  if (RECURRING_RULES.length > 0) {
    _pushRecurringToServer(RECURRING_RULES);
  } else {
    // Edge case: dirty flag set but no rules to push — clear the flag
    _recurringDirty = false;
    localStorage.removeItem('notapub_recurring_dirty');
    localStorage.removeItem('notapub_recurring_pending');
  }
}
function curMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function _initRecurringEndYears() {
  const curY = new Date().getFullYear();
  const opts = '<option value="">Year</option>' +
    Array.from({length: 11}, (_, i) => {
      const y = curY + i;
      return `<option value="${y}">${y}</option>`;
    }).join('');
  document.getElementById('inputRecurringEndYear').innerHTML = opts;
  document.getElementById('recurringEditEndYear').innerHTML = opts;
}

function _autoSetEndYear(yearId) {
  const yEl = document.getElementById(yearId);
  if (!yEl.value) yEl.value = String(new Date().getFullYear());
}

function _getEndMonthValue(monthId, yearId) {
  const m = document.getElementById(monthId).value;
  const y = document.getElementById(yearId).value;
  if (!m || !y) return null;
  return `${y}-${m}`;
}

function _setEndMonthValue(monthId, yearId, value) {
  const mEl = document.getElementById(monthId);
  const yEl = document.getElementById(yearId);
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    const [year, month] = value.split('-');
    // Add the year option on-the-fly if it's not in the generated list (e.g. a past year)
    if (!yEl.querySelector(`option[value="${year}"]`)) {
      const opt = document.createElement('option');
      opt.value = year; opt.textContent = year;
      yEl.appendChild(opt);
    }
    mEl.value = month;
    yEl.value = year;
  } else {
    mEl.value = '';
    yEl.value = '';
  }
}

const _MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function _formatEndMonth(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return `${_MONTH_NAMES[parseInt(m, 10) - 1]} ${y}`;
}
function ordinalSuffix(n) {
  const s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v-20)%10] || s[v] || s[0]);
}
function getRecurringDue() {
  const today = new Date();
  const mk = curMonthKey();
  return loadRecurring().filter(r =>
    r.active &&
    r.dayOfMonth <= today.getDate() &&
    r.lastFired !== mk &&
    (!r.endMonth || r.endMonth >= mk)
  );
}

function getRecurringProjections(year, month) {
  const rules = loadRecurring();
  const mk = `${year}-${String(month).padStart(2,'0')}`;
  return rules
    .filter(r => r.active && (!r.endMonth || r.endMonth >= mk))
    .map(r => ({
      id: `proj_${r.id}`,
      ruleId: r.id,
      date: `${year}-${String(month).padStart(2,'0')}-${String(r.dayOfMonth).padStart(2,'0')}`,
      tx: getInstallmentName(r, mk),
      amount: r.amount,
      category: r.cat,
      pm: r.pm,
      notes: r.notes || '',
      type: r.type,
      projected: true,
    }));
}

// Toggle the day-of-month and end-date rows in the input form
function toggleRecurringRow() {
  const on = document.getElementById('inputRecurring').checked;
  document.getElementById('recurringDayRow').style.display = on ? '' : 'none';
  document.getElementById('recurringEndRow').style.display = on ? '' : 'none';
  if (on) {
    const raw = document.getElementById('inputDateRaw').value;
    const day = raw ? parseInt(raw.split('-')[2]) : new Date().getDate();
    document.getElementById('inputRecurringDay').value = day;
  } else {
    document.getElementById('inputRecurringEndMonth').value = '';
    document.getElementById('inputRecurringEndYear').value = '';
  }
}

// ── RECURRING PROMPT (on app load) ───────────────────────────────────────────

let _pendingRecurring = [];

function checkRecurringOnLoad() {
  // Guard: don't re-show a popup for a rule already prompted this month — scoped PER RULE
  // (not one blanket per-month flag) so a rule that becomes due on a later day still gets
  // its own popup even if an earlier rule already triggered one this month. A single
  // blanket flag silently starved later-due rules of ever being offered at all (root cause
  // of the "shows on calendar, never synced" bug).
  // (iOS PWA does a full page reload on every open, so this must survive that; Safari uses
  // BFCache so this function only runs once per session there.)
  const mk = curMonthKey();
  const promptedKey = 'notapub_rprompt_ids_' + mk;
  let promptedIds = [];
  try { promptedIds = JSON.parse(localStorage.getItem(promptedKey) || '[]'); } catch(e) {}
  const promptedSet = new Set(promptedIds.map(String));

  const due = getRecurringDue().filter(r => !promptedSet.has(String(r.id)));
  if (!due.length) return;
  _pendingRecurring = due;

  // Record these rule ids as "prompted" immediately — survives app close without any
  // interaction — but do NOT stamp lastFired here. lastFired only changes once the user
  // actually confirms Add or an explicit Skip (addSelectedRecurring / dismissRecurringPrompt),
  // so if the app is killed between "popup shown" and "user taps Add" (iOS PWA), the rule
  // stays correctly due and gets prompted again on the next open instead of silently
  // vanishing into an unsynced, permanently-projected calendar entry.
  due.forEach(r => promptedSet.add(String(r.id)));
  localStorage.setItem(promptedKey, JSON.stringify([...promptedSet]));
  // Clean up stale prompt-tracking keys from previous months (old blanket-flag format too)
  Object.keys(localStorage)
    .filter(k => k.startsWith('notapub_rprompt_') && k !== promptedKey)
    .forEach(k => localStorage.removeItem(k));

  _renderRecurringPrompt();
  document.getElementById('recurringPrompt').classList.add('open');
}

function _renderRecurringPrompt() {
  const n = _pendingRecurring.length;
  document.getElementById('recurringPromptSubtitle').textContent =
    `${n} transaction${n > 1 ? 's' : ''} ready to add`;
  document.getElementById('recurringAddBtn').textContent = `Add ${n} Transaction${n > 1 ? 's' : ''}`;
  const list = document.getElementById('recurringPromptList');
  list.innerHTML = _pendingRecurring.map((r, i) => `
    <label class="recurring-prompt-item">
      <input class="recurring-prompt-check" type="checkbox" data-ridx="${i}" checked onchange="_updateRecurringPromptBtn()">
      <div class="recurring-prompt-info">
        <div class="recurring-prompt-tx">${esc(getInstallmentName(r, curMonthKey()))}</div>
        <div class="recurring-prompt-meta">${esc(r.cat)} · ${esc(r.pm)}</div>
      </div>
      <div class="recurring-prompt-amt ${r.type === 'income' ? 'income' : ''}" style="color:${r.type==='income'?'var(--green)':'var(--text)'}">${r.type === 'income' ? '+' : '-'}${fRp(r.amount)}</div>
    </label>`).join('');
}

function _updateRecurringPromptBtn() {
  const n = document.querySelectorAll('#recurringPromptList input:checked').length;
  document.getElementById('recurringAddBtn').textContent = `Add ${n} Transaction${n !== 1 ? 's' : ''}`;
}

// Shared by addSelectedRecurring() (bulk, from the due-popup) and handleProjectedAddSync()
// (single, from tapping a still-projected calendar entry and choosing "Add & Sync") — builds
// the local optimistic transaction and pushes it to the sheet the same way submitOpex() does.
function _addAndSyncRecurringRule(r) {
  const today = todayISO();
  const txName = getInstallmentName(r, curMonthKey());
  const rec = { id: Date.now() + Math.random(), date: today, tx: txName, amount: r.amount,
    category: r.cat, pm: r.pm, notes: r.notes || '', type: r.type, synced: false };
  txHistory.unshift(rec);
  queue.push({...rec, action: r.type});
  // Mirror submitOpex: mark synced + write cache AFTER server confirms, not before.
  // Writing the cache before sync causes a double entry on iOS PWA — on reload,
  // loadHistData() re-applies the cache into HIST.opex while txHistory still has
  // synced:false, so the calendar shows the transaction from both sources.
  return syncOpex(rec).then(ok => {
    if (!ok) return;
    queue = queue.filter(q => q.id !== rec.id);
    txHistory = txHistory.map(h => h.id === rec.id ? {...h, synced: true} : h);
    const cacheKey = curMonthCacheKey();
    const dateParts = rec.date.split('-');
    const optimisticRow = { d: parseInt(dateParts[2]), cat: rec.category, tx: rec.tx, pm: rec.pm,
      ...(rec.notes ? {notes: rec.notes} : {}),
      ...(rec.type === 'income' ? {inc: rec.amount} : {exp: rec.amount}) };
    const cachedRows = JSON.parse(localStorage.getItem(cacheKey) || '[]');
    cachedRows.push(optimisticRow);
    localStorage.setItem(cacheKey, JSON.stringify(cachedRows));
    saveLocal();
  });
}

// Tapping a still-"Projected" recurring entry in the calendar day panel — recovery path for
// when the once-a-month due-popup (checkRecurringOnLoad) already fired for an earlier rule
// this month and so never offered this one. Opens a choice modal (Add & Sync vs Skip) instead
// of immediately syncing, since the user may have already recorded the occurrence another way
// (in which case "Add & Sync" would create a duplicate sheet row — see skip path below).
let _projectedActionRuleId = null;

function openProjectedActionModal(ruleId) {
  const rules = loadRecurring();
  const r = rules.find(x => String(x.id) === String(ruleId));
  if (!r) return;
  _projectedActionRuleId = ruleId;
  document.getElementById('projectedActionSubtitle').textContent =
    `"${r.tx}" (${fRp(r.amount)}) — add & sync to Google Sheets, or skip this occurrence if you've already recorded it another way.`;
  document.getElementById('projectedActionModal').classList.add('open');
}

function closeProjectedActionModal() {
  document.getElementById('projectedActionModal').classList.remove('open');
  _projectedActionRuleId = null;
}

function handleProjectedAddSync() {
  const ruleId = _projectedActionRuleId;
  closeProjectedActionModal();
  if (isSyncing || !ruleId) return;
  const rules = loadRecurring();
  const idx = rules.findIndex(x => String(x.id) === String(ruleId));
  if (idx === -1) return;
  const r = rules[idx];
  isSyncing = true;
  rules[idx].lastFired = curMonthKey();
  saveRecurring(rules);
  showToast('Adding recurring transaction…', 'loading', 0);
  _addAndSyncRecurringRule(r).then(() => {
    isSyncing = false;
    saveLocal(); updateStatus();
    showToast('Recurring transaction added ✓', 'success');
    calInited = false;
    if (document.getElementById('page-home').classList.contains('active')) initCalendar();
    fetchCurrentMonth(true).then(() => {
      calInited = false;
      if (document.getElementById('page-home').classList.contains('active')) initCalendar();
    });
  });
}

// Clears a stuck "Projected" badge for one occurrence WITHOUT creating a transaction —
// for when the user already recorded it another way and "Add & Sync" would duplicate the
// sheet row. Mirrors dismissRecurringPrompt()'s lastFired stamp, but scoped to a single rule
// from the calendar day panel instead of the bulk popup.
function handleProjectedSkip() {
  const ruleId = _projectedActionRuleId;
  closeProjectedActionModal();
  if (!ruleId) return;
  const rules = loadRecurring();
  const idx = rules.findIndex(x => String(x.id) === String(ruleId));
  if (idx === -1) return;
  rules[idx].lastFired = curMonthKey();
  saveRecurring(rules);
  showToast('Occurrence skipped', 'success');
  calInited = false;
  if (document.getElementById('page-home').classList.contains('active')) {
    initCalendar();
    calRefreshOpenDayPanel();
  }
}

function addSelectedRecurring() {
  // Re-entrancy guard (mirrors submitOpex's isSyncing check): without this, a double-fired
  // tap/click on #recurringAddBtn (no touchstart/touchend debounce here, unlike .cal-tx-item)
  // creates two independent txHistory/queue entries with different ids for the same logical
  // transaction — if only one of the two syncs lands, the other renders as a permanent
  // duplicate that the calGetMonthData signature dedup correctly declines to hide (it can't
  // tell an accidental double-add from a genuinely different 3rd transaction).
  if (isSyncing) return;
  isSyncing = true;
  const addBtn = document.getElementById('recurringAddBtn');
  if (addBtn) addBtn.disabled = true;
  const checked = [...document.querySelectorAll('#recurringPromptList input[type=checkbox]:checked')];
  if (!checked.length) {
    isSyncing = false;
    if (addBtn) addBtn.disabled = false;
    dismissRecurringPrompt();
    return;
  }
  const rules = loadRecurring();
  const mk = curMonthKey();
  const syncPromises = [];
  checked.forEach(cb => {
    const r = _pendingRecurring[+cb.dataset.ridx];
    if (!r) return;
    // Mark rule fired
    const idx = rules.findIndex(x => x.id === r.id);
    if (idx !== -1) rules[idx].lastFired = mk;
    syncPromises.push(_addAndSyncRecurringRule(r));
  });
  saveLocal(); updateStatus(); saveRecurring(rules);
  dismissRecurringPrompt();
  const n = checked.length;
  showToast(`${n} recurring transaction${n !== 1 ? 's' : ''} added ✓`, 'success');
  // Refresh calendar after all syncs complete so the server already has the rows
  // when fetchCurrentMonth(true) requests them — HIST.opex and txHistory (synced=true)
  // are then consistent and no duplicate appears.
  Promise.all(syncPromises).then(() => {
    isSyncing = false;
    if (addBtn) addBtn.disabled = false;
    calInited = false;
    if (document.getElementById('page-home').classList.contains('active')) initCalendar();
    fetchCurrentMonth(true).then(() => {
      calInited = false;
      if (document.getElementById('page-home').classList.contains('active')) initCalendar();
    });
  });
}

function dismissRecurringPrompt() {
  document.getElementById('recurringPrompt').classList.remove('open');
  // Mark every pending rule as handled for this month so the prompt does not
  // re-appear on the next app open (whether the user added or skipped).
  const mk = curMonthKey();
  const rules = loadRecurring();
  let changed = false;
  (_pendingRecurring || []).forEach(r => {
    const idx = rules.findIndex(x => x.id === r.id);
    if (idx !== -1 && rules[idx].lastFired !== mk) {
      rules[idx].lastFired = mk;
      changed = true;
    }
  });
  if (changed) saveRecurring(rules);
}

// ── RECURRING LIST PAGE ───────────────────────────────────────────────────────

function renderRecurringList() {
  const rules = loadRecurring();
  const container = document.getElementById('recurringListContainer');
  if (!rules.length) {
    container.innerHTML = '<p style="color:var(--text2);text-align:center;padding:48px 0 24px;font-size:14px">No recurring transactions yet.<br>Tap + to add one.</p>';
    return;
  }
  const expenses = rules.filter(r => r.type === 'expense');
  const income   = rules.filter(r => r.type === 'income');
  let html = '';
  if (expenses.length) {
    html += `<div class="recurring-section-label">Expenses</div>`;
    html += expenses.map(r => _recurringCard(r)).join('');
  }
  if (income.length) {
    html += `<div class="recurring-section-label">Income</div>`;
    html += income.map(r => _recurringCard(r)).join('');
  }
  container.innerHTML = html;
}

function _recurringCard(r) {
  const isInc = r.type === 'income';
  const endLabel = r.endMonth ? `<div class="recurring-card-day" style="color:var(--text2)">Until ${_formatEndMonth(r.endMonth)}</div>` : '';
  return `<div class="recurring-card">
    <div class="recurring-card-dot ${isInc ? 'income' : 'expense'}"></div>
    <div class="recurring-card-info">
      <div class="recurring-card-tx">${esc(r.tx)}</div>
      <div class="recurring-card-meta">${esc(r.cat)} · ${esc(r.pm)}</div>
      <div class="recurring-card-day">Every ${ordinalSuffix(r.dayOfMonth)} of the month</div>
      ${endLabel}
    </div>
    <div class="recurring-card-right">
      <div class="recurring-card-amt ${isInc ? 'income' : 'expense'}">${isInc ? '+' : '-'}${fRp(r.amount)}</div>
      <div class="recurring-card-actions">
        <button class="recurring-card-btn" onclick="openRecurringEdit(${r.id})" title="Edit">✏️</button>
        <button class="recurring-card-btn" onclick="deleteRecurringRule(${r.id})" title="Delete" style="color:var(--red)">🗑</button>
      </div>
    </div>
  </div>`;
}

function openAddRecurring() {
  openInputOverlay();
  // Pre-toggle recurring ON after overlay opens
  setTimeout(() => {
    const cb = document.getElementById('inputRecurring');
    if (cb && !cb.checked) { cb.checked = true; toggleRecurringRow(); }
  }, 380);
}

// ── RECURRING EDIT MODAL ──────────────────────────────────────────────────────

let _recurringEditType = 'expense';

function openRecurringEdit(id) {
  const rules = loadRecurring();
  const r = rules.find(x => x.id === id);
  if (!r) return;
  document.getElementById('recurringEditId').value = id;
  _recurringEditType = r.type;
  _applyRecurringEditType(r.type);
  document.getElementById('recurringEditTx').value     = r.tx;
  document.getElementById('recurringEditCat').value    = r.cat;
  document.getElementById('recurringEditAmount').value = formatGroupedAmt(r.amount);
  document.getElementById('recurringEditPm').value     = r.pm;
  document.getElementById('recurringEditNotes').value  = r.notes || '';
  document.getElementById('recurringEditDay').value    = r.dayOfMonth;
  _setEndMonthValue('recurringEditEndMonth', 'recurringEditEndYear', r.endMonth || null);
  document.getElementById('recurringEditModal').classList.add('open');
}

function setRecurringEditType(type) {
  _recurringEditType = type;
  _applyRecurringEditType(type);
}

function _applyRecurringEditType(type) {
  const expBtn = document.getElementById('recurringEditExpBtn');
  const incBtn = document.getElementById('recurringEditIncBtn');
  expBtn.classList.toggle('active', type === 'expense');
  incBtn.classList.toggle('active', type === 'income');
}

function saveRecurringEdit() {
  const id = parseInt(document.getElementById('recurringEditId').value);
  const tx  = sanitizeInput(document.getElementById('recurringEditTx').value, 100).trim();
  const cat = sanitizeInput(document.getElementById('recurringEditCat').value, 50).trim();
  const amt = parseAmt('recurringEditAmount');
  const pm  = sanitizeInput(document.getElementById('recurringEditPm').value, 50).trim();
  const notes = sanitizeInput(document.getElementById('recurringEditNotes').value, 200);
  const day = parseInt(document.getElementById('recurringEditDay').value) || 0;
  if (!tx || !cat || !amt || !pm || day < 1 || day > 31) {
    showToast('All fields required (day 1–31)', 'error'); return;
  }
  const rules = loadRecurring();
  const idx = rules.findIndex(x => x.id === id);
  if (idx === -1) { closeRecurringEditModal(); return; }
  const endMonth = _getEndMonthValue('recurringEditEndMonth', 'recurringEditEndYear');
  rules[idx] = { ...rules[idx], type: _recurringEditType, tx, cat, amount: amt, pm, notes, dayOfMonth: day, endMonth: endMonth || null };
  saveRecurring(rules);
  closeRecurringEditModal();
  renderRecurringList();
  showToast('Recurring rule updated', 'success');
}

function closeRecurringEditModal() {
  document.getElementById('recurringEditModal').classList.remove('open');
}

function deleteRecurringRule(id) {
  if (!confirm('Delete this recurring rule?')) return;
  _tombstoneRecurringId(id);
  const rules = loadRecurring().filter(x => x.id !== id);
  saveRecurring(rules);
  // Note: DO NOT clear nota_recurring_pending here. The new pending (without the deleted rule)
  // will be set when _doRecurringPush() runs. Clearing early creates a race condition:
  // if user closes app before debounce fires (within 1s), there's no pending to indicate deletion.
  // Instead, rely on the merge logic to detect deleted rules via the pendingIds set.
  renderRecurringList();
  showToast('Recurring rule deleted', 'success');
}