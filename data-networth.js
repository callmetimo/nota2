// Nota — net-worth and asset-classification math.
//
// Moved out of ui-insights.js, unchanged. These decide what a holding IS and what it
// is WORTH; nothing here touches the DOM. They were sitting in a render module while
// being called from three different places — ui-insights.js, ui-settings.js and the
// inline script in index.html — which made it look like display logic that happened
// to be reused, rather than the shared definitions the rest of the app agrees on.
//
// Still plain globals on one shared scope, like every other script here, so load order
// only matters in that this file must be parsed before anything calls into it. Every
// caller does so from inside a function, well after load.
//
// Globals read from index.html: HIST, txHistory, investHistory, liveInvest, stockPrices,
// fxRates, CONFIG_ITEMS, STOCK_TYPE, ACCOUNT_CCY, parsePrice().

// Single source of truth for "how much is 1 unit of `ccy` worth in IDR right now",
// used by both buildAccountBalances() and renderNetWorth() so every currency —
// present or future, hardcoded or user-added in Settings — resolves the same way:
// a manual override from the "Stock Prices" sheet (e.g. "EURIDR") takes priority,
// then the live-fetched rate, then a hardcoded last-resort for USD/CHF only (kept
// since those already shipped with a fallback; a brand-new currency with neither a
// manual price nor a successful fetch simply has no rate yet, same as before).
function getCcyRate(ccy) {
  ccy = (ccy || '').toUpperCase();
  if (!ccy || ccy === 'IDR') return 1;
  const manual = parsePrice(stockPrices[ccy + 'IDR']);
  if (manual > 0) return manual;
  if (fxRates[ccy]) return fxRates[ccy];
  if (ccy === 'USD') return 16500;
  if (ccy === 'CHF') return 19000;
  return 1;
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
    // Once a local row syncs it's marked synced:true but never removed from
    // investHistory (only an explicit delete removes it) — and it also then shows
    // up in liveInvest, fetched separately from the sheet. Without this guard a
    // synced Buy/Sell would double-count its cash effect here: once from this
    // now-stale local copy, once from liveInvest. Same dedup rule getAllInvestRows()
    // already uses for exactly this reason.
    if (r.synced) return;
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
      targetKey = forexStockKeys.find(s => isFxAccountMatch(r.account, ACCOUNT_CCY[r.account] || 'IDR', s));
    }
    if (!targetKey) return;

    if (!(targetKey in sellLots)) { buyLots[targetKey] = buyLots[targetKey] || 0; sellLots[targetKey] = 0; }
    sellLots[targetKey] += fxSpent;
  });

  return { buyLots, sellLots, buyTotalIdr, buyPriceWeighted };
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
  //
  // Critically, both sides must be stripped of the SAME currency's token — stripping
  // any-of-the-list from each side independently (as this used to) means two accounts
  // that only share a base name but differ in currency (e.g. "CIMB USD" and "CIMB CHF")
  // both reduce to "cimb" and falsely match each other.
  // Derived generically from the 3-letter ccy code itself (e.g. "AUD" -> "audidr|aud")
  // rather than a hardcoded list, so any currency addable in Settings (see the
  // presets list in ui-settings.js — USD, SGD, EUR, AUD, JPY, GBP, MYR, THB, CNY)
  // gets this matching for free, with no code change when a new one is configured.
  const ccyUpper = (ccy || '').toUpperCase();
  const tokenAlts = (ccyUpper && ccyUpper !== 'IDR' && /^[A-Z]{3}$/.test(ccyUpper))
    ? `${ccyUpper.toLowerCase()}idr|${ccyUpper.toLowerCase()}`
    : null;
  if (tokenAlts) {
    const prefixRe = new RegExp(`^(${tokenAlts})\\s+`, 'i');
    const suffixRe = new RegExp(`\\s+(${tokenAlts})$`, 'i');
    const aHasToken = prefixRe.test(aLower) || suffixRe.test(aLower);
    const sHasToken = prefixRe.test(sLower) || suffixRe.test(sLower);

    if (aHasToken && sHasToken) {
      const normA = aLower.replace(prefixRe, '').replace(suffixRe, '').replace(/\s+/g, ' ').trim();
      const normS = sLower.replace(prefixRe, '').replace(suffixRe, '').replace(/\s+/g, ' ').trim();

      if (normA && normS && normA === normS) {
        return true;
      }
    }
  }

  // 3. (Removed generic FX pair matching to prevent double-counting across multiple accounts of the same currency)


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
    // < 0.5 rounds to Rp0 — hides float-residue balances (e.g. 1e-9 left after a full spend)
    if (amt < 0.5) return;

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
    if (amt < 0.5) return;

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

