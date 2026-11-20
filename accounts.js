// Nota — account balances, the account page, and credit-card billing helpers.
//
// Split out of ui-settings.js, unchanged. Reads CONFIG_ITEMS, rawAccountBalances and
// accountBalances, all declared in config-settings.js, which loads first.
//
// buildAccountBalances() is the single writer of accountBalances, which ui-insights.js
// and data-networth.js both read as the source of truth for what an account holds.

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
      // Strip the account's currency token (e.g. "IDR"/"USD"/any configured ccy) whether
      // it appears as a prefix ("USD CIMB") or a suffix ("CIMB IDR") so a transaction
      // tagged with just the bare bank name ("CIMB") still matches this account for
      // cutoff-delta purposes. Falls back to trying IDR/USD literally when no ccy is
      // available (legacy/plain-string callers).
      const ccyUpper = (acctOrPm.ccy || '').toUpperCase();
      const tokens = /^[A-Z]{3}$/.test(ccyUpper) ? [ccyUpper] : ['IDR', 'USD'];
      const fullLower = acctOrPm.name.toLowerCase().trim();
      tokens.forEach(tok => {
        const stripped = acctOrPm.name
          .replace(new RegExp(`^${tok}\\s+`, 'i'), '')
          .replace(new RegExp(`\\s+${tok}$`, 'i'), '')
          .toLowerCase().trim();
        if (stripped && stripped !== fullLower) names.add(stripped);
      });
    }
  }
  return Array.from(names);
}

function computeAccountCurrentBalance(baseAmount, baseDate, acctOrPm, includeInvestIdr = true) {
  baseAmount = Number(baseAmount) || 0;
  const matchNames = getAccountMatchNames(acctOrPm);
  if (!matchNames.length) return baseAmount;
  let delta = 0;

  // 1. Opex: synced and cached sheet transactions (including transfers)
  (HIST.opex || []).forEach(r => {
    const rPm = String(r.pm || '').toLowerCase().trim();
    if (!matchNames.includes(rPm)) return;
    // A linked Opex 'Investment' row (handleInvest's dual-write for a Buy or Sell) is
    // always IDR-denominated (r.exp/r.inc = totalIdr), even when the funding/receiving
    // account is itself FX/non-IDR. For non-IDR accounts (includeInvestIdr=false, the
    // only other caller of this function) that flow is already correctly counted, in
    // native units, by netLot/computeInvestNetLots in buildAccountBalances — so
    // counting it again here would both double-count it and apply an IDR figure as if
    // it were native currency. IDR accounts still need this row (Step 3 below skips it
    // there instead, via r.opexTxId, since Step 1 is its sole source of truth for that
    // cash flow).
    if (!includeInvestIdr && r.cat === 'Investment') return;
    const rowDate = `${r.y}-${String(r.m + 1).padStart(2,'0')}-${String(r.d).padStart(2,'0')}`;
    if (baseDate && rowDate < baseDate) return;
    if (!includeInvestIdr) {
      // FX/native-currency account: r.inc/r.exp are always IDR (see getFxAvgRate at the
      // entry point) — only a row explicitly tagged with THIS account's own currency
      // (via inputPm's FX conversion) carries a meaningful native amount. A plain IDR
      // row that merely matches this account's bare name (getAccountMatchNames strips
      // the currency token, e.g. "USD CIMB" -> "cimb") must not be treated as native
      // units — that would silently move the account's balance by the wrong currency's
      // magnitude.
      const acctCcy = ((acctOrPm && acctOrPm.ccy) || '').toUpperCase();
      if (!r.ccy || r.ccy.toUpperCase() !== acctCcy) return;
      const nat = Number(r.nativeAmount) || 0;
      delta += (Number(r.inc) || 0) > 0 ? nat : -nat;
      return;
    }
    delta += (Number(r.inc) || 0) - (Number(r.exp) || 0);
  });

  // 2. Local unsynced transactions and transfers from txHistory
  (txHistory || []).forEach(r => {
    if (r.synced) return;
    if (baseDate && r.date && r.date < baseDate) return;

    if (r.type === 'transfer') {
      const fromMatch = matchNames.includes(String(r.fromPm || '').toLowerCase().trim());
      const toMatch = matchNames.includes(String(r.toPm || '').toLowerCase().trim());
      if (!includeInvestIdr) {
        const acctCcy = ((acctOrPm && acctOrPm.ccy) || '').toUpperCase();
        if (!r.ccy || r.ccy.toUpperCase() !== acctCcy) return;
        const nat = Number(r.nativeAmount) || 0;
        if (fromMatch && !toMatch) delta -= nat;
        else if (toMatch && !fromMatch) delta += nat;
        return;
      }
      const amt = Number(r.amount) || 0;
      if (fromMatch && !toMatch) delta -= amt;
      else if (toMatch && !fromMatch) delta += amt;
    } else {
      const rPm = String(r.pm || '').toLowerCase().trim();
      if (!matchNames.includes(rPm)) return;
      if (!includeInvestIdr) {
        const acctCcy = ((acctOrPm && acctOrPm.ccy) || '').toUpperCase();
        if (!r.ccy || r.ccy.toUpperCase() !== acctCcy) return;
        const nat = Number(r.nativeAmount) || 0;
        if (r.type === 'income') delta += nat;
        else if (r.type === 'expense') delta -= nat;
        return;
      }
      const amt = Number(r.amount) || 0;
      if (r.type === 'income') delta += amt;
      else if (r.type === 'expense') delta -= amt;
    }
  });

  // 3. All Invest transactions for IDR accounts (synced and unsynced). FX (non-IDR)
  // accounts already get their Invest depletion via netLot/computeInvestNetLots in
  // buildAccountBalances — r.totalIdr is IDR-denominated, so applying it here too
  // would double-count in mismatched units for a native-currency balance.
  if (includeInvestIdr) {
    const allInvest = typeof getAllInvestRows === 'function' ? getAllInvestRows() : (investHistory || []);
    allInvest.forEach(r => {
      if (baseDate && r.date && r.date < baseDate) return;
      const rAcct = String(r.account || '').toLowerCase().trim();
      if (!matchNames.includes(rAcct)) return;
      // Both Buy and Sell now have their cash-flow counted via Step 1's linked Opex
      // 'Investment' row (handleInvest writes both, linked by opexTxId) — counting it
      // again here would double count. Only rows with no link (unsynced local rows
      // that haven't round-tripped through sync yet) still need this.
      if (r.opexTxId) return;
      if (r.action === 'Buy') delta -= (Number(r.totalIdr) || 0);
      else if (r.action === 'Sell') delta += (Number(r.totalIdr) || 0);
    });
  }

  return baseAmount + delta;
}

