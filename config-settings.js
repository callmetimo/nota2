// Nota — user-editable configuration: categories, payment methods, assets and accounts.
//
// Split out of ui-settings.js, which had grown to 2,074 lines covering four unrelated
// features. Code is unchanged; only its file changed.
//
// This file owns the shared config state the other three read — CONFIG_ITEMS,
// rawAccountBalances and accountBalances — and runs the load-time hydration at the
// bottom of the first section, so it MUST stay first of the four in index.html.
// That hydration calls only applyConfigToGlobals() and syncConfigToRawAccountBalances(),
// both defined here, plus globals from the inline script, which has already run.

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
    // Was a raw fetch() — same hang risk as the others fixed alongside this one.
    const res = await fetchWithTimeout(apiGet('type=config'), { method: 'GET' });
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

  const buildKind = (kind) => {
  const items = CONFIG_ITEMS.filter(i => i.kind === kind).sort((a,b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  const active = items.filter(i => !i.archived);
  const archived = items.filter(i => i.archived);
  const showArchived = settingsShowArchived[kind];

  const rowHtml = it => {
    let metaStr = '';
    let accountCheckHtml = '';
    if (kind === 'pm' && !it.archived) {
      const isCc = !!it.creditCard;
      if (isCc) {
        let ccLabelParts = ['Credit card'];
        if (it.billingDate) ccLabelParts.push(`day ${it.billingDate}`);
        if (it.creditLimit) {
          const limitFmt = Number(it.creditLimit) >= 1000000 ? (Number(it.creditLimit) / 1000000) + 'M' : Number(it.creditLimit).toLocaleString();
          ccLabelParts.push(`limit ${limitFmt}`);
        }
        metaStr = ccLabelParts.join(' · ');
      }
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

  return listHtml;
  };

  // Wide layout (tablet/desktop landscape): all four lists side by side, no tab toggle
  if (document.documentElement.classList.contains('wide')) {
    container.innerHTML = `<div class="settings-wide-grid">${kinds.map(k => `<div class="settings-wide-col">${buildKind(k)}</div>`).join('')}</div>`;
  } else {
    container.innerHTML = toggleHtml + buildKind(currentSettingsTab);
  }
}

async function togglePMCreditCard(pmName, checked) {
  const item = CONFIG_ITEMS.find(i => i.kind === 'pm' && i.name === pmName);
  if (!item) return;
  item.creditCard = checked;
  if (!checked) {
    item.billingDate = 0;
    item.creditLimit = 0;
  }
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
  const showColor = (kind === 'category' || kind === 'account');
  const showAsset = (kind === 'stock' || kind === 'account');
  const showCcy   = kind === 'account';
  const showPM    = kind === 'account';
  const showBal   = (kind === 'account' || kind === 'stock');

  document.getElementById('configItemColorGroup').style.display = showColor ? 'block' : 'none';
  document.getElementById('configItemAssetTypeGroup').style.display = showAsset ? 'block' : 'none';

  const row1 = document.getElementById('configItemRow1');
  if (row1) {
    if (showColor && showAsset) {
      row1.style.display = 'grid';
      row1.style.gridTemplateColumns = '1fr 1fr';
    } else if (showColor || showAsset) {
      row1.style.display = 'block';
    } else {
      row1.style.display = 'none';
    }
  }

  document.getElementById('configItemCcyGroup').style.display = showCcy ? 'block' : 'none';
  document.getElementById('configItemLinkedPMGroup').style.display = showPM ? 'block' : 'none';

  const row2 = document.getElementById('configItemRow2');
  if (row2) {
    if (showCcy && showPM) {
      row2.style.display = 'grid';
      row2.style.gridTemplateColumns = '1fr 1fr';
    } else if (showCcy || showPM) {
      row2.style.display = 'block';
    } else {
      row2.style.display = 'none';
    }
  }

  if (document.getElementById('configItemBalanceGroup')) document.getElementById('configItemBalanceGroup').style.display = showBal ? 'block' : 'none';
  if (document.getElementById('configItemBalanceDateGroup')) document.getElementById('configItemBalanceDateGroup').style.display = showBal ? 'block' : 'none';

  const row3 = document.getElementById('configItemRow3');
  if (row3) {
    if (showBal && document.getElementById('configItemBalanceGroup') && document.getElementById('configItemBalanceDateGroup')) {
      row3.style.display = 'grid';
      row3.style.gridTemplateColumns = '1fr 1fr';
    } else if (showBal) {
      row3.style.display = 'block';
    } else {
      row3.style.display = 'none';
    }
  }

  if (document.getElementById('configItemShowOnInsightsGroup')) document.getElementById('configItemShowOnInsightsGroup').style.display = kind === 'account' ? 'block' : 'none';
  if (document.getElementById('configItemCreditCardGroup')) document.getElementById('configItemCreditCardGroup').style.display = kind === 'pm' ? 'block' : 'none';
  if (document.getElementById('configItemCCDetailsGroup')) document.getElementById('configItemCCDetailsGroup').style.display = 'none';
}

function onConfigCCChange(checked) {
  const g = document.getElementById('configItemCCDetailsGroup');
  if (g) g.style.display = checked ? 'block' : 'none';
  if (!checked) {
    const bd = document.getElementById('configItemBillingDate');
    const cl = document.getElementById('configItemCreditLimit');
    if (bd) bd.value = '';
    if (cl) cl.value = '';
  }
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
  if (document.getElementById('configItemBillingDate')) {
    document.getElementById('configItemBillingDate').value = (item && item.billingDate) ? item.billingDate : '';
  }
  if (document.getElementById('configItemCreditLimit')) {
    document.getElementById('configItemCreditLimit').value = (item && item.creditLimit) ? formatGroupedAmt(item.creditLimit) : '';
  }
  document.getElementById('configItemArchiveBtn').style.display = item ? 'block' : 'none';
  document.getElementById('configItemArchiveBtn').textContent = item && item.archived ? 'Restore' : 'Delete';
  _configFieldsForKind(kind);
  if (kind === 'pm') onConfigCCChange(!!(item && item.creditCard));
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
  const billingDate = kind === 'pm' ? (parseInt(document.getElementById('configItemBillingDate').value) || 0) : 0;
  const creditLimit = kind === 'pm' ? (parseAmt('configItemCreditLimit') || 0) : 0;

  if (existing) {
    existing.name = name; existing.color = color; existing.assetType = assetType; existing.ccy = ccy; existing.linkedPM = linkedPM;
    if (kind === 'account' || kind === 'stock') {
      existing.balance = balance;
      existing.balanceDate = balanceDate;
      if (kind === 'account') existing.showOnInsights = showOnInsights;
    }
    if (kind === 'pm') {
      existing.creditCard = creditCard;
      existing.billingDate = billingDate;
      existing.creditLimit = creditLimit;
    }
  } else {
    const maxOrder = Math.max(-1, ...CONFIG_ITEMS.filter(i => i.kind === kind).map(i => i.sortOrder));
    CONFIG_ITEMS.push({ kind, name, color, ccy, assetType, linkedPM, balance, balanceDate, showOnInsights, creditCard, billingDate, creditLimit, archived: false, sortOrder: maxOrder + 1 });
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
  showToast('Saved ✓', 'success');
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
  showToast(existing.archived ? 'Deleting…' : 'Restoring…', 'loading');
  await saveConfigToServer();
  renderSettingsLists();
  showToast(existing.archived ? 'Deleted ✓' : 'Restored ✓', 'success');
}

// ── ACCOUNT PAGE ───────────────────────────────────────────────