// ── CREDIT-CARD MONITOR ───────────────────────────────────────
// Everything the CC monitor needs worked out before any of it is drawn: which payment
// methods are in scope, which billing cycle each transaction falls into, this cycle's
// totals, the previous cycle's totals to compare against, and how much of the credit
// limit is already committed once outstanding installments are counted.
//
// Lifted out of renderCCMonitor() unchanged. That function had reached 273 lines with
// these sums computed inline between the HTML strings displaying them, so the billing-
// cycle rule — the part most likely to be wrong and the hardest to confirm by reading —
// could only be exercised by rendering the whole page.
//
// Two behaviours preserved deliberately rather than fixed here, because changing either
// changes which transactions the monitor reports:
//   - isMatchPM matches substrings in BOTH directions, so filtering on "BCA" also picks
//     up "CC BCA" and "IDR BCA", and an account whose name contains another account's
//     name is attributed both ways.
//   - installments whose start month is still ahead of the displayed cycle are skipped
//     (monthsElapsed < 0), so future commitments do not count against the limit.
//
// Globals read: allPMs, HIST, txHistory. Functions: getCCBillingDate, getCCCreditLimit
// and loadRecurring, all defined in ui-settings.js and called long after load.
function computeCCMonitor(ccDate, pmFilter) {
  const curY = ccDate.getFullYear();
  const curM = ccDate.getMonth() + 1; // 1-12
  // The month's display name is formatting, so it stays in renderCCMonitor and is
  // rebuilt there from curY/curM rather than returned from here.

  // 1. Get all available payment methods (from settings/history config)
  const pmList = Array.from(new Set(allPMs || []));

  const targetPms = (!pmFilter || pmFilter.length === 0)
    ? pmList.map(p => p.toLowerCase())
    : pmFilter.map(p => p.toLowerCase());

  function isMatchPM(pmVal) {
    if (!pmVal) return false;
    const low = String(pmVal).toLowerCase().trim();
    return targetPms.some(t => low.includes(t) || t.includes(low));
  }

  // Billing date/credit limit lookups only make sense for exactly one selected account
  const singlePmFilter    = (pmFilter && pmFilter.length === 1) ? pmFilter[0] : null;
  const activeBillingDate  = singlePmFilter ? getCCBillingDate(singlePmFilter)  : 0;
  const activeCreditLimit  = singlePmFilter ? getCCCreditLimit(singlePmFilter)  : 0;

  function getEffectiveBillingMonth(txDay, txY, txM0) {
    if (!activeBillingDate || !txDay || txDay <= activeBillingDate) return { y: txY, m: txM0 };
    let nm = txM0 + 1, ny = txY;
    if (nm > 11) { nm = 0; ny++; }
    return { y: ny, m: nm };
  }

  // 2. Fetch current month opex transactions (both expenses and incomes)
  const currentTxns = [];
  (HIST.opex || []).forEach((r, i) => {
    if (!isMatchPM(r.pm)) return;
    const bm = getEffectiveBillingMonth(r.d, r.y, r.m);
    if (bm.y === curY && bm.m === (curM - 1)) {
      const isInc = (r.inc || 0) > 0;
      currentTxns.push({
        source: 'hist-opex',
        idx: i,
        day: r.d,
        // The date the transaction actually happened, which is NOT the cycle it is
        // listed under: with a statement date set, a purchase made after it appears on
        // the following month's bill. The list used to label every row with the cycle's
        // month and the transaction's own day, so an October 25th purchase on the
        // November bill read "November 25" — a date it was never made on.
        txY: r.y,
        txM0: r.m,
        desc: r.tx || r.notes || (isInc ? 'Income' : 'Expense'),
        category: r.cat || (isInc ? 'Income' : 'Other'),
        pm: r.pm || '',
        amount: Number(isInc ? r.inc : r.exp) || 0,
        type: isInc ? 'income' : 'expense',
        row: r
      });
    }
  });

  (txHistory || []).forEach((r, i) => {
    if (r.synced) return;
    if (!r.date) return;
    const parts = r.date.split('-');
    if (!isMatchPM(r.pm)) return;
    
    const txDay = parseInt(parts[2], 10);
    const bm = getEffectiveBillingMonth(txDay, +parts[0], +parts[1] - 1);
    
    if (bm.y === curY && bm.m === (curM - 1)) {
      const isInc = r.type === 'income';
      currentTxns.push({
        source: 'local-opex',
        idx: i,
        day: txDay,
        txY: +parts[0],
        txM0: +parts[1] - 1,
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
    if (!isMatchPM(r.pm)) return;
    const bm = getEffectiveBillingMonth(r.d, r.y, r.m);
    if (bm.y === prevY && bm.m === (prevM - 1)) {
      if ((r.exp || 0) > 0) prevTotal += Number(r.exp) || 0;
      if ((r.inc || 0) > 0) prevIncomeTotal += Number(r.inc) || 0;
    }
  });

  currentTxns.sort((a, b) => b.day - a.day || b.amount - a.amount);
  const currentTotalExpenses = currentTxns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const currentTotalIncome = currentTxns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const txCount = currentTxns.length;

  // Only computed when a single account with a configured limit is selected, matching
  // what renderCCMonitor used to do inline — loadRecurring() is a localStorage read and
  // there is nothing to show it in without a limit. null means "no bar to draw".
  let creditUsage = null;
  if (activeCreditLimit > 0) {
    creditUsage = 0;
    const INSTALLMENT_RE = /\(\d+\/\d+\)$/;

    currentTxns.forEach(t => {
      if (t.type === 'expense' && !INSTALLMENT_RE.test(t.desc)) {
        creditUsage += t.amount;
      }
    });

    const rules = loadRecurring();
    rules.forEach(rule => {
      if (!rule.installmentTotal || !rule.installmentStart) return;
      if (!isMatchPM(rule.pm)) return;

      // installmentStart is dateToMonthKey()'s "YYYY-MM" numeric format, not a month-name string.
      const [startYStr, startMonStr] = rule.installmentStart.split('-');
      const startY = parseInt(startYStr, 10);
      const startM0 = parseInt(startMonStr, 10) - 1; // 0-based, matches getEffectiveBillingMonth's convention
      if (isNaN(startY) || isNaN(startM0) || startM0 < 0 || startM0 > 11) return;

      const startDay = rule.dayOfMonth || 1;
      const startBM  = getEffectiveBillingMonth(startDay, startY, startM0);

      const monthsElapsed = (curY - startBM.y) * 12 + ((curM - 1) - startBM.m);
      if (monthsElapsed < 0) return;

      const remainingMonths = rule.installmentTotal - monthsElapsed;
      if (remainingMonths <= 0) return;

      creditUsage += rule.amount * remainingMonths;
    });

  }

  return {
    curY, curM, pmList,
    activeBillingDate, activeCreditLimit,
    currentTxns, prevTotal, prevIncomeTotal,
    currentTotalExpenses, currentTotalIncome, txCount,
    creditUsage,
  };
}