function buildAccountBalances() {
  accountBalances = {};
  syncConfigToRawAccountBalances();

  const allInvest = getAllInvestRows();

  CONFIG_ITEMS.filter(i => i.kind === 'account' && !i.archived).forEach(acct => {
    const ccy = (ACCOUNT_CCY[acct.name] || acct.ccy || 'IDR').toUpperCase();
    // getCcyRate() resolves any account currency generically (manual Stock Prices
    // override, then live-fetched fxRates, then a USD/CHF-only last-resort default) —
    // not just USD/CHF, so a newly-added account currency (EUR, AUD, ...) works with
    // no code change once fetchFxRates() has fetched it.
    const rate = getCcyRate(ccy);

    const raw = rawAccountBalances[acct.name];
    const cleanConfigBal = parseConfigBalance(acct.balance);
    let baseAmt = 0;
    let baseDate = acct.balanceDate || todayISO();
    if (cleanConfigBal !== null) {
      // Config (Config sheet columns I/J — the same balance/date shown and edited in
      // Settings → Accounts) is the sole authoritative source now that the legacy
      // Balances-sheet sync has been removed. rawAccountBalances is a local-only cache
      // that can silently go stale — e.g. an earlier "Set Balance" quick-entry dated
      // AFTER this account's current cutoff permanently blocks
      // syncConfigToRawAccountBalances()'s own refresh heuristic (bDate >= cur.date) —
      // so it must never override a balance/date the user can see and edit right here.
      baseAmt = cleanConfigBal;
    } else if (raw && (raw.amount || raw.amount === 0)) {
      baseAmt = Number(raw.amount) || 0;
      if (raw.date) baseDate = raw.date;
    }

    if (ccy !== 'IDR') {
      // netLot must only reflect Invest activity SINCE this account's balance snapshot
      // date — baseAmt already nets out everything up to baseDate, so computing netLot
      // from the FULL unfiltered Invest history (as before) would double-count activity
      // already baked into baseAmt.
      let netLot = 0;
      const investSinceBase = allInvest.filter(r => !baseDate || !r.date || r.date > baseDate);
      const netLotsSinceBase = investSinceBase.length ? computeInvestNetLots(investSinceBase) : null;
      if (netLotsSinceBase) {
        const allKeys = new Set([...Object.keys(netLotsSinceBase.buyLots), ...Object.keys(netLotsSinceBase.sellLots)]);
        allKeys.forEach(s => {
          if (isFxAccountMatch(acct.name, ccy, s)) {
            netLot += (netLotsSinceBase.buyLots[s] || 0) - (netLotsSinceBase.sellLots[s] || 0);
          }
        });
      }

      // Buy/Sell of a DIFFERENTLY-named stock settled through this FX account (e.g.
      // buying/selling QQQ — priced in USD — funded from or credited to a USD
      // account) moves this account's own native cash balance too. netLot above only
      // covers a stock that literally shares this account's name/currency-pair
      // identity (e.g. "USDIDR Pluang Febri"); it never matches a real ticker like
      // "QQQ", so without this, an FX account never reflects a Buy/Sell of anything
      // funded through it unless that trade is itself the dual-purpose FX "stock".
      // Only counted when the traded stock's own price is quoted in this account's
      // currency (so lot×price is already in native units) — otherwise the native
      // amount isn't reliably known and it's left uncounted rather than risk mixing
      // units (r.totalIdr is always IDR, never this account's native currency).
      let fxCashDelta = 0;
      const acctNameLower = acct.name.toLowerCase().trim();
      investSinceBase.forEach(r => {
        if (String(r.account || '').toLowerCase().trim() !== acctNameLower) return;
        if (isFxAccountMatch(acct.name, ccy, r.stock)) return; // already represented via netLot above
        const stockConfig = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === (r.stock || '').toLowerCase());
        const stockType = getAssetTypeForItem(r.stock, stockConfig?.assetType || STOCK_TYPE[r.stock], false);
        const stockCcy = (ACCOUNT_CCY[r.stock] || stockConfig?.ccy || (stockType === 'US Stock' ? 'USD' : '')).toUpperCase();
        if (!stockCcy || stockCcy !== ccy) return;
        const nativeAmt = (Number(r.lot) || 0) * (Number(r.price) || 0);
        if (r.action === 'Buy') fxCashDelta -= nativeAmt;
        else if (r.action === 'Sell') fxCashDelta += nativeAmt;
      });

      const currentNative = computeAccountCurrentBalance(baseAmt, baseDate, acct, false);
      const totalNative = currentNative + netLot + fxCashDelta;

      accountBalances[acct.name] = { amount: totalNative * rate, nativeAmount: totalNative, ccy };
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
  let pmToFilter = null;
  if (account) {
    if (account.linkedPM) {
      const exactPm = (allPMs || []).find(p => p.toLowerCase() === account.linkedPM.toLowerCase());
      pmToFilter = exactPm || account.linkedPM;
    } else {
      const exactPm = (allPMs || []).find(p => p.toLowerCase() === account.name.toLowerCase());
      pmToFilter = exactPm || account.name;
    }
  }
  // A card that belongs to a CC group is tracked on the CC Usage page, not the Search monitor.
  const ccGroup = (pmToFilter && typeof ccGroupForPM === 'function') ? ccGroupForPM(pmToFilter) : null;
  if (ccGroup) {
    ccUsageSelect(ccGroup.id);
    switchTabFromMore('ccusage');
    return;
  }
  ccMonitorPmFilter = pmToFilter ? [pmToFilter] : [];
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
  const dateVal = (item && item.balanceDate) ? item.balanceDate : (raw ? raw.date : todayISO());
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

    // Also persist to Config sheet columns I (balance) and J (balanceDate)
    await saveConfigToServer();

    showToast('Saved ✓', 'success');
  } catch(e) {
    showToast('Could not save: ' + e.message, 'error');
  }
}


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
  // The spreadsheet is already in the trash and the user typed DELETE to get here, so
  // skip signOut's unsynced-transactions warning — there is no sheet left to sync to.
  Auth.signOut({ skipPendingWarning: true });
}


// ── GOALS ─────────────────────────────────────────────────────

function getCCBillingDate(pmName) {
  if (!pmName) return 0;
  const item = CONFIG_ITEMS.find(i => i.kind === 'pm' && i.name === pmName);
  return (item && item.creditCard && item.billingDate) ? Number(item.billingDate) : 0;
}

function applyBillingCycle(r) {
  const billingDate = getCCBillingDate(r.pm);
  if (!billingDate || !r.d || r.d <= billingDate) return r;
  let nextM = r.m + 1, nextY = r.y;
  if (nextM > 11) { nextM = 0; nextY++; }
  return { ...r, y: nextY, m: nextM, mk: `${MO[nextM]} ${nextY}` };
}
