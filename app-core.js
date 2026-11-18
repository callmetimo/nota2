// Nota — the application core: state, the API layer, transaction entry, search, and boot.
//
// This was 3,394 lines inline in index.html. It is unchanged, and it is still loaded from
// exactly the same position in the document, so execution order relative to every other
// script is what it always was.
//
// Two things here deliberately run at load rather than on DOMContentLoaded, and must keep
// doing so:
//   - the window.fetch patch, which routes APPS_SCRIPT_URL calls into DataStore. Anything
//     that calls fetch() before it is installed would go to the network instead.
//   - the attachSwipeClose() calls. The README is explicit that swipe listeners attach
//     directly; deferring them reopens a fixed bug.
//
// The DOMContentLoaded boot handler near the end still registers before that event fires,
// because a classic <script src> at this position blocks parsing until it has run.
//
// NOTE: this file now carries logic that used to arrive atomically with index.html. It is
// listed in sw.js SHELL_FILES so an offline cold start still has it.

// ── HTTPS ENFORCEMENT ─────────────────────────────────────────
// Redirect http → https in production (localhost is exempt for dev)
if (location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  location.replace('https:' + location.href.slice(5));
}

const APP_VERSION = 'v4.101';
const APP_BUILD = '2026-11-17a'; // surfaced in the Account page (see #acctInfoBuild) for support diagnostics
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(e => console.warn('[SW]', e.message));
}
// Nota: no shared backend URL/token — each user's data lives in a
// Sheet this app created in their own Drive (see auth.js/data-store.js).
// APPS_SCRIPT_URL is kept only as a routing marker so the rest of this
// file's fetch(APPS_SCRIPT_URL, ...) calls need no changes below.
const APPS_SCRIPT_URL = 'https://notapublic.local/api';
function apiGet(params) { return `${APPS_SCRIPT_URL}?${params}`; }
function apiBody(payload) { return JSON.stringify(payload); }

const _notaRealFetch = window.fetch.bind(window);
window.fetch = function(url, opts) {
  if (typeof url === 'string' && url.indexOf(APPS_SCRIPT_URL) === 0) {
    return DataStore.handleRequest(url, opts)
      .then(result => ({ ok: true, status: 200, json: async () => result }))
      .catch(err => ({ ok: false, status: 500, json: async () => ({ status: 'error', message: err.message }) }));
  }
  return _notaRealFetch(url, opts);
};

// fetchWithTimeout wraps every APPS_SCRIPT_URL POST with a race against a
// plain setTimeout, acting as a user-visible deadline (default 8 s) on top of
// SheetsClient.authedFetch's lower-level AbortController (15 s). The two layers
// serve different purposes: authedFetch aborts the in-flight HTTP request;
// fetchWithTimeout races the DataStore.handleRequest() promise chain which may
// itself queue retries. Kept as a named helper so all ~15 call sites share the
// same deadline logic without inline duplication.
function fetchWithTimeout(url, opts, ms = 8000) {
  // Was Promise.race([fetch(url,opts), a bare setTimeout]) with neither side cleaned up:
  //   - the timer kept running for the full `ms` even after a fast fetch already won the
  //     race. Harmless on its own (calling an already-settled promise's reject again is a
  //     no-op), but with ~20+ call sites now sharing this helper, every quick request left
  //     a dangling timer ticking in the background for up to 8s for no reason.
  //   - when the TIMEOUT won instead, the real HTTP request kept running with nothing to
  //     cancel it. The connection stayed open and, if it eventually succeeded, the
  //     response was fetched and then silently discarded — wasted bandwidth and a kept-
  //     open connection on exactly the slow/flaky connections where this matters most.
  //
  // First attempt here replaced Promise.race with relying on fetch() to reject once
  // AbortController fires. That's weaker, not just different: it makes the timeout
  // depend on fetch() actually honoring the abort signal promptly, when the entire
  // point of this helper is to bound the wait NO MATTER what the underlying request
  // does. Caught by testing against a mock fetch that ignores its signal (not a real
  // browser gap, but the dependency it would create is real) — reverted to keeping
  // Promise.race as the thing that unconditionally settles at `ms`, with
  // AbortController layered on as a best-effort cancellation of the loser, not a
  // replacement for the guarantee.
  const controller = new AbortController();
  const fetchOpts = (opts && opts.signal) ? opts : { ...(opts || {}), signal: controller.signal };
  const fetchPromise = fetch(url, fetchOpts);
  // Promise.race discards whatever the losing side eventually does — if the timeout
  // wins, the abort below makes fetchPromise reject moments later with nothing left
  // to catch it, which is an unhandled-rejection warning without this.
  fetchPromise.catch(() => {});
  let timer;
  return Promise.race([
    fetchPromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, ms);
    }),
  ])
    // controller.abort() above fires its 'abort' listeners synchronously, so when the
    // underlying fetch honors the signal (as a real browser fetch does), its own
    // AbortError can win the race ahead of the explicit reject(new Error('timeout'))
    // on the very next line — an AbortError here can only mean this helper's own
    // timeout fired (nothing else holds this controller), so normalize it rather than
    // let callers see two different error shapes for the same condition depending on
    // this timing coincidence.
    .catch(e => { throw (e && e.name === 'AbortError') ? new Error('timeout') : e; })
    .finally(() => clearTimeout(timer));
}
// Escape HTML special chars — use when injecting user text into innerHTML
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
// Trim + enforce max length on form string fields
function sanitizeInput(str, maxLen = 100) {
  return String(str ?? '').trim().slice(0, maxLen);
}
// localStorage key holding the cached live rows for a given year+month
// (defaults to the current month)
function curMonthCacheKey(y, m) {
  const now = new Date();
  return `notapub_curMonth_${y ?? now.getFullYear()}_${m ?? now.getMonth() + 1}`;
}
const MO = DataStore.MONTHS;
// Escape a value for a single-quoted JS string inside an inline onclick attribute.
// Backslash-escape quotes first, then HTML-escape (the browser decodes the
// attribute before evaluating the JS, so both layers are needed).
function escJsAttr(s) {
  return esc(String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
}
// Payment-source labels shown in Insights summary cards
const VIEW_LABELS = { all: 'All', flazz: 'Flazz', ewallet: 'eWallet', bank: 'Bank', cc: 'CC' };
// Payment-method icon class + amount color (default: regular expense)
const PM_STYLES = {
  'CC BCA':   { cls: 'cc-bca',   color: 'var(--blue)' },
  'CC Niaga': { cls: 'cc-niaga', color: 'var(--red)' }
};
const PM_STYLE_DEFAULT = { cls: 'expense', color: 'var(--accent)' };
// Deactivate every toggle button matching selector, then activate the clicked one
function toggleActive(selector, el) {
  document.querySelectorAll(selector).forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}
// Close an overlay when its handle bar is swiped down more than `threshold` px
function attachSwipeClose(handleId, closeFn, threshold = 60) {
  const handle = document.getElementById(handleId);
  if (!handle) return;
  let touchStartY = 0;
  let touchStarted = false;
  handle.addEventListener('touchstart', function(e) {
    touchStartY = e.touches[0].clientY;
    touchStarted = true;
  }, { passive: true });
  handle.addEventListener('touchend', function(e) {
    if (!touchStarted) return;
    touchStarted = false;
    const delta = e.changedTouches[0].clientY - touchStartY;
    if (delta > threshold) closeFn();
  }, { passive: true });
  handle.addEventListener('touchcancel', function() {
    touchStarted = false;
  }, { passive: true });
}
document.getElementById('appVersionLabel').textContent = APP_VERSION;

// These arrays start empty and are immediately populated by applyConfigToGlobals()
// (called synchronously from the localStorage-cached CONFIG_ITEMS on boot, or after
// fetchConfig() resolves). Hardcoded seeds were removed — CONFIG_DEFAULTS in
// data-store.js is the single source of truth for default category/PM/stock/account names.
const allCategories = [];
const allPMs = [];
const allStocks = [];
const allAccounts = [];

const CAT_COLORS = {
  'Transport':'#60a0f0','Meals':'#c8f060','Entertainment':'#ff6b6b','Groceries':'#ffaa44',
  'Household':'#a78bfa','Medical':'#34d399','Utilities':'#f472b6',
  'Gas':'#fbbf24','Travel':'#22d3ee','Insurance':'#e879f9',
  'Gifts':'#fca5a5','Self Care':'#c4b5fd',
  'Home Repair':'#f87171','Income':'#4ade80',
  'Other':'#6b7280'
};

const ACCOUNT_CCY = {'USD CIMB':'USD'};

const STOCK_TYPE = {'USDIDR CIMB':'Forex'};

// ── LOCAL DATA (historical) ───────────────────────────────────
const HIST = {opex:[], invest:[], txCat:{}, txPm:{}, txAccount:{}, stockType:{}, cashBalance:0};

let histLoaded = false;
let histLoadFailed = false; // true once loadHistData() has exhausted its retry and fallen back to cache
let histLoadCallbacks = [];

function onHistLoaded(cb) {
  if (histLoaded) { cb(); return; }
  histLoadCallbacks.push(cb);
}

// ── STATE ─────────────────────────────────────────────────────
let inputMode = 'expense';
let investAction = 'Buy';
let overlayEditRowIndex = null; // sheet row number when known (null = unknown)
let overlayEditId       = null; // Opex TxID (col K) or Invest TxID (col I) when known (null = unknown/legacy row)
let overlayEditMode     = false; // true while edit overlay is open (even without rowIndex)
let overlayEditType     = 'opex'; // 'opex' | 'invest' — which form/payload the open overlay edits
let overlayEditOrigDate  = '';  // original ISO date string for local & server-side lookup
let overlayEditOrigMonth = '';  // original "Mmm YYYY" month key for server-side lookup
let overlayEditOrigTx    = '';  // original transaction name for local & server-side lookup
let overlayEditOrigAmt   = 0;   // original amount for local & server-side lookup
let overlayEditOrigInc   = false; // original isIncome flag for local & server-side lookup
let calCurrentTxns = [];        // txns for the currently selected calendar day
let calCurrentDateStr = '';     // ISO date of the selected calendar day
let queue = JSON.parse(localStorage.getItem('notapub_queue_v2') || '[]');
let RECURRING_RULES = JSON.parse(localStorage.getItem('notapub_recurring_v1') || '[]');
// Explicit tombstone of user-initiated deletes — {id, ts} pairs, written only by
// deleteRecurringRule(). fetchRecurring() uses this (not "absent from local RECURRING_RULES")
// to decide which server rules to drop, because local can be empty/incomplete for reasons
// that are NOT a delete (e.g. iOS Safari's ITP evicting localStorage for an installed PWA
// that hasn't been opened via Safari itself in ~7 days). Treating that as "user deleted
// everything" wiped the whole sheet on the next push — see RECURRING_TOMBSTONE_STALE_MS below.
let _recurringDeletedIds = JSON.parse(localStorage.getItem('notapub_recurring_deleted_ids') || '[]');
const RECURRING_TOMBSTONE_STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function _pruneRecurringTombstones() {
  const cutoff = Date.now() - RECURRING_TOMBSTONE_STALE_MS;
  _recurringDeletedIds = _recurringDeletedIds.filter(t => t.ts > cutoff);
  localStorage.setItem('notapub_recurring_deleted_ids', JSON.stringify(_recurringDeletedIds));
}
function _tombstoneRecurringId(id) {
  _recurringDeletedIds.push({ id, ts: Date.now() });
  localStorage.setItem('notapub_recurring_deleted_ids', JSON.stringify(_recurringDeletedIds));
}
_pruneRecurringTombstones();
let _recurringDirty = localStorage.getItem('notapub_recurring_dirty') === 'true';
// Guard against long-forgotten dirty/pending state from a device that was never
// reopened since an old, abandoned edit (e.g. left offline, or an old test tab).
// Without this, that device's stale local edit re-activates as "authoritative"
// on its next reload and overwrites whatever the server correctly holds by then.
// Any pending state older than this is discarded rather than trusted.
const RECURRING_PENDING_STALE_MS = 2 * 60 * 1000; // 2 minutes
(function _expireStaleRecurringState() {
  const pendingRaw = localStorage.getItem('notapub_recurring_pending');
  if (!pendingRaw) return;
  const ts = Number(localStorage.getItem('notapub_recurring_pending_ts') || 0);
  // No timestamp (pending predates this fix) or timestamp too old — can't trust it, discard.
  if (!ts || (Date.now() - ts) > RECURRING_PENDING_STALE_MS) {
    localStorage.removeItem('notapub_recurring_pending');
    localStorage.removeItem('notapub_recurring_pending_ts');
    localStorage.removeItem('notapub_recurring_dirty');
    _recurringDirty = false;
  }
})();
let txHistory = JSON.parse(localStorage.getItem('notapub_history_v2') || '[]');
let investHistory = JSON.parse(localStorage.getItem('notapub_invest_v2') || '[]');
let liveInvest = []; // invest rows fetched from Google Sheets (cross-device sync)
let fxRates = JSON.parse(localStorage.getItem('notapub_fx') || '{}');
let fxLastFetch = parseInt(localStorage.getItem('notapub_fx_ts') || '0');
let stockPrices = JSON.parse(localStorage.getItem('notapub_prices') || '{}');

let sheetPricesLastFetch = parseInt(localStorage.getItem('notapub_sp_ts') || '0');
let isSyncing = false;
let _suppressVisRefresh = false; // prevents stale sheet fetch racing with in-flight delete/edit
// Reflect pending-queue count on FAB badge as early as possible (before DOMContentLoaded)
document.addEventListener('DOMContentLoaded', updateFabBadge);

function parsePrice(str) {
  if (!str) return 0;
  return parseFloat(String(str).replace(',', '.').replace(/[^0-9.]/g, '')) || 0;
}

async function fetchSheetPrices(force) {
  const now = Date.now();
  const cached = localStorage.getItem('notapub_prices');
  const statusEl = document.getElementById('nwPricesLabel');
  // Use cache if < 30 min and not forced
  if (!force && cached && (now - sheetPricesLastFetch) < 1800000) {
    stockPrices = JSON.parse(cached);
    if (statusEl) {
      const ago = Math.round((now - sheetPricesLastFetch) / 60000);
      statusEl.textContent = `Prices from Google Sheets · ${ago < 1 ? 'just now' : ago + 'm ago'}`;
    }
    return;
  }
  if (statusEl) statusEl.textContent = 'Fetching prices from Google Sheets…';
  try {
    // Was a raw fetch(): the same bug class already fixed once in this project (see the
    // calendar-skeleton-stuck memory) — a hung Auth token wait or a stalled connection
    // left this await pending forever, with nothing to time it out.
    const res = await fetchWithTimeout(apiGet('type=prices'), {method:'GET'});
    const j = await res.json();
    if (j.prices) {
      // j.prices: { AAPL: 298.21, JNJ: 230.80, VYM: 157.24, QQQ: 719.79, CHFIDR: 22425, USDIDR: 17599, StarStable: 2205 }
      Object.assign(stockPrices, j.prices);
      localStorage.setItem('notapub_prices', JSON.stringify(stockPrices));
      sheetPricesLastFetch = now;
      localStorage.setItem('notapub_sp_ts', String(now));
      if (statusEl) statusEl.textContent = `Prices from Google Sheets · just now`;
    } else {
      throw new Error('no prices');
    }
    if (j.cashBalance !== undefined && !HIST.cashBalance) {
      HIST.cashBalance = j.cashBalance;
      localStorage.setItem('notapub_cashBalance', String(j.cashBalance));
    }
  } catch(e) {
    // Fallback to HIST.currentPrices if available
    if (HIST.currentPrices) {
      const cp = HIST.currentPrices;
      ['StarStable','AAPL','JNJ','VYM','QQQ','CHFIDR','USDIDR'].forEach(k => {
        if (!stockPrices[k] && cp[k]) stockPrices[k] = String(cp[k]);
      });
    }
    if (statusEl) statusEl.textContent = cached ? 'Using cached prices · Sheet unavailable' : 'Could not fetch prices · Enter manually';
  }
}

function saveAndRenderNW() { renderNetWorth(); }

// ── FETCH CURRENT MONTH FROM SHEET (v12) ─────────────────────
// Fetches real-time opex rows for current month from Apps Script.
// Merges into HIST.opex, overwriting any existing rows for that month.
// Cache: localStorage nota_curMonth_YYYY_M, expires after 5 minutes.
let curMonthLastFetch = 0;
// Monotonic sequence guard: fetchCurrentMonth() is called independently and without
// synchronization from several flows (recurring add, manual add, edit). If two calls
// overlap, the slower one can resolve last and re-apply stale sheet state on top of a
// newer one (e.g. re-inserting a transaction's old day after the row was already moved
// to a new day by an edit that finished first) — a ghost duplicate that never clears.
// Each call captures the counter value at start; if a newer call has started by the
// time this one resolves, its result is discarded instead of applied.
let curMonthFetchSeq = 0;

async function fetchCurrentMonth(force, overrideY, overrideM) {
  const mySeq = ++curMonthFetchSeq;
  const now = Date.now();
  const today = new Date();
  const y = overrideY ?? today.getFullYear();
  const m = overrideM ?? (today.getMonth() + 1); // 1-indexed
  const cacheKey = curMonthCacheKey(y, m);

  // Use cache if < 5 min and not forced
  if (!force && (now - curMonthLastFetch) < 300000) {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      if (histLoaded) _applyCurrentMonthRows(JSON.parse(cached), y, m);
      else onHistLoaded(() => {
        if (mySeq !== curMonthFetchSeq) { dupDebugLog('fetchCurrentMonth:staleCacheDiscarded', { y, m, mySeq, curMonthFetchSeq }); return; }
        _applyCurrentMonthRows(JSON.parse(cached), y, m);
      });
      return;
    }
  }

  try {
    // See loadHistData()'s comment — bound this the same way so a stuck
    // Auth.ready/_tokenReady wait can't hang this call (and therefore
    // initCalendar()) forever.
    const res = await fetchWithTimeout(apiGet(`type=month&y=${y}&m=${m}`), { method: 'GET' }, 10000);
    const j = await res.json();
    if (j.status === 'ok' && Array.isArray(j.rows)) {
      localStorage.setItem(cacheKey, JSON.stringify(j.rows));
      curMonthLastFetch = now;
      _reconcileUnsyncedWithSheet(j.rows, y, m);
      if (mySeq !== curMonthFetchSeq) {
        dupDebugLog('fetchCurrentMonth:staleFetchDiscarded', { y, m, mySeq, curMonthFetchSeq, rows: j.rows.length });
        return j.rows.length;
      }
      // Wait for histLoaded before merging, to avoid race with loadHistData
      if (histLoaded) {
        _applyCurrentMonthRows(j.rows, y, m);
        // Re-render calendar so rowIndex (edit/delete) becomes available.
        // Critical when this fetch completes after the 8-second startup timeout —
        // without this the calendar stays in non-editable state for the whole session.
        if (document.getElementById('page-home').classList.contains('active')) {
          calInited = false; initCalendar();
        }
      } else {
        onHistLoaded(() => {
          if (mySeq !== curMonthFetchSeq) { dupDebugLog('fetchCurrentMonth:staleDeferredDiscarded', { y, m, mySeq, curMonthFetchSeq }); return; }
          _applyCurrentMonthRows(j.rows, y, m);
        });
      }
      return j.rows.length; // caller can check if sheet returned any rows
    }
    return null;
  } catch(e) {
    console.warn('fetchCurrentMonth failed:', e.message);
    return null;
  }
}

// Fetches invest rows from Google Sheets since HIST.cashBalanceAsOf.
// Populates liveInvest so Holdings/Overview are correct on all devices,
// not just the device that originally entered the transaction.
async function fetchLiveInvest() {
  // No data.json means HIST.cashBalanceAsOf is never set here, so this always
  // fetches full invest history rather than falling back to a recent cutoff.
  const since = HIST.cashBalanceAsOf || '2000-01-01';
  try {
    // Was a raw fetch() — same hang risk as fetchSheetPrices above.
    const res = await fetchWithTimeout(apiGet(`type=invest&since=${since}`), { method: 'GET' });
    const j = await res.json();
    if (j.status === 'ok' && Array.isArray(j.rows)) {
      liveInvest = j.rows.map(r => {
        const dt = new Date(r.date);
        return {
          y:dt.getFullYear(), m:dt.getMonth(), d:dt.getDate(),
          mk:`${MO[dt.getMonth()]} ${dt.getFullYear()}`,
          stock:r.stock, type:STOCK_TYPE[r.stock]||'',
          action:r.action, lot:r.lot, price:r.price, totalIdr:r.totalIdr,
          account:r.account||'',
          date:r.date,
          id:r.id||null, rowIndex:r.rowIndex||null, opexTxId:r.opexTxId||null,
          source:'live'
        };
      });
    }
    if (j.txAccount) {
      HIST.txAccount = j.txAccount;
      localStorage.setItem('notapub_txAccount', JSON.stringify(j.txAccount));
    }
  } catch(e) {
    console.warn('fetchLiveInvest failed:', e.message);
  }
}

function _applyCurrentMonthRows(rows, y, m) {
  // m is 1-indexed; HIST.opex uses 0-indexed m
  const mIdx = m - 1;
  const mk = `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mIdx]} ${y}`;
  dupDebugLog('applyCurrentMonthRows', { y, m, rows: rows.map(r => ({ d: r.d, tx: r.tx, sig: sigOfSheetRow(r), rowIndex: r.rowIndex || null })) });

  // Only remove data.json rows for days the live sheet actually covers.
  // The sheet may not return every past day (e.g. only the last 2 entries), so
  // removing by date range would wipe data.json rows that have no live replacement.
  // Future-dated rows (e.g. scheduled income May 25, 28) are never in the live
  // sheet and are therefore never in liveDays — they are preserved automatically.
  const liveDays = new Set(rows.map(r => r.d));
  HIST.opex = (HIST.opex || []).filter(r => !(r.y === y && r.m === mIdx && liveDays.has(r.d)));

  // Append fresh rows from sheet
  rows.forEach(r => {
    HIST.opex.push({ y, m: mIdx, d: r.d, mk, cat: r.cat, tx: r.tx, pm: r.pm,
      ...(r.inc      ? { inc: r.inc }           : {}),
      ...(r.exp      ? { exp: r.exp }           : {}),
      ...(r.notes    ? { notes: r.notes }       : {}),
      ...(r.rowIndex ? { rowIndex: r.rowIndex } : {}),
      ...(r.id       ? { id: r.id }             : {})
    });
  });
}
// Diagnostic logging for the still-unresolved "duplicate transaction on iOS PWA" bug
// (README v4.15-v4.18 — 4 prior fix rounds, each targeting a different mechanism under
// the same symptom). No-op unless localStorage.nota_debug === '1', so it costs nothing for
// normal users. Ring-buffered to localStorage so the log survives an iOS PWA kill and can be
// pulled off the device after the next occurrence, instead of guessing a 5th root cause blind.
const NOTA_DEBUG_LOG_MAX = 200;
function dupDebugLog(tag, data) {
  if (localStorage.getItem('notapub_debug') !== '1') return;
  try {
    const log = JSON.parse(localStorage.getItem('notapub_debug_log') || '[]');
    log.push({ t: Date.now(), tag, data });
    while (log.length > NOTA_DEBUG_LOG_MAX) log.shift();
    localStorage.setItem('notapub_debug_log', JSON.stringify(log));
  } catch(e) { /* storage full or unavailable — drop silently */ }
}
// Canonical content-signature key for detecting the same logical transaction across
// HIST.opex, the nota_curMonth cache, and txHistory — the three sources use different
// field names for the same data (opex/cache: d/tx/inc/exp; txHistory: date/tx/amount/type).
// Count-based (not boolean) matching against this key is what lets N legitimately-identical
// transactions coexist while still catching genuine ghosts/duplicates.
function txSig(day, tx, amount, isIncome) {
  return `${day}|${(tx||'').toLowerCase()}|${amount||0}|${isIncome?'i':'e'}`;
}
function sigOfSheetRow(r) {   // HIST.opex row, nota_curMonth cache row, or raw sheet GET row (d/tx/inc/exp)
  const isInc = (r.inc||0) > 0 && !(r.exp||0);
  return txSig(r.d, r.tx, isInc ? (r.inc||0) : (r.exp||0), isInc);
}
function sigOfTxHistory(h) {  // txHistory row (date/tx/amount/type)
  const day = parseInt((h.date||'').split('-')[2], 10);
  return txSig(day, h.tx, h.amount||0, h.type === 'income');
}
function sigOfProjection(p) {  // getRecurringProjections() entry (date/tx/amount/type)
  const day = parseInt((p.date||'').split('-')[2], 10);
  return txSig(day, p.tx, p.amount||0, p.type === 'income');
}

// When the sheet returns rows for the current month, mark matching unsynced txHistory
// items as synced. Handles the sync-timeout case: server wrote the row but the
// network dropped before the response arrived, so the client still shows it as unsynced.
// Without this, HIST.opex gets the row from the sheet AND calGetMonthData adds the
// txHistory entry (synced:false) → doubled in the calendar.
// Uses count-based matching so two identical transactions on the same day are handled correctly.
function _reconcileUnsyncedWithSheet(rows, y, m) {
  const mPad = String(m).padStart(2,'0');
  const prefix = `${y}-${mPad}-`;
  const unsyncedLocal = txHistory.filter(h => !h.synced && h.date && h.date.startsWith(prefix));
  if (!unsyncedLocal.length) return;
  // Count sheet rows by content signature
  const sheetCounts = {};
  rows.forEach(sr => {
    const k = sigOfSheetRow(sr);
    sheetCounts[k] = (sheetCounts[k]||0) + 1;
  });
  // Match unsynced items against sheet, respecting counts for duplicate transactions
  const usedCounts = {};
  let changed = false;
  for (const h of unsyncedLocal) {
    const k = sigOfTxHistory(h);
    usedCounts[k] = (usedCounts[k]||0) + 1;
    if ((sheetCounts[k]||0) >= usedCounts[k]) {
      txHistory = txHistory.map(th => th.id === h.id ? {...th, synced:true} : th);
      queue = queue.filter(q => q.id !== h.id);
      changed = true;
    }
  }
  if (changed) saveLocal();
}

let insightsMode = 'weekly';
let insightsDataType = 'expense';
let nwMode = 'holdings';
let holdingsGroupFilter = null;

function setHoldingsGroupFilter(type, el) {
  holdingsGroupFilter = type;
  toggleActive('.holdings-group-btn', el);
  renderNetWorth();
}
let wView=[], wRange=4, wSelWeek=null, wSelCat=null;
let mView=[], mRange=3, mSelMonth=null, mSelCat=null;
let yView=[], yRange=3, ySelYear=null, ySelCat=null;
let cView=[], cRange=3, cSelCat=null;
let insightsAccountFilterVal = [];

// ── COMBINED DATA ROWS ────────────────────────────────────────
function getAllOpexRows() {
  const hist = (HIST.opex || []).map(r => ({
    ...r, source:'hist',
    mk: r.mk,
    isIncome: !!r.inc,
  }));
  const local = txHistory.filter(r => !r.synced).map(r => {
    const dt = new Date(r.date);
    return {
      y:dt.getFullYear(), m:dt.getMonth(), d:dt.getDate(),
      mk:`${MO[dt.getMonth()]} ${dt.getFullYear()}`,
      cat:r.category, tx:r.tx||r.payee||r.transaction||'',
      pm:r.pm||r.platform||'',
      inc: r.type==='income' ? r.amount : undefined,
      exp: r.type==='expense' ? r.amount : undefined,
      source:'local', id:r.id
    };
  });
  return [...hist, ...local];
}

// Multi-select account filter: `view` is an array of selected account/PM names
// (case-insensitive); an empty/falsy array means "All Accounts" (no filtering).
function accountFilterSet(view) {
  if (!view || (Array.isArray(view) && view.length === 0)) return null;
  const arr = Array.isArray(view) ? view : [view];
  return new Set(arr.map(v => String(v).toLowerCase().trim()));
}

function getRows(view) {
  const hist = getAllOpexRows()
    .filter(r => r.exp && r.cat !== 'Investment' && r.cat !== 'Transfer')
    .map(r => isCreditCardPM(r.pm) ? applyBillingCycle(r) : r);
  const wanted = accountFilterSet(view);
  if (!wanted) return hist;
  return hist.filter(r => r.pm && wanted.has(r.pm.toLowerCase().trim()));
}

function getRowsForType(view, dataType) {
  // Expense: existing getRows() behaviour unchanged
  if (!dataType || dataType === 'expense' || dataType === 'category') {
    return getRows(view);
  }

  // Income: opex rows where r.inc > 0, mapped to common shape
  if (dataType === 'income') {
    const all = getAllOpexRows()
      .filter(r => r.inc && Number(r.inc) > 0)
      .map(r => ({
        ...r,
        exp:   Number(r.inc),
        cat:   r.cat || 'Income',
        _type: 'income',
      }));
    const wanted = accountFilterSet(view);
    if (!wanted) return all;
    return all.filter(r => r.pm && wanted.has(r.pm.toLowerCase().trim()));
  }

  // Invest: Buy transactions, grouped by asset type via getAssetTypeForItem
  if (dataType === 'invest') {
    const all = getAllInvestRows()
      .filter(r => r.action === 'Buy' && (r.totalIdr || 0) > 0)
      .map(r => ({
        y:     r.y,
        m:     r.m,
        d:     r.d,
        mk:    r.mk,
        exp:   Number(r.totalIdr) || 0,
        cat:   getAssetTypeForItem(r.stock, STOCK_TYPE[r.stock], false),
        tx:    `${r.action} ${r.stock}`.trim(),
        pm:    r.account || '',   // mapped to pm so account filter logic is uniform
        _type: 'invest',
      }));
    // Filter by invest account name(s) (case-insensitive exact match on r.account)
    const wanted = accountFilterSet(view);
    if (!wanted) return all;
    return all.filter(r => r.pm && wanted.has(r.pm.toLowerCase().trim()));
  }

  return getRows(view); // fallback
}

function getAllInvestRows() {
  const hist = (HIST.invest || []);
  // liveInvest = rows fetched from Google Sheets (covers synced cross-device transactions)
  // Only include local rows that are NOT yet synced — once synced they live in liveInvest
  const unsynced = investHistory.filter(r => !r.synced).map(r => {
    const dt = new Date(r.date);
    // Session 29/30: r.date is normally a clean ISO string from the date-input field, but if
    // it's ever unparseable (corrupted localStorage, a legacy cached shape), `new Date()`
    // returns Invalid Date and getFullYear()/getMonth()/getDate() all silently produce NaN —
    // the same "NaN quietly poisons a downstream comparison" failure class as the Invest date
    // bug. Guard it so a bad date can't inject NaN into y/m/d/mk; the row still shows up (not
    // silently dropped) but with a visible '' month key instead of "NaN NaN".
    const validDt = !isNaN(dt.getTime());
    if (!validDt) console.warn('[getAllInvestRows] Unparseable local Invest date, dropping date fields:', r.date, r.id);
    return {
      y: validDt ? dt.getFullYear() : 0, m: validDt ? dt.getMonth() : 0, d: validDt ? dt.getDate() : 0,
      mk: validDt ? `${MO[dt.getMonth()]} ${dt.getFullYear()}` : '',
      stock:r.stock, type:STOCK_TYPE[r.stock]||'',
      action:r.action, lot:r.lot, price:r.price, totalIdr:r.totalIdr,
      account:r.account||'',
      // computeAccountCurrentBalance()'s cutoff filter reads r.date directly — without it
      // here, an unsynced local Buy/Sell would always count toward the delta regardless
      // of the account's cutoff date, since the `r.date &&` guard would just skip filtering.
      date: r.date || '',
      source:'local', id:r.id
    };
  });
  return [...hist, ...liveInvest, ...unsynced];
}

// ── DATE ──────────────────────────────────────────────────────
function todayISO(){const d=new Date();return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function isoDisp(iso){if(!iso)return'';const[y,m,d]=iso.split('-');return`${parseInt(d)} ${MO[parseInt(m)-1]} ${y}`}
function isoSheetDate(iso){const[y,m,d]=iso.split('-');return`${parseInt(d)} ${MO[parseInt(m)-1]} ${y.slice(-2)}`}
function isoMonthKey(iso){const[y,m]=iso.split('-');return`${MO[parseInt(m)-1]} ${y}`}
// Month label for sheet column B: credit-card rows roll into the next month after the billing day.
function sheetMonthKey(iso, pm){
  const[y,m,d]=iso.split('-').map(Number);
  const bd=getCCBillingDate(pm);
  if(!bd||!d||d<=bd) return isoMonthKey(iso);
  return m>=12?`${MO[0]} ${y+1}`:`${MO[m]} ${y}`;
}
function isFutureTransaction(txDateISO){return txDateISO && txDateISO > todayISO()}
function curMonthBounds(){return{min:'2019-01-01',max:'2099-12-31'}}

function initDatePicker(rawId, dispId, txtId) {
  const raw=document.getElementById(rawId),disp=document.getElementById(dispId),txt=document.getElementById(txtId);
  if(!raw)return;
  const t=todayISO();raw.value=t;txt.textContent=isoDisp(t);
  // Native input overlays the display div — tap goes straight to the OS picker.
  // Fallback click handler kept for desktop environments that need it.
  disp.addEventListener('click',()=>{try{raw.showPicker()}catch(e){raw.click()}});
  raw.addEventListener('change',()=>{txt.textContent=raw.value?isoDisp(raw.value):'Select date...'});
}

// ── INPUT MODE ────────────────────────────────────────────────
function setInputMode(mode, el) {
  inputMode = mode;
  toggleActive('.pill-toggle-btn', el);
  document.getElementById('form-opex').style.display = (mode !== 'invest' && mode !== 'transfer') ? 'block' : 'none';
  document.getElementById('form-invest').style.display = mode === 'invest' ? 'block' : 'none';
  document.getElementById('form-transfer').style.display = mode === 'transfer' ? 'block' : 'none';
  if (mode === 'transfer') {
    const t = todayISO();
    const rawEl = document.getElementById('xfrDateRaw');
    if (rawEl && !rawEl.value) { rawEl.value = t; document.getElementById('xfrDateText').textContent = isoDisp(t); }
    onXfrAcctSelect();
  }
  const btn = document.getElementById('submitOpexBtn');
  btn.className = `submit-btn ${mode}`;
  btn.textContent = mode === 'income' ? 'Save Income' : 'Save Transaction';
  const pmLabel = document.getElementById('inputPmLabel');
  if (pmLabel) {
    pmLabel.textContent = mode === 'income' ? 'Destination Account' : 'Payment Method';
  }
  const pmInput = document.getElementById('inputPm');
  if (pmInput) {
    pmInput.placeholder = mode === 'income' ? 'Account...' : 'Method...';
  }
  document.getElementById('inputCat').value = '';
  document.getElementById('inputPm').value = '';
  checkCcInstallmentVisibility();
  onOpexPmSelect();
}

function setInvestAction(action, el) {
  investAction = action;
  toggleActive('.action-btn', el);
  const acct = document.getElementById('inputAccount');
  if (acct) acct.placeholder = action === 'Buy' ? 'Pay from…' : 'Receive to…';
  updateAvgPrices();
}

// ── AUTOCOMPLETE ──────────────────────────────────────────────
function showAC(fid, list) {
  const inp=document.getElementById(fid),dd=document.getElementById('ac-'+fid);
  if(!dd)return;
  const v=inp.value.toLowerCase();
  const f=v?list.filter(i=>i.toLowerCase().includes(v)):list;
  if(!f.length){dd.style.display='none';return}
  dd.innerHTML=f.map(i=>{
    const safe=esc(i);
    return `<div class="autocomplete-item" data-val="${safe}" data-fid="${fid}" onmousedown="selectAC(this.dataset.fid,this.dataset.val)"><span>${esc(i)}</span></div>`;
  }).join('');
  dd.style.display='block';
}
function selectAC(fid,val){
  const el=document.getElementById(fid);if(el)el.value=val;
  const dd=document.getElementById('ac-'+fid);if(dd)dd.style.display='none';
  if(fid==='inputTx'){onTxSelect(val);}
  if(fid==='inputStock'){onStockSelect(val);}
  if(fid==='inputAccount'){onAccountSelect();}
  if(fid==='inputPm'){checkCcInstallmentVisibility();onOpexPmSelect();}
  if(fid==='xfrFrom'||fid==='xfrTo'){onXfrAcctSelect();}
}
document.addEventListener('click',e=>{
  if(!e.target.closest('.autocomplete-wrapper'))
    document.querySelectorAll('.autocomplete-list').forEach(d=>d.style.display='none');
  if(!e.target.closest('.acct-filter-wrapper'))
    document.querySelectorAll('.acct-filter-panel').forEach(d=>d.style.display='none');
});

// ── CC INSTALLMENT OPTIONS ────────────────────────────────────
function checkCcInstallmentVisibility() {
  const pmVal = document.getElementById('inputPm').value.trim();
  const isCC = isCreditCardPM(pmVal);
  const isExpense = inputMode === 'expense';
  const isNew = !overlayEditMode;
  const row = document.getElementById('installmentRow');
  if (row) {
    row.style.display = (isCC && isExpense && isNew) ? '' : 'none';
  }
  if (!isCC || !isExpense || !isNew) {
    setInstallmentMode('full');
  }
}

function setInstallmentMode(mode) {
  const fullBtn = document.getElementById('ccFullPaymentBtn');
  const instBtn = document.getElementById('ccInstallmentBtn');
  const container = document.getElementById('installmentPeriodContainer');
  const monthsInput = document.getElementById('inputInstallmentMonths');
  if (!fullBtn || !instBtn || !container) return;

  if (mode === 'installment') {
    instBtn.classList.add('active', 'expense');
    fullBtn.classList.remove('active', 'expense');
    container.style.display = 'flex';
  } else {
    fullBtn.classList.add('active', 'expense');
    instBtn.classList.remove('active', 'expense');
    container.style.display = 'none';
  }
}

function dateToMonthKey(dateStr) {
  if (!dateStr) return curMonthKey();
  const parts = dateStr.split('-');
  return `${parts[0]}-${parts[1]}`;
}

function getEndMonth(dateStr, months) {
  const parts = dateStr.split('-');
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  
  let targetM = m + months - 1;
  let targetY = y;
  while (targetM > 12) {
    targetM -= 12;
    targetY += 1;
  }
  return `${targetY}-${String(targetM).padStart(2, '0')}`;
}

function getInstallmentName(rule, monthKey) {
  if (!rule.installmentTotal || !rule.installmentStart) return rule.tx;
  const [startY, startM] = rule.installmentStart.split('-').map(Number);
  const [curY, curM] = monthKey.split('-').map(Number);
  const monthsDiff = (curY - startY) * 12 + (curM - startM);
  const curIndex = monthsDiff + 1;
  if (curIndex <= rule.installmentTotal) {
    const cleanName = rule.tx.replace(/\s*\(Installment\)$/i, '');
    return `${cleanName} (${curIndex}/${rule.installmentTotal})`;
  }
  return rule.tx;
}

// ── TX SMART SUGGESTIONS ──────────────────────────────────────
function getRecentMonths(n) {
  const now = new Date();
  const months = [];
  for (let i = 0; i < n; i++) {
    let y = now.getFullYear();
    let m = now.getMonth() + 1 - i;
    if (m <= 0) { m += 12; y -= 1; }
    months.push({y, m});
  }
  return months;
}
function getSmartCats() {
  const txLow = (document.getElementById('inputTx').value || '').toLowerCase().trim();
  const txCat = HIST.txCat || {};
  const key = Object.keys(txCat).find(k => k.toLowerCase() === txLow) ||
              (txLow && Object.keys(txCat).find(k => txLow.includes(k.toLowerCase()) || k.toLowerCase().includes(txLow)));
  return key ? txCat[key] : allCategories;
}
function getSmartPms() {
  if (inputMode === 'income') {
    return Array.from(new Set([...allAccounts, ...allPMs]));
  }
  const txLow = (document.getElementById('inputTx').value || '').toLowerCase().trim();
  const txPm = HIST.txPm || {};
  const key = Object.keys(txPm).find(k => k.toLowerCase() === txLow) ||
              (txLow && Object.keys(txPm).find(k => txLow.includes(k.toLowerCase()) || k.toLowerCase().includes(txLow)));
  // Accounts (e.g. a USD account) are included alongside PMs, same as income mode
  // already does — so a foreign-currency account is reachable as a payment source
  // for a travel Expense, not just for crediting Income.
  return key ? txPm[key] : Array.from(new Set([...allPMs, ...allAccounts]));
}
function getSmartTransferPms() {
  return Array.from(new Set([...allAccounts, ...allPMs]));
}
function getSmartAccounts() {
  const stockLow = (document.getElementById('inputStock').value || '').toLowerCase().trim();
  const txAccount = HIST.txAccount || {};
  const key = Object.keys(txAccount).find(k => k.toLowerCase() === stockLow) ||
              (stockLow && Object.keys(txAccount).find(k => stockLow.includes(k.toLowerCase()) || k.toLowerCase().includes(stockLow)));
  return key ? txAccount[key] : allAccounts;
}
function autoFillAccountIfExactMatch(stockName) {
  const stockLow = (stockName || '').toLowerCase().trim();
  const txAccount = HIST.txAccount || {};
  const key = Object.keys(txAccount).find(k => k.toLowerCase() === stockLow);
  if (key && txAccount[key].length > 0)
    document.getElementById('inputAccount').value = txAccount[key][0];
}
function updateSmartAccountSuggestion(stockName) {
  const acctDD = document.getElementById('ac-inputAccount');
  if (acctDD && acctDD.style.display !== 'none') showAC('inputAccount', getSmartAccounts());
}
function getAllTxList() {
  const recent = getRecentMonths(3);
  const fromOpex = (HIST.opex || [])
    .filter(r => recent.some(rm => rm.y === r.y && rm.m === r.m))
    .map(r => r.tx || '')
    .filter(Boolean);
  const fromLocal = txHistory.map(r => r.tx || r.payee || '').filter(Boolean);
  return [...new Set([...fromLocal, ...fromOpex])];
}
function onTxInput() {
  const val = document.getElementById('inputTx').value;
  showAC('inputTx', getAllTxList());
  updateSmartSuggestions(val);
  autoFillIfExactMatch(val);
}
function onTxFocus() {
  showAC('inputTx', getAllTxList());
}
function onTxSelect(val) {
  updateSmartSuggestions(val);
  autoFillIfExactMatch(val);
}
function autoFillIfExactMatch(txName) {
  const txLow = txName.toLowerCase().trim();
  const txCat = HIST.txCat || {};
  const txPm  = HIST.txPm  || {};
  const catKey = Object.keys(txCat).find(k => k.toLowerCase() === txLow);
  const pmKey  = Object.keys(txPm).find(k => k.toLowerCase() === txLow);
  if (catKey && txCat[catKey].length > 0)
    document.getElementById('inputCat').value = txCat[catKey][0];
  if (pmKey && txPm[pmKey].length > 0)
    document.getElementById('inputPm').value = txPm[pmKey][0];
  checkCcInstallmentVisibility();
}

function updateSmartSuggestions(txName) {
  const catDD = document.getElementById('ac-inputCat');
  if (catDD && catDD.style.display !== 'none') showAC('inputCat', getSmartCats());
  const pmDD = document.getElementById('ac-inputPm');
  if (pmDD && pmDD.style.display !== 'none') showAC('inputPm', getSmartPms());
}

// ── INVEST HELPERS ────────────────────────────────────────────
// Resolves what currency a stock/asset's own Price field is quoted in. A Forex
// pair (e.g. "USDIDR CIMB") is excluded even though it tracks a foreign
// currency — its price IS the IDR rate itself, not a foreign-currency price —
// so it stays Rp-prefixed, same as before this was generalized past USD.
function getStockCcy(stockName) {
  const type = STOCK_TYPE[stockName] || '';
  if (type === 'Forex') return 'IDR';
  const item = CONFIG_ITEMS.find(i => i.kind === 'stock' && i.name === stockName);
  if (item && item.ccy) return item.ccy.toUpperCase();
  return type === 'US Stock' ? 'USD' : 'IDR';
}
function ccyPrefix(ccy) { return ccy === 'IDR' ? 'Rp' : (CCY_SYMBOLS[ccy] || ccy + ' '); }

function onAccountSelect() {
  const acct = document.getElementById('inputAccount').value.trim();
  document.getElementById('investPricePrefix').textContent = ccyPrefix(getOpexPmCcy(acct));
  calcTotal();
  updateAvgPrices();
}
function onStockSelect(stock) {
  document.getElementById('investPricePrefix').textContent = ccyPrefix(getStockCcy(stock));
  calcTotal();
  updateAvgPrices();
  updateSmartAccountSuggestion(stock);
  autoFillAccountIfExactMatch(stock);
}
function onStockInput() {
  const val = document.getElementById('inputStock').value;
  showAC('inputStock', allStocks);
  updateSmartAccountSuggestion(val);
  autoFillAccountIfExactMatch(val);
}
// Total is entered/displayed in the asset's own currency (lot × price), same as
// Price — not silently converted to IDR the way it used to be, since that made
// Price show $ while Total stayed Rp on the very same row. The actual IDR figure
// that gets synced (needed for the linked Opex expense/income row and for
// Insights) is derived from this at submit time via updateInvestTotalHint's
// live-rate conversion — same live-rate behavior calcTotal always had, just
// moved out of the editable field and into the hint below it.
function calcTotal() {
  const lot = parseAmt('inputLot');
  const price = parseAmt('inputPrice');
  const stock = document.getElementById('inputStock').value;
  const ccy = getStockCcy(stock);
  const prefixEl = document.getElementById('investTotalPrefix');
  if (prefixEl) prefixEl.textContent = ccyPrefix(ccy);
  if (lot && price) {
    const total = lot * price;
    document.getElementById('inputTotal').value = ccy === 'IDR'
      ? formatGroupedAmt(Math.round(total))
      : formatGroupedAmt(Number(Math.round(total + 'e2') + 'e-2').toFixed(2));
  }
  updateAvgPrices();
  updateInvestTotalHint();
}

// `total` is what's shown in the field (rounded to 2dp for display). When it
// still matches lot × price — i.e. the field is calcTotal's own auto-calculated
// value, not a manual override — convert from the full-precision lot × price
// instead, so there's only ONE rounding step down to IDR (matching the original
// single-step Math.round(lot*price*rate) behavior) rather than rounding once to
// native cents for display and again to IDR here. A genuinely manually-edited
// Total (differs from lot × price by more than half a cent) is still honored
// as-is, since that's the user's explicit override.
function investTotalToIdr(total, ccy, lot, price) {
  const autoCalculated = lot != null && price != null && Math.abs(total - lot * price) < 0.005;
  const base = autoCalculated ? lot * price : total;
  return ccy === 'IDR' ? Math.round(base) : Math.round(base * getCcyRate(ccy));
}

function updateInvestTotalHint() {
  const hintEl = document.getElementById('investTotalHint');
  if (!hintEl) return;
  const stock = document.getElementById('inputStock').value.trim();
  const ccy = getStockCcy(stock);
  if (ccy === 'IDR') { hintEl.style.display = 'none'; hintEl.textContent = ''; return; }
  const total = parseAmt('inputTotal');
  const lot = parseAmt('inputLot');
  const price = parseAmt('inputPrice');
  hintEl.style.display = 'block';
  hintEl.textContent = total > 0
    ? `≈ ${fRp(investTotalToIdr(total, ccy, lot, price))} at today's rate`
    : `Total is in ${ccy} — converted to IDR at today's rate when saved`;
}

function updateAvgPrices() {
  const stock  = document.getElementById('inputStock').value.trim();
  const lot    = parseAmt('inputLot');
  const price  = parseAmt('inputPrice');
  const action = document.querySelector('#form-invest .action-btn.active')?.dataset.action || 'Buy';
  const ccy    = getStockCcy(stock);

  const curEl = document.getElementById('investCurrentAvg');
  const newEl = document.getElementById('investNewAvg');
  if (!curEl || !newEl) return;

  // Use r.price (native currency: USD for US stocks, IDR for others) × r.lot
  // so avgPrice = sum(price × lot) / sum(lot) — no fx-rate conversion needed
  let buyLots = 0, buyPriceWeighted = 0, sellLots = 0;
  if (stock) {
    getAllInvestRows().forEach(r => {
      if (r.stock !== stock) return;
      if (r.action === 'Buy') { buyLots += r.lot; buyPriceWeighted += r.price * r.lot; }
      else if (r.action === 'Sell') { sellLots += r.lot; }
    });
  }
  const netLots = buyLots - sellLots;
  const avgPrice = buyLots > 0 ? buyPriceWeighted / buyLots : 0;

  // String-exponent rounding avoids IEEE 754 half-point errors (e.g. 147.325*100 = 14732.4999...)
  const fmt = (v) => ccy !== 'IDR' ? `${ccyPrefix(ccy)}${Number(Math.round(v + 'e2') + 'e-2').toFixed(2)}` : fRp(Math.round(v));

  if (buyLots > 0) {
    curEl.textContent = fmt(avgPrice);
  } else {
    curEl.textContent = '—';
  }

  if (action === 'Buy' && lot > 0 && price > 0) {
    // price typed by user is in same native currency as r.price
    const newAvg = (buyPriceWeighted + price * lot) / (buyLots + lot);
    newEl.textContent = fmt(newAvg);
  } else if (action === 'Sell' && lot > 0 && netLots > 0) {
    newEl.textContent = lot >= netLots ? '—' : curEl.textContent;
  } else {
    newEl.textContent = '—';
  }
}

// ── FORMAT ────────────────────────────────────────────────────
function fRp(n){if(!n&&n!==0)return'';return'Rp'+Number(n).toLocaleString('id-ID')}
function fRpS(n){
  if(!n)return'Rp0';
  // Wide layout (tablet/desktop landscape) has room for the exact amount, e.g. Rp14.500.000
  if(document.documentElement.classList.contains('wide'))return(n<0?'-':'')+'Rp'+Math.abs(Math.round(n)).toLocaleString('id-ID');
  if(n>=1000000000)return'Rp'+(n/1000000000).toFixed(1)+'M';
  if(n>=1000000)return'Rp'+(n/1000000).toFixed(1)+'jt';
  if(n>=1000)return'Rp'+(n/1000).toFixed(0)+'rb';
  return'Rp'+n;
}

function parseAmt(idOrEl) {
  const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
  const val = el ? el.value : (typeof idOrEl === 'string' ? idOrEl : '');
  if (!val) return 0;
  const clean = String(val).replace(/,/g, '');
  return parseFloat(clean) || 0;
}

function parseGroupedAmt(idOrEl) {
  return parseAmt(idOrEl);
}

function formatGroupedAmt(n) {
  if (n === null || n === undefined || n === '') return '';
  const num = Number(n);
  if (isNaN(num)) return '';
  const parts = String(n).split('.');
  const intFormatted = Number(parts[0]).toLocaleString('en-US');
  return parts.length > 1 ? `${intFormatted}.${parts[1]}` : intFormatted;
}

function formatAmountInput(el, e) {
  if (!el) return;
  let rawVal = el.value;
  if (!rawVal) return;

  const cursorFromEnd = rawVal.length - (el.selectionEnd || 0);

  // If the user explicitly typed a comma (common on iOS decimal keyboards in some locales),
  // convert that specific comma into a dot before we process and strip formatting commas.
  if (e && e.data === ',') {
    const pos = el.selectionEnd;
    if (pos > 0 && rawVal[pos - 1] === ',') {
      rawVal = rawVal.substring(0, pos - 1) + '.' + rawVal.substring(pos);
    }
  }

  // Commas are only ever thousands-grouping separators inserted by this function;
  // "." is the sole decimal separator (typed explicitly on the keypad). Strip commas.
  rawVal = rawVal.replace(/,/g, '');

  let hasDecimal = false;
  let intStr = rawVal;
  let decStr = '';

  if (rawVal.includes('.')) {
    hasDecimal = true;
    const parts = rawVal.split('.');
    intStr = parts[0];
    decStr = parts.slice(1).join('');
  }

  const cleanIntDigits = intStr.replace(/\D/g, '');
  const cleanDecDigits = decStr.replace(/\D/g, '');

  let formattedInt = '';
  if (cleanIntDigits) {
    const trimmedInt = cleanIntDigits.replace(/^0+(?=\d)/, '');
    formattedInt = trimmedInt.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  } else if (hasDecimal) {
    formattedInt = '0';
  }

  let formatted = formattedInt;
  if (hasDecimal) {
    formatted += '.' + cleanDecDigits;
  }

  el.value = formatted;

  if (el.selectionEnd != null) {
    const newPos = Math.max(0, formatted.length - cursorFromEnd);
    el.setSelectionRange(newPos, newPos);
  }
}

function formatDecimalAmountInput(el, e) {
  formatAmountInput(el, e);
}

function fUSD(idrAmount, rate){
  if(!rate||!idrAmount)return'$0';
  const usd=idrAmount/rate;
  if(usd>=1000)return'$'+Math.round(usd).toLocaleString('en-US');
  return'$'+usd.toFixed(2);
}
function dualVal(idrAmount, rate){
  return`<div class="val-usd">${fUSD(idrAmount,rate)}</div><div class="val-idr">${fRpS(Math.round(idrAmount))}</div>`;
}
function dualValSm(idrAmount, rate){
  return`<div class="val-usd-sm">${fUSD(idrAmount,rate)}</div><div class="val-idr-sm">${fRpS(Math.round(idrAmount))}</div>`;
}
function dualValSmFull(idrAmount, rate){
  return`<div class="val-usd-sm">${fUSD(idrAmount,rate)}</div><div class="val-idr-sm">${fRp(Math.round(idrAmount))}</div>`;
}
function pnlDual(pnl, pnlPct, rate, color){
  const sign=pnl>=0?'+':'';
  const usdStr=fUSD(Math.abs(pnl),rate);
  return`<div class="pnl-dual" style="color:${color}">${sign}${pnlPct.toFixed(1)}% · ${pnl>=0?'+':'-'}${usdStr} · ${sign}${fRpS(Math.round(pnl))}</div>`;
}

// ── TABS ──────────────────────────────────────────────────────
function switchTab(tab, el) {
  closeInputOverlay();
  closeGoalsOverlay();
  closeConfigItemOverlay();
  closeSetBalanceOverlay();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('nav-more').classList.remove('sub-active');
  const navBtn = tab === 'profile' ? document.getElementById('nav-more') : document.getElementById('nav-'+tab);
  if(navBtn) navBtn.classList.add('active');
  document.getElementById('page-'+tab).classList.add('active');

  if(tab==='home'){
    if(typeof calScrollToCurrentMonth==='function') calScrollToCurrentMonth();
    if(!histLoaded) onHistLoaded(()=>fetchCurrentMonth().then(()=>{ calInited=false; initCalendar(); calRefreshOpenDayPanel(); }));
    else fetchCurrentMonth().then(()=>{ calInited=false; initCalendar(); calRefreshOpenDayPanel(); });
  }
  if(tab==='insights'){
    const insPage=document.getElementById('page-insights');
    if(insPage)insPage.scrollTop=0;
    const wCtrl=document.getElementById('weeklyControls');if(wCtrl)wCtrl.style.display=insightsMode==='weekly'?'block':'none';
    const mCtrl=document.getElementById('monthlyControls');if(mCtrl)mCtrl.style.display=insightsMode==='monthly'?'block':'none';
    const yCtrl=document.getElementById('yearlyControls');if(yCtrl)yCtrl.style.display=insightsMode==='yearly'?'block':'none';
    const cCtrl=document.getElementById('categoryControls');if(cCtrl)cCtrl.style.display=insightsMode==='category'?'block':'none';
    const wEls=['weeklySummary','weeklyBarCard','weeklyDonutCard'];
    const mEls=['monthlySummary','monthlyBarCard','monthlyDonutCard'];
    const yEls=['yearlySummary','yearlyBarCard','yearlyMonthCard','yearlyDonutCard'];
    const cEls=['catRankingCard','catTrendCard'];
    wEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=insightsMode==='weekly'?'block':'none'});
    mEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=insightsMode==='monthly'?'block':'none'});
    yEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=insightsMode==='yearly'?'block':'none'});
    cEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=insightsMode==='category'?'block':'none'});
    if(!histLoaded) {
      const activeSummary=insightsMode==='weekly'?'weeklySummary':insightsMode==='yearly'?'yearlySummary':'monthlySummary';
      const el=document.getElementById(activeSummary);
      if(el)el.innerHTML='<div class="chart-loading">Loading data…</div>';
      onHistLoaded(()=>{
        // fetchLiveInvest() must run so any dual-purpose FX account's Invest-derived activity is visible here
        fetchLiveInvest().then(()=>{ buildAccountBalances(); setInsightsSubPage(insightsSubPage); });
      });
    } else {
      fetchLiveInvest().then(()=>{ buildAccountBalances(); setInsightsSubPage(insightsSubPage); });
    }
  }
  if(tab==='networth'){
    if(!histLoaded) onHistLoaded(()=>initNetWorth());
    else initNetWorth();
  }
  if(tab==='goals'){
    fetchFxRates();
    const _loadGoals = () => Promise.all([
      fetchSheetPrices(),
      fetchLiveInvest().catch(() => {})
    ]).then(() => {
      buildAccountBalances();
      return fetchGoals();
    });
    if(!histLoaded) onHistLoaded(_loadGoals);
    else _loadGoals();
  }
  if(tab==='recurring'){
    renderRecurringList();
    fetchRecurring().then(() => renderRecurringList());
  }
  // `const EmailImport` is not a window property, so test with typeof (window.EmailImport is always undefined).
  if(tab==='emailimport' && typeof EmailImport !== 'undefined') EmailImport.onPageOpen();
  if(tab==='settings'){
    fetchConfig().then(renderSettingsLists);
  }
  if(tab==='account'){
    loadAccountUsageInfo();
  }
  if(tab==='search'){
    initSearchPage();
    if(!histLoaded) onHistLoaded(()=>{ renderSearchOrMonitor(); });
  }
}

function openInputOverlay() {
  // Reset edit state
  overlayEditRowIndex = null;
  overlayEditId = null;
  overlayEditMode = false;
  const submitBtn = document.getElementById('submitOpexBtn');
  if (submitBtn) submitBtn.textContent = 'Save Transaction';
  const delBtn = document.getElementById('deleteOpexBtn');
  if (delBtn) delBtn.style.display = 'none';
  // Reset to expense mode
  const expBtn = document.querySelector('.pill-toggle-btn[data-mode="expense"]');
  if (expBtn) setInputMode('expense', expBtn);
  // Default to selected calendar date, fall back to today
  const t = calCurrentDateStr || todayISO();
  const rawEl = document.getElementById('inputDateRaw');
  if (rawEl) {
    const b = curMonthBounds();
    rawEl.min = b.min; rawEl.max = b.max;
    rawEl.value = t; document.getElementById('inputDateText').textContent = isoDisp(t);
  }
  // Clear fields
  ['inputTx','inputAmount','inputNotes'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  // Reset recurring toggle (prevents stale state bleeding into edit sessions)
  document.getElementById('inputRecurring').checked = false;
  resetRecurringScheduleFields();
  document.getElementById('recurringDayRow').style.display = 'none';
  document.getElementById('recurringEndRow').style.display = 'none';
  document.getElementById('inputRecurringEndMonth').value = '';
  document.getElementById('inputRecurringEndYear').value = '';
  if (typeof buildSmartPills === 'function') buildSmartPills();
  checkCcInstallmentVisibility();
  const ov = document.getElementById('inputOverlay');
  ov.classList.add('open');
  adjustOverlayForVisualViewport();
  // Focus first input after slide animation completes
  setTimeout(() => {
    const f = document.getElementById('inputTx');
    if (f) f.focus();
  }, 360);
}

function closeInputOverlay() {
  const ov = document.getElementById('inputOverlay');
  if (ov) {
    ov.classList.remove('open');
    ov.style.top = '';
    ov.style.height = '';
  }
  // Reset edit state
  overlayEditRowIndex = null;
  overlayEditId = null;
  overlayEditMode = false;
  overlayEditType = 'opex';
  const submitBtn = document.getElementById('submitOpexBtn');
  if (submitBtn) submitBtn.textContent = 'Save Transaction';
  const delBtn = document.getElementById('deleteOpexBtn');
  if (delBtn) delBtn.style.display = 'none';
  const submitInvestBtn = document.getElementById('submitInvestBtn');
  if (submitInvestBtn) submitInvestBtn.textContent = 'Save Investment';
  const delInvestBtn = document.getElementById('deleteInvestBtn');
  if (delInvestBtn) delInvestBtn.style.display = 'none';
  const submitTransferBtn = document.getElementById('submitTransferBtn');
  if (submitTransferBtn) submitTransferBtn.textContent = 'Save Transfer';
  const delTransferBtn = document.getElementById('deleteTransferBtn');
  if (delTransferBtn) delTransferBtn.style.display = 'none';
}

// ── Handle bar swipe-down to close ───────────────────────────
// Attach directly — script runs after DOM is parsed, no DOMContentLoaded needed.
// closeGoalsOverlay/closeConfigItemOverlay live in ui-settings.js, which loads
// after this inline script — wrap in arrow functions so the lookup happens at
// swipe time (once ui-settings.js has loaded), not here. A direct reference
// throws ReferenceError immediately, which used to halt this script's
// execution before it could reach the DOMContentLoaded listener further down
// (the one that calls Auth.markAppReady()) — leaving the sign-in overlay
// stuck forever even after a successful sign-in.
attachSwipeClose('inputSheetHandle', closeInputOverlay);
attachSwipeClose('goalsSheetHandle', () => closeGoalsOverlay());
attachSwipeClose('configItemSheetHandle', () => closeConfigItemOverlay());

function openInputFromHome() {
  openInputOverlay();
}

// ── OPEX FX (foreign-currency Expense/Income) ──────────────────
// Lets a travel Expense/Income be entered in the PM's own currency (e.g. a USD
// account) instead of forcing a mental IDR conversion. The IDR amount that's
// actually stored/used everywhere else (Insights, category totals, account
// balances) is computed from that currency's own weighted-average buy price
// (see getFxAvgRate) — the real cost basis of the USD sitting in that account —
// not a live/spot rate, which would misstate what those units actually cost.
const CCY_SYMBOLS = { USD:'$', SGD:'S$', EUR:'€', GBP:'£', AUD:'A$', CHF:'CHF ', JPY:'¥', MYR:'RM', THB:'฿', CNY:'¥' };

function getOpexPmCcy(pmName) {
  const name = (pmName || '').trim();
  if (!name) return 'IDR';
  if (ACCOUNT_CCY[name]) return ACCOUNT_CCY[name].toUpperCase();
  const item = CONFIG_ITEMS.find(i => (i.kind === 'pm' || i.kind === 'account') && i.name === name);
  return (item && item.ccy) ? item.ccy.toUpperCase() : 'IDR';
}

// Weighted-average IDR cost per unit of `ccy`, from that currency's own Buy
// history (same math as updateAvgPrices()'s stock avgPrice) — falls back to
// today's live rate only when there's no purchase history yet (e.g. the very
// first time this currency is ever spent).
function getFxAvgRate(pmName, ccy) {
  ccy = (ccy || '').toUpperCase();
  if (!ccy || ccy === 'IDR') return 1;
  let buyLots = 0, buyPriceWeighted = 0;
  getAllInvestRows().forEach(r => {
    if (r.action !== 'Buy') return;
    if (!isFxAccountMatch(pmName, ccy, r.stock)) return;
    buyLots += Number(r.lot) || 0;
    buyPriceWeighted += (Number(r.price) || 0) * (Number(r.lot) || 0);
  });
  if (buyLots > 0) return buyPriceWeighted / buyLots;
  return getCcyRate(ccy);
}

// Re-evaluates the selected PM's currency and flips the Amount field between
// plain IDR and "enter it in that currency" mode. Called on inputPm blur.
function onOpexPmSelect() {
  const pm = document.getElementById('inputPm').value.trim();
  const ccy = getOpexPmCcy(pm);
  const prefixEl = document.getElementById('opexAmountPrefix');
  if (prefixEl) prefixEl.textContent = ccy === 'IDR' ? 'Rp' : (CCY_SYMBOLS[ccy] || ccy + ' ');
  updateOpexFxHint();
}

function updateOpexFxHint() {
  const hintEl = document.getElementById('opexFxHint');
  if (!hintEl) return;
  const pm = document.getElementById('inputPm').value.trim();
  const ccy = getOpexPmCcy(pm);
  if (ccy === 'IDR') { hintEl.style.display = 'none'; hintEl.textContent = ''; return; }
  const native = parseAmt('inputAmount');
  const rate = getFxAvgRate(pm, ccy);
  hintEl.style.display = 'block';
  hintEl.textContent = native > 0
    ? `≈ ${fRp(Math.round(native * rate))} at avg ${fRp(Math.round(rate))}/${ccy}`
    : `Amount is in ${ccy} — converted at avg ${fRp(Math.round(rate))}/${ccy}`;
}

// ── TRANSFER FX ──────────────────────────────────────────────
// A Transfer only ever moves cash within ONE currency (it's not a conversion) —
// so it's FX-aware only when From and To share the same non-IDR currency (e.g.
// moving USD between two USD accounts while travelling). From/To in different
// currencies is refused; that's what Invest (Buy/Sell the FX pair) is for.
function resolveXfrFx() {
  const fromPm = document.getElementById('xfrFrom').value.trim();
  const toPm = document.getElementById('xfrTo').value.trim();
  const fromCcy = getOpexPmCcy(fromPm);
  const toCcy = getOpexPmCcy(toPm);
  const mismatch = !!(fromPm && toPm && fromCcy !== toCcy);
  return { fromPm, toPm, ccy: fromCcy, mismatch };
}

function onXfrAcctSelect() {
  const { ccy, mismatch } = resolveXfrFx();
  const prefixEl = document.getElementById('xfrAmountPrefix');
  if (prefixEl) prefixEl.textContent = mismatch ? 'Rp' : ccyPrefix(ccy);
  updateXfrFxHint();
}

function updateXfrFxHint() {
  const hintEl = document.getElementById('xfrFxHint');
  if (!hintEl) return;
  const { fromPm, ccy, mismatch } = resolveXfrFx();
  if (mismatch) {
    hintEl.style.display = 'block';
    hintEl.style.color = 'var(--red)';
    hintEl.textContent = 'From and To are different currencies — Transfer only moves cash within one currency. Use Invest to convert currencies.';
    return;
  }
  hintEl.style.color = 'var(--text2)';
  if (ccy === 'IDR') { hintEl.style.display = 'none'; hintEl.textContent = ''; return; }
  const native = parseAmt('xfrAmount');
  const rate = getFxAvgRate(fromPm, ccy);
  hintEl.style.display = 'block';
  hintEl.textContent = native > 0
    ? `≈ ${fRp(Math.round(native * rate))} at avg ${fRp(Math.round(rate))}/${ccy}`
    : `Amount is in ${ccy} — converted at avg ${fRp(Math.round(rate))}/${ccy}`;
}

// ── SUBMIT OPEX ───────────────────────────────────────────────
async function submitOpex() {
  if (isSyncing) return;
  if (overlayEditMode && overlayEditType === 'opex') {
    isSyncing = true;
    // Was: updateTransaction() called without await. isSyncing was then cleared, and the
    // recurring rule below created, before the edit's own network request had resolved —
    // the "guard" did nothing for the part of the edit that actually takes time, and a
    // failed edit still got a recurring rule created as if it had succeeded.
    const updateOk = await updateTransaction();
    if (updateOk && document.getElementById('inputRecurring').checked) {
      const _txDate = document.getElementById('inputDateRaw').value;
      const _sched = _readRecurringSchedule('inputRecurringFreq', 'inputRecurringInterval', 'inputRecurringStart', _txDate);
      if (_sched) {
        const _tx     = sanitizeInput(document.getElementById('inputTx').value, 100).trim();
        const _pm     = sanitizeInput(document.getElementById('inputPm').value, 50).trim();
        const _pmCcy  = getOpexPmCcy(_pm);
        let _amount   = parseGroupedAmt('inputAmount');
        if (_pmCcy !== 'IDR') _amount = Math.round(_amount * getFxAvgRate(_pm, _pmCcy));
        const _cat    = sanitizeInput(document.getElementById('inputCat').value, 50).trim();
        const _notes  = sanitizeInput(document.getElementById('inputNotes').value, 200);
        const _end    = _getEndMonthValue('inputRecurringEndMonth', 'inputRecurringEndYear');
        if (_tx && _amount && _cat && _pm) {
          const rules = loadRecurring();
          rules.push({
            id: Date.now(), type: inputMode,
            tx: _tx, cat: _cat, amount: _amount, pm: _pm, notes: _notes,
            ..._sched, active: true,
            // the transaction being saved is itself the start-date occurrence when they coincide
            lastFired: _sched.startDate === _txDate ? _sched.startDate : '',
            endMonth: _end || null
          });
          saveRecurring(rules);
          resetRecurringToggle();
          showToast('Recurring rule created ✓', 'success');
        }
      }
    }
    isSyncing = false;
    return;
  }
  // Set the guard before reading/validating fields (not after the optimistic
  // txHistory.unshift below) so a second rapid call can't sneak in and create a
  // duplicate local entry in the gap — see addSelectedRecurring for the same pattern.
  isSyncing = true;
  const date=document.getElementById('inputDateRaw').value;
  const tx=sanitizeInput(document.getElementById('inputTx').value,100);
  let amount=parseGroupedAmt('inputAmount');
  const cat=sanitizeInput(document.getElementById('inputCat').value,50);
  const pm=sanitizeInput(document.getElementById('inputPm').value,50);
  const notes=sanitizeInput(document.getElementById('inputNotes').value,200);
  if(!date||!tx||!amount||!cat||!pm){isSyncing=false;showToast('All fields required','error');return}

  // Foreign-currency PM (e.g. a USD account while travelling): the amount just
  // typed is in that currency, not IDR — convert to IDR (at that currency's own
  // weighted-average cost, see getFxAvgRate) for everything downstream that
  // assumes IDR, while keeping the native amount/ccy for the sheet and for
  // depleting/crediting that account's own native balance.
  const pmCcy = getOpexPmCcy(pm);
  let nativeAmount = 0, ccy = '';
  if (pmCcy !== 'IDR') {
    nativeAmount = amount;
    ccy = pmCcy;
    amount = Math.round(nativeAmount * getFxAvgRate(pm, pmCcy));
  }

  // CC Installment Logic
  const isInstallment = document.getElementById('ccInstallmentBtn').classList.contains('active');
  const installmentMonths = parseInt(document.getElementById('inputInstallmentMonths').value) || 0;
  if (isInstallment) {
    if (installmentMonths < 2) {
      isSyncing = false;
      showToast('Installment period must be at least 2 months', 'error');
      return;
    }
  }

  let finalAmount = amount;
  let finalNativeAmount = nativeAmount;
  let finalTx = tx;
  if (isInstallment) {
    finalAmount = Math.round(amount / installmentMonths);
    if (finalNativeAmount) finalNativeAmount = Math.round((finalNativeAmount / installmentMonths) * 100) / 100;
    finalTx = `${tx} (1/${installmentMonths})`;
  }

  const isFuture = date > todayISO();
  const r = {id:Date.now(),date,tx:finalTx,amount:finalAmount,category:cat,pm,notes,type:inputMode,synced:false,future:isFuture,nativeAmount:finalNativeAmount,ccy};
  txHistory.unshift(r);
  queue.push({...r, action:inputMode});
  saveLocal();updateStatus();
  buildAccountBalances();
  renderAccountBalanceCards();
  // Navigate back to Home immediately, with Saving toast
  switchTab('home', null);
  showToast('Saving…', 'loading', 0);
  syncOpex(r).then(ok=>{
    isSyncing = false;
    if(ok){
      queue=queue.filter(q=>q.id!==r.id);
      txHistory=txHistory.map(h=>h.id===r.id?{...h,synced:true}:h);
      saveLocal();updateStatus();showToast('Saved ✓','success');
      // Optimistically write the new row into nota_curMonth cache so the transaction
      // survives a browser close before fetchCurrentMonth(true) completes.
      // fetchCurrentMonth(true) will overwrite this with the authoritative sheet row
      // (which includes rowIndex, making it editable). Without this, deleting the
      // cache key first creates a window where a reload shows no transaction at all.
      const cacheKey=curMonthCacheKey();
      const dateParts=r.date.split('-');
      const optimisticRow={d:parseInt(dateParts[2]),cat:r.category,tx:r.tx,pm:r.pm,...(r.notes?{notes:r.notes}:{}),...(r.type==='income'?{inc:r.amount}:{exp:r.amount}),...(r.ccy?{nativeAmount:r.nativeAmount,ccy:r.ccy}:{})};
      const cachedRows=JSON.parse(localStorage.getItem(cacheKey)||'[]');
      cachedRows.push(optimisticRow);
      localStorage.setItem(cacheKey,JSON.stringify(cachedRows));
      // Force-refresh so the new row gets rowIndex from the sheet (makes it editable)
      fetchCurrentMonth(true).then(rowCount=>{calInited=false;if(document.getElementById('page-home').classList.contains('active')){initCalendar();calRefreshOpenDayPanel();}buildAccountBalances();renderAccountBalanceCards();if(rowCount===0)showToast('Sent to sheet — couldn\'t confirm readback','error',6000);});
    }
    else showToast(navigator.onLine ? 'Save failed' : 'Saved offline — will sync ✓', '');
  });
  // Save recurring rule if toggle is ON
  if (isInstallment) {
    const endMonthVal = getEndMonth(date, installmentMonths);
    const rules = loadRecurring();
    rules.push({
      id: Date.now() + 1,
      type: 'expense',
      tx: `${tx} (Installment)`,
      cat,
      amount: finalAmount,
      pm,
      notes: notes || '',
      dayOfMonth: parseInt(date.split('-')[2]) || new Date().getDate(),
      active: true,
      lastFired: dateToMonthKey(date),
      endMonth: endMonthVal,
      installmentTotal: installmentMonths,
      installmentStart: dateToMonthKey(date),
      frequency: 'monthly',
      interval: 1,
      monthOfYear: parseInt(date.split('-')[1]) || 1,
      startDate: date
    });
    saveRecurring(rules);
  } else if (document.getElementById('inputRecurring').checked) {
    const sched = _readRecurringSchedule('inputRecurringFreq', 'inputRecurringInterval', 'inputRecurringStart', date);
    if (sched) {
      const endMonth = _getEndMonthValue('inputRecurringEndMonth', 'inputRecurringEndYear');
      const rules = loadRecurring();
      rules.push({
        id: Date.now(),
        type: inputMode,
        tx, cat, amount, pm, notes,
        ...sched,
        active: true,
        // the transaction being saved is itself the start-date occurrence when they coincide
        lastFired: sched.startDate === date ? sched.startDate : '',
        endMonth: endMonth || null
      });
      saveRecurring(rules);
    }
  }
  resetOpexForm();
}

function resetOpexForm() {
  const t=todayISO();
  document.getElementById('inputDateRaw').value=t;
  document.getElementById('inputDateText').textContent=isoDisp(t);
  document.getElementById('inputTx').value='';
  document.getElementById('inputAmount').value='';
  document.getElementById('inputCat').value='';
  document.getElementById('inputPm').value='';
  document.getElementById('inputNotes').value='';
  resetRecurringToggle();
  checkCcInstallmentVisibility();
  onOpexPmSelect();
}

// ── TRANSFER ──────────────────────────────────────────────────
function submitTransfer() {
  if (isSyncing) return;
  if (overlayEditMode && overlayEditType === 'transfer') { updateTransferTransaction(); return; }
  isSyncing = true;
  const date = document.getElementById('xfrDateRaw').value;
  const fromPm = sanitizeInput(document.getElementById('xfrFrom').value, 50).trim();
  const toPm = sanitizeInput(document.getElementById('xfrTo').value, 50).trim();
  let amount = parseGroupedAmt('xfrAmount');
  const notes = sanitizeInput(document.getElementById('xfrNotes').value, 200);
  if (!date || !fromPm || !toPm || !amount) { isSyncing = false; showToast('All fields required', 'error'); return; }
  if (fromPm === toPm) { isSyncing = false; showToast('From and To must be different', 'error'); return; }
  const { ccy: xfrCcy, mismatch: xfrMismatch } = resolveXfrFx();
  if (xfrMismatch) { isSyncing = false; showToast('From and To are different currencies — use Invest to convert', 'error'); return; }
  let nativeAmount = 0, ccy = '';
  if (xfrCcy !== 'IDR') {
    nativeAmount = amount;
    ccy = xfrCcy;
    amount = Math.round(nativeAmount * getFxAvgRate(fromPm, xfrCcy));
  }
  const r = { id: Date.now(), date, fromPm, toPm, amount, notes, tx: 'Transfer', type: 'transfer', synced: false, nativeAmount, ccy };
  switchTab('home', null);
  showToast('Saving…', 'loading', 0);

  // Optimistically save transfer locally and recompute balances
  txHistory.unshift(r);
  queue.push({...r});
  saveLocal();updateStatus();
  buildAccountBalances();
  renderAccountBalanceCards();

  syncTransfer(r).then(ok => {
    isSyncing = false;
    if (ok) {
      r.synced = true;
      queue = queue.filter(q => q.id !== r.id);
      saveLocal();updateStatus();
      showToast('Saved ✓', 'success');
      Promise.all([
        fetchCurrentMonth(true),
        loadHistData(),
      ]).then(() => {
        calInited = false;
        if (document.getElementById('page-home').classList.contains('active')) { initCalendar(); calRefreshOpenDayPanel(); }
        buildAccountBalances();
        renderAccountBalanceCards();
      });
    } else {
      // Left in queue — retryPendingQueue() will resync it automatically on next load/focus.
      showToast(navigator.onLine ? 'Save failed' : 'Saved offline — will sync ✓', '');
    }
  });
  resetTransferForm();
}

function resetTransferForm() {
  const t = todayISO();
  document.getElementById('xfrDateRaw').value = t;
  document.getElementById('xfrDateText').textContent = isoDisp(t);
  document.getElementById('xfrFrom').value = '';
  document.getElementById('xfrTo').value = '';
  document.getElementById('xfrAmount').value = '';
  document.getElementById('xfrNotes').value = '';
  onXfrAcctSelect();
}

async function syncTransfer(r) {
  try {
    const payload = {
      type: 'transfer',
      date: isoSheetDate(r.date), month: isoMonthKey(r.date),
      fromPm: r.fromPm, toPm: r.toPm,
      amount: r.amount, notes: r.notes || '',
      nativeAmount: r.nativeAmount || '', ccy: r.ccy || '',
      clientId: String(r.id),
    };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    return j.status === 'ok' && !j.version;
  } catch (e) { console.error('[syncTransfer]', e.message); return false; }
}

async function deleteTransfer(txId) {
  if (!txId) return;
  showToast('Deleting…', 'loading', 0);

  // Capture before the queue is trimmed below.
  const wasQueued = queue.some(q => q.id === txId || String(q.id) === String(txId));

  // Optimistically remove transfer from local memory and update balances immediately
  txHistory = txHistory.filter(h => h.id !== txId && h.txId !== txId && String(h.id) !== String(txId));
  HIST.opex = (HIST.opex || []).filter(r => r.id !== txId && String(r.id) !== String(txId));
  // Also drop it from the retry queue — otherwise an unsynced transfer deleted before
  // retryPendingQueue() gets to it would resurrect as a new transaction after deletion.
  queue = queue.filter(q => q.id !== txId && String(q.id) !== String(txId));
  saveLocal();
  buildAccountBalances();
  renderAccountBalanceCards();

  // Never reached the server — nothing to delete there, and the queue entry above
  // is already gone so it won't resurrect on the next retry.
  if (wasQueued) {
    showToast('Deleted ✓', 'success');
    return;
  }

  try {
    const payload = { type: 'transfer', action: 'delete', id: txId };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      showToast('Deleted ✓', 'success');
      Promise.all([fetchCurrentMonth(true), loadHistData()]).then(() => {
        calInited = false;
        if (document.getElementById('page-home').classList.contains('active')) { initCalendar(); calRefreshOpenDayPanel(); }
        buildAccountBalances();
        renderAccountBalanceCards();
      });
    } else {
      showToast('Delete failed', 'error');
    }
  } catch (e) { showToast(navigator.onLine ? 'Delete failed' : 'Offline — saved locally', navigator.onLine ? 'error' : ''); }
}

function openEditTransferOverlay(tx, dateStr = calCurrentDateStr) {
  if (!tx) return;
  // Fall back to the client-generated id (same pattern as opex/invest) so an unsynced
  // transfer still in the retry queue can be identified as such by updateTransferTransaction/
  // deleteTransfer, rather than only ever resolving a real server-issued sheetId.
  overlayEditId   = tx.sheetId || tx.id || null;
  overlayEditMode = true;
  overlayEditType = 'transfer';
  const btn = document.querySelector('.pill-toggle-btn[data-mode="transfer"]');
  if (btn) setInputMode('transfer', btn);
  const rawEl = document.getElementById('xfrDateRaw');
  if (rawEl && dateStr) {
    rawEl.value = dateStr;
    document.getElementById('xfrDateText').textContent = isoDisp(dateStr);
  }
  document.getElementById('xfrFrom').value   = tx.transferFromPm || '';
  document.getElementById('xfrTo').value     = tx.transferToPm   || '';
  document.getElementById('xfrAmount').value = formatGroupedAmt(tx.ccy ? tx.nativeAmount : tx.amt);
  document.getElementById('xfrNotes').value  = tx.notes || '';
  onXfrAcctSelect();
  document.getElementById('submitTransferBtn').textContent = 'Update Transfer';
  document.getElementById('deleteTransferBtn').style.display = 'block';
  document.getElementById('inputOverlay').classList.add('open');
}

async function updateTransferTransaction() {
  const txId = overlayEditId;
  const date = document.getElementById('xfrDateRaw').value;
  const fromPm = sanitizeInput(document.getElementById('xfrFrom').value, 50).trim();
  const toPm = sanitizeInput(document.getElementById('xfrTo').value, 50).trim();
  let amount = parseGroupedAmt('xfrAmount');
  const notes = sanitizeInput(document.getElementById('xfrNotes').value, 200);
  if (!date || !fromPm || !toPm || !amount) { showToast('All fields required', 'error'); return; }
  if (fromPm === toPm) { showToast('From and To must be different', 'error'); return; }
  const { ccy: xfrCcy, mismatch: xfrMismatch } = resolveXfrFx();
  if (xfrMismatch) { showToast('From and To are different currencies — use Invest to convert', 'error'); return; }
  let nativeAmount = 0, ccy = '';
  if (xfrCcy !== 'IDR') {
    nativeAmount = amount;
    ccy = xfrCcy;
    amount = Math.round(nativeAmount * getFxAvgRate(fromPm, xfrCcy));
  }

  closeInputOverlay();

  // If this transfer never reached the server (still sitting in the local retry
  // queue), there's no sheet row for an "edit" action to find. Patch the queued
  // create and its txHistory entry in place instead — retryPendingQueue() will send
  // the new values as a fresh create next time it runs.
  const queuedIdx = queue.findIndex(q => q.id === txId || String(q.id) === String(txId));
  if (queuedIdx !== -1) {
    const patch = { date, fromPm, toPm, amount, notes, nativeAmount, ccy };
    queue[queuedIdx] = { ...queue[queuedIdx], ...patch };
    txHistory = txHistory.map(h => (h.id === txId || String(h.id) === String(txId)) ? { ...h, ...patch } : h);
    saveLocal();
    calInited = false; initCalendar();
    buildAccountBalances();
    renderAccountBalanceCards();
    showToast('Updated ✓', 'success');
    return;
  }

  showToast('Updating…', 'loading', 0);

  // Optimistically drop the old linked pair locally — the refetch below replaces
  // it with the authoritative updated rows (same pattern as deleteTransfer).
  txHistory = txHistory.filter(h => h.id !== txId && String(h.id) !== String(txId));
  HIST.opex = (HIST.opex || []).filter(r => r.id !== txId && String(r.id) !== String(txId));
  saveLocal();
  calInited = false; initCalendar();
  buildAccountBalances();
  renderAccountBalanceCards();

  try {
    const payload = {
      type: 'transfer', action: 'edit', id: txId,
      date: isoSheetDate(date), month: isoMonthKey(date),
      fromPm, toPm, amount, notes,
      nativeAmount: nativeAmount || '', ccy: ccy || '',
    };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      showToast('Updated ✓', 'success');
      await Promise.all([fetchCurrentMonth(true), loadHistData()]);
      calInited = false;
      if (document.getElementById('page-home').classList.contains('active')) { initCalendar(); calRefreshOpenDayPanel(); }
      buildAccountBalances();
      renderAccountBalanceCards();
    } else {
      showToast('Update failed', 'error');
    }
  } catch (e) { showToast(navigator.onLine ? 'Update failed' : 'Offline — saved locally', navigator.onLine ? 'error' : ''); }
}

async function deleteSheetTransferTransaction() {
  if (!confirm('Delete this transfer?')) return;
  const txId = overlayEditId;
  closeInputOverlay();
  await deleteTransfer(txId);
}

// Uncheck "Set as Recurring" and hide/clear its fields — used after a rule has
// been created (or the overlay is closing) so a stray repeat tap/submit has no
// checked recurring data left to resubmit (prevents duplicate rule creation).
function resetRecurringToggle() {
  document.getElementById('inputRecurring').checked=false;
  resetRecurringScheduleFields();
  document.getElementById('recurringDayRow').style.display='none';
  document.getElementById('recurringEndRow').style.display='none';
  document.getElementById('inputRecurringEndMonth').value='';
  document.getElementById('inputRecurringEndYear').value='';
}

// ── LOCAL-ONLY TRANSACTION MUTATIONS ──────────────────────────
// Used as fallback when the server can't be reached or rowIndex is unknown.
// Keeps HIST.opex, txHistory, and the curMonth localStorage cache consistent.

function _applyLocalDelete(isoDate, txName, amount, rowIndex, id, isIncome) {
  const [fy, fm, fd] = isoDate.split('-').map(Number);
  const nl = txName.toLowerCase();
  // HIST.opex — prefer id (unambiguous even with duplicate rows), then rowIndex, then content match
  if (HIST.opex) {
    if (id) {
      HIST.opex = HIST.opex.filter(r => r.id !== id);
    } else if (rowIndex) {
      HIST.opex = HIST.opex.filter(r => r.rowIndex !== rowIndex);
    } else {
      const idx = HIST.opex.findIndex(r =>
        r.y === fy && r.m === fm - 1 && r.d === fd &&
        r.tx.toLowerCase() === nl && (r.exp || r.inc || 0) === amount
      );
      if (idx !== -1) HIST.opex.splice(idx, 1);
    }
  }
  // txHistory / nota_curMonth cache — trim any stuck ghosts of the same transaction down
  // to however many real HIST.opex rows with this exact signature remain. First-match-only
  // removal left a permanently-stuck synced:false ghost behind whenever the deleted row was
  // the sole real backing row and a ghost also existed (the iOS-PWA-kill race — see
  // sigOfSheetRow/sigOfTxHistory). Count-based so deleting one of several genuinely-identical
  // transactions still only removes one.
  const sig = txSig(fd, txName, amount, isIncome);
  const remainingOpexCount = (HIST.opex || [])
    .filter(r => r.y === fy && r.m === fm - 1 && sigOfSheetRow(r) === sig).length;

  let kept = 0;
  txHistory = txHistory.filter(h => {
    if (h.date !== isoDate || sigOfTxHistory(h) !== sig) return true;
    kept++;
    return kept <= remainingOpexCount;
  });
  localStorage.setItem('notapub_history_v2', JSON.stringify(txHistory));

  // queue (nota_queue_v2) — same trim. Without this, a swept txHistory ghost's still-queued
  // retry entry survives, and retryPendingQueue() resurrects it as a brand-new real
  // transaction on the next app load (HIST.opex legitimately has 0 matching rows post-delete,
  // so the "already covered" guard in retryPendingQueue can't catch it).
  let qKept = 0;
  queue = queue.filter(q => {
    if (q.date !== isoDate || sigOfTxHistory(q) !== sig) return true;
    qKept++;
    return qKept <= remainingOpexCount;
  });
  localStorage.setItem('notapub_queue_v2', JSON.stringify(queue));

  const cKey = curMonthCacheKey(fy, fm);
  const cached = JSON.parse(localStorage.getItem(cKey) || '[]');
  let cKept = 0;
  const trimmedCache = cached.filter(r => {
    if (r.d !== fd || sigOfSheetRow(r) !== sig) return true;
    cKept++;
    return cKept <= remainingOpexCount;
  });
  localStorage.setItem(cKey, JSON.stringify(trimmedCache));
}

function _applyLocalEdit(isoDate, txName, amount, newDate, newTx, newAmount, newCat, newPm, newNotes, newIsIncome, rowIndex, id, newNativeAmount, newCcy) {
  const [fy, fm, fd] = isoDate.split('-').map(Number);
  const [nfy, nfm, nfd] = newDate.split('-').map(Number);
  const nl = txName.toLowerCase();
  const newIsFuture = newDate > todayISO();
  // HIST.opex — prefer id (unambiguous even with duplicate rows), then rowIndex, then content match
  if (HIST.opex) {
    HIST.opex = HIST.opex.map(r => {
      const matches = id ? r.id === id
        : rowIndex ? r.rowIndex === rowIndex
        : (r.y === fy && r.m === fm-1 && r.d === fd && r.tx.toLowerCase() === nl && (r.exp||r.inc||0) === amount);
      if (matches) {
        return {...r, y:nfy, m:nfm-1, d:nfd, tx:newTx, cat:newCat, pm:newPm, notes:newNotes||'',
                inc: newIsIncome ? newAmount : 0, exp: newIsIncome ? 0 : newAmount, amt: newAmount, future: newIsFuture,
                nativeAmount: newCcy ? newNativeAmount : 0, ccy: newCcy || ''};
      }
      return r;
    });
    // Defense in depth: an unconfirmed (no-rowIndex) optimistic placeholder for the OLD
    // day can exist separately from the row that was just matched/moved above (e.g. a
    // recurring-add's optimistic cache row that hasn't been reconciled into HIST.opex
    // with a rowIndex yet). calGetMonthData's ghost-filter only recognizes a placeholder
    // as stale when a CONFIRMED row shares its day+signature — but the day was just
    // vacated by this edit, so nothing on the old day will ever look "confirmed" again.
    // Strip any such leftover here so it can't survive to be re-displayed as a ghost.
    const beforeLen = HIST.opex.length;
    HIST.opex = HIST.opex.filter(r => !(
      !r.rowIndex && r.y === fy && r.m === fm-1 && r.d === fd &&
      (r.tx||'').toLowerCase() === nl && (r.exp||r.inc||0) === amount
    ));
    if (HIST.opex.length !== beforeLen) {
      dupDebugLog('_applyLocalEdit:strippedStaleOldDayPlaceholder', { isoDate, txName, amount, newDate });
    }
  }
  // txHistory — edit only the FIRST matching row, not every row sharing this signature.
  // Content-match (date+tx+amount) can't tell two genuinely-identical transactions apart
  // (e.g. two KRL 4k rides on the same day), so a plain .map over every match used to
  // overwrite BOTH with the same new values: editing one of two duplicates edited both,
  // silently collapsing the pair into two copies of the edited one. _applyLocalDelete
  // already solved the equivalent problem for deletes by counting; here the fix is simpler
  // because an edit only ever needs to touch one occurrence, so a first-match flag suffices.
  let txEdited = false;
  txHistory = txHistory.map(h => {
    if (!txEdited && h.date === isoDate && h.tx.toLowerCase() === nl && h.amount === amount) {
      txEdited = true;
      return {...h, date:newDate, tx:newTx, amount:newAmount, category:newCat, pm:newPm,
              notes:newNotes||'', type: newIsIncome ? 'income' : 'expense', future: newIsFuture,
              nativeAmount: newCcy ? newNativeAmount : 0, ccy: newCcy || ''};
    }
    return h;
  });
  localStorage.setItem('notapub_history_v2', JSON.stringify(txHistory));
  // nota_curMonth cache: remove ONE matching row from the old month, add one to the new
  // month. The old code's .filter(r => !matches) removed every matching row from the old
  // day — with two identical transactions this deleted BOTH from the old day's cache while
  // only one new row was ever added to the new day, so one of the two vanished outright
  // rather than staying put, unedited, on the old day.
  const oldKey = curMonthCacheKey(fy, fm);
  const oldCached = JSON.parse(localStorage.getItem(oldKey) || '[]');
  let cacheEdited = false;
  localStorage.setItem(oldKey, JSON.stringify(
    oldCached.filter(r => {
      if (!cacheEdited && r.d === fd && (r.tx||'').toLowerCase() === nl && (r.exp||r.inc||0) === amount) {
        cacheEdited = true;
        return false;
      }
      return true;
    })
  ));
  const newKey = curMonthCacheKey(nfy, nfm);
  const newCached = JSON.parse(localStorage.getItem(newKey) || '[]');
  const newRow = {d:nfd, cat:newCat, tx:newTx, pm:newPm,
                  ...(newNotes ? {notes:newNotes} : {}),
                  ...(newIsIncome ? {inc:newAmount} : {exp:newAmount}),
                  ...(newCcy ? {nativeAmount:newNativeAmount, ccy:newCcy} : {})};
  newCached.push(newRow);
  localStorage.setItem(newKey, JSON.stringify(newCached));
}

// ── EDIT / DELETE TRANSACTION ─────────────────────────────────
function openEditOverlay(idx) {
  let tx = calCurrentTxns[idx];
  if (!tx) return;
  openEditOverlayFromRow(tx, calCurrentDateStr);
}

// Resolves an "Investment"-category Opex row (tx) back to its real Invest-sheet
// row and opens it for edit/delete. liveInvest is only populated by a handful of
// specific triggers (opening Insights, editing/deleting another Invest row,
// syncing a new one) — NOT on app load — so a fresh session tapping an existing
// Invest transaction before any of those has fired would otherwise always fail to
// resolve it. Refetch once via fetchLiveInvest() and retry before giving up,
// instead of depending on some unrelated prior navigation having already done so.
async function _resolveAndOpenInvestFromOpexRow(tx, dateStr, amt, retriedFetch) {
  const opexDate = dateStr || (tx.date ? String(tx.date).slice(0, 10) : '');
  const opexAmt = amt;
  const opexPm = tx.pm || '';
  const allInvest = typeof getAllInvestRows === 'function' ? getAllInvestRows() : [];

  // Prefer the exact link: the tapped row's own id (tx.sheetId from the Calendar
  // day panel's serialized JSON, or tx.id from Search/HIST.opex rows directly) is
  // this linked Opex row's own id, which handleInvest() stores on the Invest row
  // as opexTxId. Matching on it is exact — unlike the date+account+amount
  // fallback below, it can't silently resolve to the wrong row (or fail to
  // resolve at all, e.g. for a USD-settled Buy/Sell, since the fallback compares
  // the Opex row's always-IDR amount against native units) and fall through to
  // editing/deleting only the Opex side, orphaning the Invest sheet row.
  const opexRowId = tx.sheetId || tx.id || null;
  let invRow = opexRowId ? allInvest.find(r => r.opexTxId && r.opexTxId === opexRowId) : null;

  if (!invRow) {
    invRow = allInvest.find(r => {
      const rDate = r.date ? String(r.date).slice(0, 10) : '';
      if (rDate !== opexDate || r.account !== opexPm) return false;
      const isUSD = (ACCOUNT_CCY[r.account] || '').toUpperCase() === 'USD';
      const nativeSpent = isUSD ? (r.lot * r.price) : r.totalIdr;
      return Math.abs(nativeSpent - opexAmt) < 0.05;
    });
  }

  if (invRow) {
    openEditInvestOverlay(invRow);
    return;
  }

  if (!retriedFetch) {
    // Not resolvable from whatever's already in memory — liveInvest may simply
    // never have been fetched this session. Try once, then re-run this same
    // resolution against the refreshed data before giving up.
    await fetchLiveInvest().catch(() => {});
    _resolveAndOpenInvestFromOpexRow(tx, dateStr, amt, /*retriedFetch*/ true);
    return;
  }

  // Investment-category row with no resolvable Invest-sheet counterpart even
  // after a live refetch. Editing/deleting it as a plain Opex row here would
  // silently orphan the linked Invest row — refuse instead of falling through
  // to the plain-Opex path below.
  showToast('Could not find the linked investment — try again', 'error');
}

// Shared core for opening the edit overlay from any transaction row source
// (calendar day panel via openEditOverlay, or Search page via openSearchTxEdit).
// `row` may be a calCurrentTxns-shaped entry (amt/inc/cat) or a raw HIST.opex/
// txHistory row (exp/inc/amount, cat/category) — both are normalized below.
function openEditOverlayFromRow(row, dateStr) {
  let tx = row;
  const amt = tx.amt != null ? tx.amt : (tx.amount || tx.exp || tx.inc || 0);
  const cat = tx.cat || tx.category || '';

  if (tx.type === 'invest' || cat === 'Investment') {
    _resolveAndOpenInvestFromOpexRow(tx, dateStr, amt, /*retriedFetch*/ false);
    return;
  }

  // Try HIST.opex for a rowIndex/id (fast path; works once fresh data is cached).
  // If rowIndex is still missing the server will find the row by content via _findRowIndex.
  if (!tx.rowIndex && dateStr) {
    const [fy, fm, fd] = dateStr.split('-').map(Number);
    const live = (HIST.opex || []).find(r =>
      r.y === fy && r.m === fm - 1 && r.d === fd && r.rowIndex &&
      r.tx.toLowerCase() === tx.tx.toLowerCase() &&
      (r.exp || r.inc || 0) === amt
    );
    if (live) tx = {...tx, rowIndex: live.rowIndex, sheetId: live.id || null};
  }
  const rowIndex = tx.rowIndex || null;
  const sheetId  = tx.sheetId || tx.id || null;
  overlayEditRowIndex = rowIndex;
  overlayEditId       = sheetId;
  overlayEditMode = true;
  overlayEditType = 'opex';

  // Store original identifying info so the server can find the row by content
  // when rowIndex is unavailable (old Apps Script cache / stale response).
  overlayEditOrigDate  = dateStr ? isoSheetDate(dateStr) : '';
  overlayEditOrigMonth = dateStr ? isoMonthKey(dateStr)  : '';
  overlayEditOrigTx    = tx.tx  || '';
  overlayEditOrigAmt   = amt || 0;
  overlayEditOrigInc   = (tx.inc || 0) > 0;

  // Set mode pill (income vs expense)
  const mode = tx.inc > 0 ? 'income' : 'expense';
  const modeBtn = document.querySelector(`.pill-toggle-btn[data-mode="${mode}"]`);
  if (modeBtn) setInputMode(mode, modeBtn);

  // Pre-fill date from the transaction's own date. Only clamp to current-month
  // bounds when the transaction actually falls in the current month — editing
  // an older transaction shouldn't be blocked from keeping its original date.
  const rawEl = document.getElementById('inputDateRaw');
  if (rawEl) {
    const b = curMonthBounds();
    if (dateStr && dateStr >= b.min && dateStr <= b.max) {
      rawEl.min = b.min; rawEl.max = b.max;
    } else {
      rawEl.removeAttribute('min'); rawEl.removeAttribute('max');
    }
    if (dateStr) {
      rawEl.value = dateStr;
      document.getElementById('inputDateText').textContent = isoDisp(dateStr);
    }
  }

  // Pre-fill fields
  document.getElementById('inputTx').value     = tx.tx    || '';
  document.getElementById('inputAmount').value = formatGroupedAmt(tx.ccy ? tx.nativeAmount : amt);
  document.getElementById('inputCat').value    = cat;
  document.getElementById('inputPm').value     = tx.pm    || '';
  document.getElementById('inputNotes').value  = tx.notes || '';
  onOpexPmSelect();

  // Switch button labels
  document.getElementById('submitOpexBtn').textContent = 'Update Transaction';
  document.getElementById('deleteOpexBtn').style.display = 'block';

  checkCcInstallmentVisibility();
  document.getElementById('inputOverlay').classList.add('open');
}

async function updateTransaction() {
  _suppressVisRefresh = true;
  const rowIndex = overlayEditRowIndex;
  const id = overlayEditId;
  const date   = document.getElementById('inputDateRaw').value;
  const tx     = document.getElementById('inputTx').value.trim();
  let amount   = parseGroupedAmt('inputAmount');
  const cat    = document.getElementById('inputCat').value.trim();
  const pm     = document.getElementById('inputPm').value.trim();
  const notes  = document.getElementById('inputNotes').value.trim();
  const isInc  = inputMode === 'income';
  // Every other exit from this function resets the flag (the queued-item return below,
  // and the try/catch/finally around the network call) — this validation failure was the
  // one path that didn't, so visibility-driven refresh (fetchCurrentMonth on tab-focus)
  // stayed disabled from here until something else reset it or the page reloaded.
  // Returns true/false so submitOpex() can gate recurring-rule creation on whether the
  // edit actually went through, instead of creating the rule unconditionally the moment
  // this function is called.
  if (!date || !tx || !amount || !cat || !pm) { _suppressVisRefresh = false; showToast('All fields required', 'error'); return false; }
  const isFuture = date > todayISO();

  const pmCcy = getOpexPmCcy(pm);
  let nativeAmount = 0, ccy = '';
  if (pmCcy !== 'IDR') {
    nativeAmount = amount;
    ccy = pmCcy;
    amount = Math.round(nativeAmount * getFxAvgRate(pm, pmCcy));
  }

  // Snapshot orig values before closeInputOverlay clears them
  const origDate = overlayEditOrigDate;
  const origMonth = overlayEditOrigMonth;
  const origTx  = overlayEditOrigTx;
  const origAmt = overlayEditOrigAmt;
  const origInc = overlayEditOrigInc;
  const origISO = calCurrentDateStr;

  // Apply locally first — calendar updates immediately
  _applyLocalEdit(origISO, origTx, origAmt, date, tx, amount, cat, pm, notes, isInc, rowIndex, id, nativeAmount, ccy);
  closeInputOverlay();
  calInited = false; initCalendar();
  buildAccountBalances();
  renderAccountBalanceCards();
  if (document.getElementById('page-search').classList.contains('active')) {
    renderSearchOrMonitor();
    if (searchActiveQuery) performSearch(searchActiveQuery);
  }

  // If this transaction never reached the server (still sitting in the local retry
  // queue), there's no sheet row for an "edit" action to find. Patch the queued
  // create in place instead — retryPendingQueue() will send the new values as a
  // fresh create next time it runs, instead of us sending a doomed edit request.
  const queuedIdx = queue.findIndex(q => q.id === id);
  if (queuedIdx !== -1) {
    queue[queuedIdx] = { ...queue[queuedIdx], date, tx, amount, category: cat, pm, notes, type: isInc ? 'income' : 'expense', future: isFuture, nativeAmount, ccy };
    saveLocal();
    showToast('Updated ✓', 'success');
    _suppressVisRefresh = false;
    return true;
  }

  showToast('Updating…', 'loading', 0);

  const payload = {
    type: 'opex', action: 'edit', rowIndex, id,
    date: isoSheetDate(date), month: sheetMonthKey(date, pm),
    cat, tx, pm, amount, notes, isIncome: isInc, future: isFuture,
    nativeAmount: nativeAmount || '', ccy: ccy || '',
    origDate, origMonth, origTx, origAmt, origIsIncome: origInc
  };
  let success = false;
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      success = true;
      // Refresh from server to get authoritative rowIndex. _applyLocalEdit() already
      // patched the old-day/new-day cache entries precisely above — don't blind-wipe
      // the whole month's cache here, that only widens the window where a stale
      // in-flight fetch (see curMonthFetchSeq) is the sole data to merge against.
      await fetchCurrentMonth(true);
      calInited = false; initCalendar();
      buildAccountBalances();
      renderAccountBalanceCards();
      if (document.getElementById('page-search').classList.contains('active')) {
        renderSearchOrMonitor();
        if (searchActiveQuery) performSearch(searchActiveQuery);
      }
      showToast('Updated ✓', 'success');
    } else {
      showToast('Update failed', 'error');
    }
  } catch(e) {
    showToast(navigator.onLine ? 'Update failed' : 'Offline — saved locally', navigator.onLine ? 'error' : '');
  } finally {
    _suppressVisRefresh = false;
  }
  return success;
}

async function deleteSheetTransaction() {
  if (!confirm('Delete this transaction?')) return;
  // On iOS PWA, the native confirm() dialog fires visibilitychange when dismissed.
  // Suppress the visibility-triggered fetch so it doesn't restore the deleted row
  // from the sheet before the server has processed the delete.
  _suppressVisRefresh = true;
  const rowIndex = overlayEditRowIndex;
  const id = overlayEditId;

  // Snapshot before closeInputOverlay clears state
  const origDate  = overlayEditOrigDate;
  const origMonth = overlayEditOrigMonth;
  const origTx    = overlayEditOrigTx;
  const origAmt   = overlayEditOrigAmt;
  const origInc   = overlayEditOrigInc;
  const origISO   = calCurrentDateStr;

  // Capture before _applyLocalDelete below trims any matching queue entry.
  const wasQueued = queue.some(q => q.id === id);

  // Delete locally first — calendar updates immediately regardless of server
  _applyLocalDelete(origISO, origTx, origAmt, rowIndex, id, origInc);
  closeInputOverlay();
  calInited = false; initCalendar();
  buildAccountBalances();
  renderAccountBalanceCards();
  if (document.getElementById('page-search').classList.contains('active')) {
    renderSearchOrMonitor();
    if (searchActiveQuery) performSearch(searchActiveQuery);
  }

  // Never reached the server — nothing to delete there. _applyLocalDelete already
  // dropped the matching queue entry above so it won't resurrect on the next retry.
  if (wasQueued) {
    showToast('Deleted ✓', 'success');
    _suppressVisRefresh = false;
    return;
  }

  showToast('Deleting…', 'loading', 0);

  const payload = {
    type: 'opex', action: 'delete', rowIndex, id,
    origDate, origMonth, origTx, origAmt, origIsIncome: origInc
  };
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      showToast('Deleted ✓', 'success');
      // Force-refresh cache from sheet so the deleted row is gone from localStorage.
      // This prevents the stale cache from showing the deleted transaction on next startup.
      fetchCurrentMonth(true).then(() => {
        calInited = false;
        if (document.getElementById('page-home').classList.contains('active')) initCalendar();
        buildAccountBalances();
        renderAccountBalanceCards();
        if (document.getElementById('page-search').classList.contains('active')) {
          renderSearchOrMonitor();
          if (searchActiveQuery) performSearch(searchActiveQuery);
        }
      });
    } else {
      showToast('Delete failed', 'error');
    }
  } catch(e) {
    showToast(navigator.onLine ? 'Delete failed' : 'Offline — saved locally', navigator.onLine ? 'error' : '');
  } finally {
    _suppressVisRefresh = false;
  }
}

// ── EDIT / DELETE INVEST TRANSACTION ───────────────────────────
function openEditInvestOverlay(row) {
  if (!row) return;
  overlayEditRowIndex = row.rowIndex || null;
  overlayEditId       = row.id || null;
  overlayEditMode = true;
  overlayEditType = 'invest';

  const modeBtn = document.querySelector('.pill-toggle-btn[data-mode="invest"]');
  if (modeBtn) setInputMode('invest', modeBtn);

  const actionBtn = document.querySelector(`.action-btn[data-action="${row.action === 'Sell' ? 'Sell' : 'Buy'}"]`);
  if (actionBtn) setInvestAction(row.action === 'Sell' ? 'Sell' : 'Buy', actionBtn);

  const dateIso = row.date ? String(row.date).slice(0, 10) : todayISO();
  document.getElementById('inputDateRawI').value = dateIso;
  document.getElementById('inputDateTextI').textContent = isoDisp(dateIso);
  document.getElementById('inputStock').value   = row.stock   || '';
  document.getElementById('inputAccount').value = row.account || '';
  document.getElementById('inputLot').value     = row.lot ? formatGroupedAmt(row.lot) : '';
  document.getElementById('inputPrice').value   = row.price ? formatGroupedAmt(row.price) : '';
  // Total isn't stored natively (the sheet only keeps TotalIdr) — reconstruct it as
  // lot × price, same as calcTotal's own default, rather than the stored IDR figure
  // (which would show as a bare number under whatever prefix calcTotal below sets,
  // mixing units). A manual Total override made at entry time won't survive re-editing.
  document.getElementById('investPricePrefix').textContent = ccyPrefix(getStockCcy(row.stock));
  calcTotal();

  document.getElementById('submitInvestBtn').textContent = 'Update Investment';
  document.getElementById('deleteInvestBtn').style.display = 'block';

  document.getElementById('inputOverlay').classList.add('open');
}

async function updateInvestTransaction() {
  const rowIndex = overlayEditRowIndex;
  const id = overlayEditId;
  const date=document.getElementById('inputDateRawI').value;
  const stock=sanitizeInput(document.getElementById('inputStock').value,50);
  const account=sanitizeInput(document.getElementById('inputAccount').value,30);
  const lot=parseAmt('inputLot');
  const price=parseAmt('inputPrice');
  const total=parseAmt('inputTotal');
  if(!date||!stock||!account||!lot||!price){showToast('All fields required','error');return}
  const totalIdr=investTotalToIdr(total, getStockCcy(stock), lot, price);
  closeInputOverlay();

  // If this investment never reached the server (still sitting in the local retry
  // queue), there's no sheet row for an "edit" action to find. Patch the queued
  // create and investHistory entry in place instead — retryPendingQueue() will send
  // the new values as a fresh create next time it runs.
  const queuedIdx = queue.findIndex(q => q.id === id);
  if (queuedIdx !== -1) {
    const patch = { date, stock, account, action: investAction, lot, price, totalIdr };
    queue[queuedIdx] = { ...queue[queuedIdx], ...patch };
    investHistory = investHistory.map(h => h.id === id ? { ...h, ...patch } : h);
    saveLocal();
    buildAccountBalances();
    renderAccountBalanceCards();
    if (document.getElementById('page-search').classList.contains('active')) renderSearchOrMonitor();
    showToast('Updated ✓', 'success');
    return;
  }

  showToast('Updating…', 'loading', 0);
  const payload = {
    type:'invest', op:'edit', id, rowIndex,
    date:isoSheetDate(date), month:isoMonthKey(date), stock,
    stockType:STOCK_TYPE[stock]||'', action:investAction,
    account, lot, price, totalIdr,
  };
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      await fetchLiveInvest();
      localStorage.removeItem(curMonthCacheKey());
      await fetchCurrentMonth(true);
      if (document.getElementById('page-search').classList.contains('active')) renderSearchOrMonitor();
      buildAccountBalances();
      renderAccountBalanceCards();
      showToast('Updated ✓', 'success');
    } else {
      showToast('Update failed', 'error');
    }
  } catch(e) {
    showToast(navigator.onLine ? 'Update failed' : 'Offline — saved locally', navigator.onLine ? 'error' : '');
  }
}

async function deleteSheetInvestTransaction() {
  if (!confirm('Delete this investment transaction?')) return;
  const rowIndex = overlayEditRowIndex;
  const id = overlayEditId;
  closeInputOverlay();

  // Same as updateInvestTransaction: if it's still just a queued, unsynced create,
  // there's no sheet row to delete — remove it locally instead.
  const queuedIdx = queue.findIndex(q => q.id === id);
  if (queuedIdx !== -1) {
    queue = queue.filter(q => q.id !== id);
    investHistory = investHistory.filter(h => h.id !== id);
    saveLocal();
    buildAccountBalances();
    renderAccountBalanceCards();
    if (document.getElementById('page-search').classList.contains('active')) renderSearchOrMonitor();
    showToast('Deleted ✓', 'success');
    return;
  }

  showToast('Deleting…', 'loading', 0);
  const payload = { type:'invest', op:'delete', id, rowIndex };
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      await fetchLiveInvest();
      localStorage.removeItem(curMonthCacheKey());
      await fetchCurrentMonth(true);
      if (document.getElementById('page-search').classList.contains('active')) renderSearchOrMonitor();
      buildAccountBalances();
      renderAccountBalanceCards();
      showToast('Deleted ✓', 'success');
    } else {
      showToast('Delete failed', 'error');
    }
  } catch(e) {
    showToast(navigator.onLine ? 'Delete failed' : 'Offline — saved locally', navigator.onLine ? 'error' : '');
  }
}

// ── SUBMIT INVEST ─────────────────────────────────────────────
function submitInvest() {
  if (isSyncing) return;
  if (overlayEditMode && overlayEditType === 'invest') { updateInvestTransaction(); return; }
  const date=document.getElementById('inputDateRawI').value;
  const stock=sanitizeInput(document.getElementById('inputStock').value,50);
  const account=sanitizeInput(document.getElementById('inputAccount').value,30);
  const lot=parseAmt('inputLot');
  const price=parseAmt('inputPrice');
  const total=parseAmt('inputTotal');
  if(!date||!stock||!account||!lot||!price){showToast('All fields required','error');return}
  const totalIdr=investTotalToIdr(total, getStockCcy(stock), lot, price);
  const r={id:Date.now(),date,stock,account,action:investAction,lot,price,totalIdr,type:'invest',synced:false};
  investHistory.unshift(r);
  queue.push({...r});
  saveLocal();updateStatus();
  buildAccountBalances();
  renderAccountBalanceCards();
  // Navigate back to Home immediately (closes the input overlay too), same as
  // submitOpex/submitTransfer — leaving the overlay open after tapping Save made
  // it unclear whether the investment had actually been saved.
  switchTab('home', null);
  showToast('Saving…', 'loading', 0);
  isSyncing = true;
  syncInvest(r).then(ok=>{
    isSyncing = false;
    if(ok){
      queue=queue.filter(q=>q.id!==r.id);
      investHistory=investHistory.map(h=>h.id===r.id?{...h,synced:true}:h);
      saveLocal();updateStatus();showToast('Saved ✓','success');
      // Refresh HIST.opex so the Opex expense/income row created by the invest sync
      // is included, and fetchLiveInvest() so this row's real id/opexTxId replaces
      // the local synced-but-stale copy in getAllInvestRows() — without this, the
      // Calendar/Search tap-to-edit lookup (openEditOverlayFromRow) can't resolve
      // this transaction back to its Invest-sheet row until something else happens
      // to refresh liveInvest (e.g. opening Insights), and editing/deleting it in
      // that window would only affect the linked Opex row, orphaning the Invest row.
      localStorage.removeItem(curMonthCacheKey());
      fetchLiveInvest().then(() => buildAccountBalances());
      fetchCurrentMonth(true).then(() => { buildAccountBalances(); renderAccountBalanceCards(); });
    }
    else showToast(navigator.onLine ? 'Save failed' : 'Saved offline — will sync ✓', '');
  });
  const t=todayISO();
  document.getElementById('inputDateRawI').value=t;
  document.getElementById('inputDateTextI').textContent=isoDisp(t);
  document.getElementById('inputStock').value='';
  document.getElementById('inputAccount').value='';
  document.getElementById('inputLot').value='';
  document.getElementById('inputPrice').value='';
  document.getElementById('inputTotal').value='';
  document.getElementById('investPricePrefix').textContent='Rp';
  document.getElementById('investTotalPrefix').textContent='Rp';
  const _ca=document.getElementById('investCurrentAvg'); if(_ca)_ca.textContent='—';
  const _na=document.getElementById('investNewAvg'); if(_na)_na.textContent='—';
  updateInvestTotalHint();
}

// ── SYNC ──────────────────────────────────────────────────────
async function syncOpex(r) {
  try {
    const sheetDate = isoSheetDate(r.date);
    const monthHeader = isoMonthKey(r.date);
    const month = sheetMonthKey(r.date, r.pm);
    const payload = {
      type:'opex', action:r.type,
      date:sheetDate, month, monthHeader,
      tx:r.tx, cat:r.category, pm:r.pm, amount:r.amount, notes:r.notes||'', future:r.future||false,
      nativeAmount:r.nativeAmount||'', ccy:r.ccy||'',
      clientId: String(r.id)
    };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:apiBody(payload)});
    const j = await res.json().catch(()=>({}));
    // Guard: doGet fallback returns {status:'ok', version:N} — not a real write
    return j.status === 'ok' && !j.version;
  } catch(e){console.error('[syncOpex]',e.message);return false}
}
async function syncInvest(r) {
  try {
    const sheetDate = isoSheetDate(r.date);
    const payload = {
      type:'invest', date:sheetDate, stock:r.stock,
      stockType:STOCK_TYPE[r.stock]||'',
      action:r.action, account:r.account||'', lot:r.lot, price:r.price, totalIdr:r.totalIdr,
      clientId: String(r.id)
    };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:apiBody(payload)});
    const j = await res.json().catch(()=>({}));
    return j.status === 'ok' && !j.version;
  } catch(e){console.error('[syncInvest]',e.message);return false}
}

// ── LOCAL STORAGE ─────────────────────────────────────────────
function saveLocal(){
  localStorage.setItem('notapub_queue_v2',JSON.stringify(queue));
  localStorage.setItem('notapub_history_v2',JSON.stringify(txHistory));
  localStorage.setItem('notapub_invest_v2',JSON.stringify(investHistory));
  updateFabBadge();
}
function updateFabBadge(){
  const b=document.getElementById('fabQueueBadge');
  if(b) b.style.display='none';
}
function pruneStaleHistory(){
  if(!txHistory.length) return;
  // Build map of month key → row count in data.json
  const histMonthCounts={};
  HIST.opex.forEach(r=>{ histMonthCounts[r.mk]=(histMonthCounts[r.mk]||0)+1; });
  if(!Object.keys(histMonthCounts).length) return;
  // Never prune current-month entries — they may carry rowIndex for editing
  const today=new Date();
  const curMk=`${MO[today.getMonth()]} ${today.getFullYear()}`;
  // Also protect the previous month in case data.json hasn't been fully archived yet
  const prevDate=new Date(today.getFullYear(),today.getMonth()-1,1);
  const prevMk=`${MO[prevDate.getMonth()]} ${prevDate.getFullYear()}`;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const before=txHistory.length;
  txHistory=txHistory.filter(r=>{
    if(!r.synced) return true; // never drop unsynced
    if(r.date && typeof r.date === 'string' && r.date < cutoffStr) return false; // aggressively drop synced > 60 days
    if(!r.date || typeof r.date !== 'string') return true;
    const mk=isoMonthKey(r.date);
    if(mk===curMk) return true; // keep current month
    if(mk===prevMk) return true; // keep previous month (may not be fully archived yet)
    return !(histMonthCounts[mk]>=10); // drop only if well-represented in data.json
  });
  if(txHistory.length<before){
    localStorage.setItem('notapub_history_v2',JSON.stringify(txHistory));
  }
}
function updateStatus(){}
// Was: every showToast() call with a non-zero duration scheduled a bare setTimeout with
// no reference kept to it. Two toasts shown back to back (e.g. "Saving…" replaced
// quickly by "Saved ✓", or any error toast racing a status update) left both timers
// running independently; whichever fired first cleared whatever toast happened to be
// showing at that moment — not necessarily its own — so a later toast could be wiped
// early by an earlier call's leftover timer, or a stale timer could clear a toast that
// had already changed since it was scheduled. Tracking the one active timer and
// cancelling it at the start of every call (and on an explicit hideToast()) means only
// the most recent call's timer is ever pending.
let _toastTimer = null;
function showToast(msg,type,duration){
  // Keep the "Tap anywhere" hint (see first-tap script) up through background loading toasts.
  if(window.__notaTapHintActive && type==='loading') return;
  window.__notaTapHintActive=false;
  clearTimeout(_toastTimer); _toastTimer = null;
  const t=document.getElementById('toast');t.textContent=msg;
  t.className='toast show'+(type?' '+type:'');
  if(duration===0)return; // persistent — caller must dismiss
  _toastTimer = setTimeout(()=>{ t.className='toast'; _toastTimer = null; },duration||3000);
}
function hideToast(){
  if(window.__notaTapHintActive) return;
  clearTimeout(_toastTimer); _toastTimer = null;
  const t=document.getElementById('toast');t.className='toast';
}

// ── SEARCH FUNCTIONS ──────────────────────────────────────────
let searchTimeout;
let searchCurrentResults = [];
let searchPageIndex = 0;
let searchActiveQuery = '';
let searchScrollAttached = false;
let allTxResults = [];
let allTxPageIndex = 0;

function renderSearchOrMonitor() {
  const query = (document.getElementById('searchInput')?.value || '').trim();
  const monitorContainer = document.getElementById('searchMonitorContainer');
  const resultsCount = document.getElementById('searchResultsCount');
  const results = document.getElementById('searchResults');
  
  if (query) {
    if (monitorContainer) monitorContainer.style.display = 'none';
    if (resultsCount) resultsCount.style.display = 'block';
    if (results) results.style.display = 'block';
  } else {
    if (resultsCount) resultsCount.style.display = 'none';
    if (results) results.style.display = 'none';
    if (monitorContainer) {
      monitorContainer.style.display = 'block';
      renderCCMonitor();
    }
  }
}

function onSearchInput() {
  const val = document.getElementById('searchInput').value.trim();
  document.getElementById('searchClearBtn').style.display = val ? 'flex' : 'none';
  clearTimeout(searchTimeout);
  if (!val) { clearSearch(); return; }
  searchTimeout = setTimeout(() => {
    renderSearchOrMonitor();
    performSearch(val);
  }, 300);
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClearBtn').style.display = 'none';
  searchCurrentResults = [];
  searchPageIndex = 0;
  searchActiveQuery = '';
  renderSearchOrMonitor();
}

// Collapses paired Transfer rows (same shared xfr_ id — one expense leg on the
// source PM, one income leg on the destination PM) into a single display item,
// same shape as the calendar's calGetMonthData merge (index.html ~5776).
function mergeTransferPairs(results) {
  const xfrGroups = {};
  results.forEach(item => {
    const row = item.row;
    if (item.source === 'hist-opex' && (row.cat || row.category) === 'Transfer' && row.id && String(row.id).startsWith('xfr_')) {
      (xfrGroups[row.id] || (xfrGroups[row.id] = [])).push(item);
    }
  });
  const toRemove = new Set();
  const merged = [];
  Object.entries(xfrGroups).forEach(([xfrId, items]) => {
    if (items.length < 2) return;
    const expItem = items.find(it => (it.row.exp || 0) > 0);
    const incItem = items.find(it => (it.row.inc || 0) > 0);
    if (!expItem || !incItem) return;
    items.forEach(it => toRemove.add(it));
    const expRow = expItem.row, incRow = incItem.row;
    merged.push({
      source: 'hist-transfer', idx: xfrId, type: 'opex',
      row: {
        ...expRow,
        tx: `${expRow.pm} → ${incRow.pm}`, pm: `${expRow.pm} → ${incRow.pm}`,
        cat: 'Transfer', category: 'Transfer', amt: expRow.exp || 0, type: 'transfer',
        transferFromPm: expRow.pm, transferToPm: incRow.pm,
      },
    });
  });
  return toRemove.size ? results.filter(item => !toRemove.has(item)).concat(merged) : results;
}

function performSearch(query) {
  const q = query.toLowerCase();
  const results = [];
  
  const histOpex = HIST.opex || [];
  for (let i = 0; i < histOpex.length; i++) {
    const row = histOpex[i];
    const txMatch = row.tx && row.tx.toLowerCase().includes(q);
    const notesMatch = row.notes && row.notes.toLowerCase().includes(q);
    if (txMatch || notesMatch) results.push({source: 'hist-opex', idx: i, row, type: 'opex'});
  }
  
  const histInvest = HIST.invest || [];
  for (let i = 0; i < histInvest.length; i++) {
    const row = histInvest[i];
    const txMatch = row.stock && row.stock.toLowerCase().includes(q);
    if (txMatch) results.push({source: 'hist-invest', idx: i, row, type: 'invest'});
  }
  
  for (let i = 0; i < txHistory.length; i++) {
    const r = txHistory[i];
    const txMatch = r.tx && r.tx.toLowerCase().includes(q);
    const notesMatch = r.notes && r.notes.toLowerCase().includes(q);
    if (!(txMatch || notesMatch)) continue;
    // Synced local rows linger in txHistory until pruned; skip when the same tx already came from HIST
    if (r.synced) {
      const dt = new Date(r.date);
      const amt = r.amount || r.exp || r.inc || 0;
      if (histOpex.some(h => h.tx === (r.tx || r.payee || '') && h.y === dt.getFullYear() && h.m === dt.getMonth() &&
          h.d === dt.getDate() && (h.exp || h.inc || 0) === amt)) continue;
    }
    results.push({source: 'local-opex', idx: i, row: r, type: 'opex'});
  }
  
  for (let i = 0; i < investHistory.length; i++) {
    const r = investHistory[i];
    const txMatch = r.stock && r.stock.toLowerCase().includes(q);
    if (txMatch) results.push({source: 'local-invest', idx: i, row: r, type: 'invest'});
  }

  const merged = mergeTransferPairs(results);
  merged.sort((a, b) => {
    const dateA = new Date(a.row.date || `${a.row.y}-${String(a.row.m+1).padStart(2,'0')}-${String(a.row.d).padStart(2,'0')}`);
    const dateB = new Date(b.row.date || `${b.row.y}-${String(b.row.m+1).padStart(2,'0')}-${String(b.row.d).padStart(2,'0')}`);
    return dateB - dateA;
  });
  
  searchCurrentResults = merged;
  searchPageIndex = 0;
  renderSearchResults(q);
}

function renderTxItemHTML(item, query) {
  const row = item.row;
  const isInvest = item.type === 'invest';
  const isPending = item.source.startsWith('local');

  let date, tx, cat, pm, amount, notes, icon, cls, color;
  if (isInvest) {
    date = row.date ? isoDisp(row.date) : `${row.d} ${MO[row.m]} ${row.y}`;
    tx = row.stock;
    cat = row.type || 'Stock';
    pm = row.action;
    amount = fRp(row.totalIdr || (row.lot * row.price));
    icon = '📈'; cls = 'invest'; color = 'var(--blue)';
  } else {
    date = row.date ? isoDisp(row.date) : `${row.d} ${MO[row.m]} ${row.y}`;
    tx = row.tx;
    cat = row.cat || row.category;
    pm = row.pm;
    amount = fRp(row.exp || row.inc || row.amount || row.amt || 0);
    notes = row.notes || '';
    icon = '💳';
    const pmStyle = PM_STYLES[pm] || PM_STYLE_DEFAULT;
    cls = pmStyle.cls;
    color = pmStyle.color;
  }

  const syncBadge = isPending && !row.synced ? '<span class="badge badge-pending">pending</span>' : '';
  const notesHtml = !isInvest && notes ? `<div class="search-item-note">${highlightMatches(notes, query)}</div>` : '';

  // A Transfer is a paired expense+income row set — row.type/'category' catch both the merged
  // (synced, tappable) shape from mergeTransferPairs and a pending local {type:'transfer'} row
  // (not yet split into paired sheet rows, so never tappable — same as the calendar).
  const isTransfer = !isInvest && (row.cat === 'Transfer' || row.category === 'Transfer' || row.type === 'transfer');
  const editable = isInvest ? !!row.id : (item.source === 'hist-transfer' ? true : !isTransfer);
  const tapAttrs = editable
    ? ` data-idx="${item.idx}" data-source="${item.source}" data-type="${isInvest ? 'invest' : (item.source === 'hist-transfer' ? 'transfer' : 'opex')}" style="cursor:pointer"`
    : '';

  if (isTransfer) { icon = '🔁'; cls = 'transfer'; color = '#a78bfa'; }
  const metaLine = isTransfer ? 'Transfer' : `${esc(cat)} · ${esc(pm)}`;

  return `<div class="tx-item"${tapAttrs}>
    <div class="tx-icon ${cls}">${icon}</div>
    <div class="tx-info" style="flex:1">
      <div class="tx-payee">${highlightMatches(tx, query)}${syncBadge}</div>
      <div class="tx-meta">${date} • ${metaLine}</div>
      ${notesHtml}
    </div>
    <div class="tx-amount" style="color:${color}">${amount}</div>
  </div>`;
}

function renderSearchResults(query) {
  searchActiveQuery = query;
  const countEl = document.getElementById('searchResultsCount');
  const resultsEl = document.getElementById('searchResults');
  const total = searchCurrentResults.length;

  if (total === 0) {
    countEl.style.display = 'none';
    resultsEl.innerHTML = '<div class="empty-state">No results found</div>';
    return;
  }

  countEl.style.display = 'block';
  countEl.textContent = `Found ${total} result${total !== 1 ? 's' : ''} for "${query}"`;

  const pageSize = 20;
  const pageResults = searchCurrentResults.slice(0, (searchPageIndex + 1) * pageSize);

  resultsEl.innerHTML = pageResults.map(item => renderTxItemHTML(item, query)).join('');

  if (pageResults.length < total) {
    resultsEl.innerHTML += `<div class="search-loading">Scroll for more… (${pageResults.length}/${total})</div>`;
  }
}

function renderAllTransactions() {
  const countEl = document.getElementById('searchResultsCount');
  const resultsEl = document.getElementById('searchResults');

  if (!histLoaded) {
    countEl.style.display = 'none';
    resultsEl.innerHTML = '<div class="empty-state">Loading…</div>';
    return;
  }

  const results = [];
  const histOpex = HIST.opex || [];
  for (let i = 0; i < histOpex.length; i++) {
    if (histOpex[i].category === 'Investment' || histOpex[i].cat === 'Investment') continue;
    results.push({source:'hist-opex', idx:i, row:histOpex[i], type:'opex'});
  }
  for (let i = 0; i < liveInvest.length; i++) {
    results.push({source:'live-invest', idx:i, row:liveInvest[i], type:'invest'});
  }
  for (let i = 0; i < txHistory.length; i++) {
    if (txHistory[i].category === 'Investment' || txHistory[i].cat === 'Investment') continue;
    results.push({source:'local-opex', idx:i, row:txHistory[i], type:'opex'});
  }
  // Unsynced local invest rows only — once synced they're already in liveInvest (see syncInvest).
  for (let i = 0; i < investHistory.length; i++) {
    if (investHistory[i].synced) continue;
    results.push({source:'local-invest', idx:i, row:investHistory[i], type:'invest'});
  }

  const merged = mergeTransferPairs(results);
  merged.sort((a, b) => {
    const dateA = new Date(a.row.date || `${a.row.y}-${String(a.row.m+1).padStart(2,'0')}-${String(a.row.d).padStart(2,'0')}`);
    const dateB = new Date(b.row.date || `${b.row.y}-${String(b.row.m+1).padStart(2,'0')}-${String(b.row.d).padStart(2,'0')}`);
    return dateB - dateA;
  });

  allTxResults = merged;
  allTxPageIndex = 0;
  renderAllTxPage();
}

function renderAllTxPage() {
  const countEl = document.getElementById('searchResultsCount');
  const resultsEl = document.getElementById('searchResults');
  const total = allTxResults.length;

  countEl.style.display = 'block';
  countEl.textContent = `All transactions · ${total} total`;

  const pageSize = 20;
  const pageResults = allTxResults.slice(0, (allTxPageIndex + 1) * pageSize);

  resultsEl.innerHTML = pageResults.map(item => renderTxItemHTML(item, '')).join('');

  if (pageResults.length < total) {
    resultsEl.innerHTML += `<div class="search-loading">Scroll for more… (${pageResults.length}/${total})</div>`;
  }
}

function loadMoreAllTx() {
  const pageSize = 20;
  if ((allTxPageIndex + 1) * pageSize < allTxResults.length) {
    allTxPageIndex++;
    renderAllTxPage();
  }
}

function loadMoreSearchResults(query) {
  const pageSize = 20;
  const total = searchCurrentResults.length;
  const currentShown = (searchPageIndex + 1) * pageSize;
  if (currentShown < total) {
    searchPageIndex++;
    renderSearchResults(query);
  }
}

function highlightMatches(text, query) {
  const safe = esc(text);
  if (!query) return safe;
  const regex = new RegExp(`(${esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(regex, '<span class="highlight">$1</span>');
}

function openSearchTxEdit(source, idx) {
  const row = source === 'hist-opex' ? (HIST.opex || [])[idx]
            : source === 'local-opex' ? (txHistory || [])[idx]
            : null;
  if (!row) return;
  const dateStr = row.date ? String(row.date).slice(0, 10)
    : `${row.y}-${String(row.m + 1).padStart(2, '0')}-${String(row.d).padStart(2, '0')}`;
  openEditOverlayFromRow(row, dateStr);
}

function openSearchInvestEdit(source, idx) {
  const row = source === 'live-invest' ? (liveInvest || [])[idx]
            : source === 'hist-invest' ? (HIST.invest || [])[idx]
            : null;
  if (!row || !row.id) return;
  openEditInvestOverlay(row);
}

// Re-resolves both legs from live HIST.opex at tap time (rather than trusting the
// merged row captured at render time), same pattern as openSearchTxEdit.
function openSearchTransferEdit(xfrId) {
  const rows = (HIST.opex || []).filter(r => r.id === xfrId && (r.cat || r.category) === 'Transfer');
  const expRow = rows.find(r => (r.exp || 0) > 0);
  const incRow = rows.find(r => (r.inc || 0) > 0);
  if (!expRow || !incRow) return;
  const merged = {
    ...expRow, cat: 'Transfer', category: 'Transfer', amt: expRow.exp || 0,
    sheetId: expRow.id || null, transferFromPm: expRow.pm, transferToPm: incRow.pm,
  };
  const dateStr = expRow.date ? String(expRow.date).slice(0, 10)
    : `${expRow.y}-${String(expRow.m + 1).padStart(2, '0')}-${String(expRow.d).padStart(2, '0')}`;
  openEditTransferOverlay(merged, dateStr);
}

function initSearchPage() {
  if (!searchScrollAttached) {
    searchScrollAttached = true;
    const resultsEl = document.getElementById('searchResults');
    resultsEl.addEventListener('scroll', () => {
      if (resultsEl.scrollTop + resultsEl.clientHeight >= resultsEl.scrollHeight - 100) {
        if (searchActiveQuery) loadMoreSearchResults(searchActiveQuery);
        else loadMoreAllTx();
      }
    });

    // Reliable tap-to-edit on mobile: inline onclick is swallowed by iOS
    // -webkit-overflow-scrolling:touch scroll layers. Use touchstart/touchend
    // event delegation on the container to detect taps vs scrolls (same
    // pattern as #calTxList).
    const fireSearchTap = item => {
      const { type, source, idx } = item.dataset;
      if (type === 'invest') openSearchInvestEdit(source, parseInt(idx));
      else if (type === 'transfer') openSearchTransferEdit(idx); // idx is the xfr_ id string, not a numeric index
      else openSearchTxEdit(source, parseInt(idx));
    };

    const setupTapToEdit = el => {
      if (!el) return;
      let _ts = 0, _tx = 0, _ty = 0, _touchFired = 0;
      el.addEventListener('touchstart', e => {
        _ts = Date.now(); _tx = e.touches[0].clientX; _ty = e.touches[0].clientY;
      }, {passive: true});
      el.addEventListener('touchend', e => {
        const dt = Date.now() - _ts;
        const dx = Math.abs(e.changedTouches[0].clientX - _tx);
        const dy = Math.abs(e.changedTouches[0].clientY - _ty);
        if (dt > 400 || dx > 8 || dy > 8) return; // scroll or long-press
        const item = e.target.closest('.tx-item[data-idx], .detail-item[data-idx]');
        if (!item) return;
        _touchFired = Date.now(); fireSearchTap(item);
      }, {passive: true});
      el.addEventListener('click', e => {
        if (Date.now() - _touchFired < 600) return;
        const item = e.target.closest('.tx-item[data-idx], .detail-item[data-idx]');
        if (!item) return;
        fireSearchTap(item);
      });
    };

    setupTapToEdit(resultsEl);
    setupTapToEdit(document.getElementById('searchMonitorContainer'));
  }
  clearSearch();
}

// Nota Public has no data.json bulk-history snapshot (unlike the original Nota app
// this was forked from) — full Opex history is fetched directly from the user's
// own Sheet via ?type=allOpex instead.
async function loadHistData(_isRetry) {
  try {
    // fetchWithTimeout (not a raw fetch) — this call routes through
    // requireReady()/Auth.ready and getAccessToken()/_tokenReady, both of
    // which can hang indefinitely with no timeout of their own (e.g. a
    // stranded returning-user token wait). Without a bound here, initCalendar()
    // never runs and the skeleton calendar never resolves. 30s (not 8-12s like
    // other calls): this is a one-time full-history payload that can genuinely
    // take a while to download for an account with years of transactions — a
    // tighter bound here was cutting the fetch off before it legitimately
    // finished, wiping every previous month from the calendar/Insights even
    // though sign-in and the network were both fine.
    const res = await fetchWithTimeout(apiGet('type=allOpex'), { method: 'GET' }, 30000);
    const j = await res.json();
    if (j.status !== 'ok' || !Array.isArray(j.rows)) throw new Error('bad allOpex response');
    HIST.opex = j.rows;
    // Re-apply cached live month rows so the allOpex fetch doesn't clobber a more
    // recent optimistic/local edit (race condition: fetchCurrentMonthFresh may have
    // completed first).
    const now = new Date();
    const cachedRows = JSON.parse(localStorage.getItem(curMonthCacheKey()) || 'null');
    if (cachedRows && cachedRows.length > 0) _applyCurrentMonthRows(cachedRows, now.getFullYear(), now.getMonth()+1);
    if (j.txCat) { HIST.txCat = j.txCat; localStorage.setItem('notapub_txCat', JSON.stringify(j.txCat)); }
    if (j.txPm)  { HIST.txPm  = j.txPm;  localStorage.setItem('notapub_txPm', JSON.stringify(j.txPm)); }
    histLoaded = true;
    histLoadFailed = false;
    pruneStaleHistory();
    buildAccountBalances();
    renderAccountBalanceCards();
    histLoadCallbacks.forEach(cb => cb());
    histLoadCallbacks = [];
  } catch(e) {
    console.warn('allOpex load failed:', e.message);
    // One automatic retry before giving up — a lot of failures here are a transient
    // token refresh/network hiccup during the same startup window, not a real outage.
    if (!_isRetry) {
      await new Promise(r => setTimeout(r, 1500));
      return loadHistData(true);
    }
    const cachedCat = localStorage.getItem('notapub_txCat');
    const cachedPm  = localStorage.getItem('notapub_txPm');
    if (cachedCat) HIST.txCat = JSON.parse(cachedCat);
    if (cachedPm)  HIST.txPm  = JSON.parse(cachedPm);
    // HIST.opex itself was never backfilled here before — on a timeout/error this left
    // it at its initial [], silently wiping every previous month from the calendar and
    // Insights even though the only thing that failed was this one fetch. data-store.js's
    // handleGetAllOpex() already keeps its own last-known-good copy of the exact same
    // payload in localStorage (notapub_opex_cache_<spreadsheetId>) for its stale-while-
    // revalidate path — reuse it here as a fallback instead of leaving HIST.opex empty.
    try {
      const ssId = DataStore.getSpreadsheetId();
      const cachedOpex = ssId ? JSON.parse(localStorage.getItem(`notapub_opex_cache_${ssId}`) || 'null') : null;
      if (cachedOpex && Array.isArray(cachedOpex.rows)) {
        HIST.opex = cachedOpex.rows;
        const now = new Date();
        const cachedRows = JSON.parse(localStorage.getItem(curMonthCacheKey()) || 'null');
        if (cachedRows && cachedRows.length > 0) _applyCurrentMonthRows(cachedRows, now.getFullYear(), now.getMonth()+1);
      }
    } catch (cacheErr) {
      console.warn('opex cache fallback failed:', cacheErr.message);
    }
    // Falling back to whatever's cached (often just recent months) rather than the
    // full history — mark it so the app can distinguish "loaded" from "gave up" and
    // offer to retry, instead of silently pretending history is complete.
    histLoaded = true;
    histLoadFailed = true;
    showToast('Couldn’t load full history — showing cached data', 'error', 4000);
    pruneStaleHistory();
    buildAccountBalances();
    renderAccountBalanceCards();
    histLoadCallbacks.forEach(cb => cb());
    histLoadCallbacks = [];
  }
}

// handleGetAllOpex()'s stale-while-revalidate cache returns the last-known-good
// payload synchronously and refreshes it in the background, firing this event once
// the fresh copy actually differs. Without a listener, any edit to a transaction
// outside the current month (the current month has its own separate cache that IS
// re-applied on every load) would appear to "revert" — the next loadHistData() call
// would keep returning the pre-edit snapshot until a fetch happened to race ahead of
// the read, then go stale again on the load after that.
window.addEventListener('notaOpexUpdated', (e) => {
  const payload = e.detail;
  if (!payload || !Array.isArray(payload.rows)) return;
  HIST.opex = payload.rows;
  const now = new Date();
  const cachedRows = JSON.parse(localStorage.getItem(curMonthCacheKey()) || 'null');
  if (cachedRows && cachedRows.length > 0) _applyCurrentMonthRows(cachedRows, now.getFullYear(), now.getMonth()+1);
  if (payload.txCat) { HIST.txCat = payload.txCat; localStorage.setItem('notapub_txCat', JSON.stringify(payload.txCat)); }
  if (payload.txPm)  { HIST.txPm  = payload.txPm;  localStorage.setItem('notapub_txPm', JSON.stringify(payload.txPm)); }
  pruneStaleHistory();
  buildAccountBalances();
  renderAccountBalanceCards();
  if (document.getElementById('page-home')?.classList.contains('active')) {
    calInited = false;
    initCalendar();
    calRefreshOpenDayPanel();
  }
});

(function() {
  const cachedCat = localStorage.getItem('notapub_txCat');
  const cachedPm  = localStorage.getItem('notapub_txPm');
  const cachedAccount = localStorage.getItem('notapub_txAccount');
  if (cachedCat) HIST.txCat = JSON.parse(cachedCat);
  if (cachedPm)  HIST.txPm  = JSON.parse(cachedPm);
  if (cachedAccount) HIST.txAccount = JSON.parse(cachedAccount);
})();

// ── INIT ──────────────────────────────────────────────────────
// (Moved inside DOMContentLoaded to ensure ui-insights.js functions are available)

// ── INIT v3.5: Render from cache instantly, fetch in background ──
window.addEventListener('DOMContentLoaded', async () => {
  updateHeaderHeight();
  window.addEventListener('resize', updateHeaderHeight);
  initDatePicker('inputDateRaw', 'inputDateDisplay', 'inputDateText');
  initDatePicker('inputDateRawI', 'inputDateDisplayI', 'inputDateTextI');
  initDatePicker('xfrDateRaw', 'xfrDateDisplay', 'xfrDateText');

  const isHome = () => document.getElementById('page-home').classList.contains('active');

  // Arms the splash/sign-in overlay to hide itself as soon as Auth.ready resolves —
  // safe to call this early since it just chains onto that promise internally.
  Auth.markAppReady();

  // The one-shot first-tap listener used to be set up here, but that meant it
  // wasn't attached until DOMContentLoaded — which can't fire until several
  // blocking <script> tags below finish loading, even though the calendar
  // skeleton (plain HTML) already paints well before that. Confirmed directly
  // from a screen recording: an early tap landed on nothing listening yet and
  // was silently lost, adding a real ~5s dead window before anything visibly
  // happened. It's now registered immediately after auth.js's own <script>
  // tag instead — see there for the actual listener.

  // Catches up on that early script's shell-transition signal: flips the
  // calendar from its static HTML skeleton to the real (properly-styled,
  // just data-less) shell as soon as the first tap fires, independent of
  // whether sign-in has resolved yet. initCalendar() no-ops harmlessly if
  // this races with the cache/network-driven render further down (that code
  // re-sets calInited = false itself before re-rendering with real data).
  function _showRealCalendarShell() {
    if (isHome() && !calInited) initCalendar();
  }
  if (window.__notaFirstTapFired) {
    _showRealCalendarShell(); // tap already happened before this handler ran
  } else {
    window.addEventListener('notaFirstTapFired', _showRealCalendarShell, { once: true });
  }

  // ── STUCK-SIGN-IN RECOVERY BANNER ───────────────────────────────────────
  // Surfaces a tappable retry affordance if sign-in/data-loading is still
  // stuck a few seconds after launch (e.g. an iOS installed-PWA OAuth popup
  // that opened and closed without completing — see auth.js's standalone
  // caveat). Two independent triggers, whichever fires first:
  //   1. auth.js's `notaTokenStuck` event — fired as soon as it knows for
  //      certain a token attempt failed or timed out.
  //   2. A fixed watchdog delay that re-checks the actual visible symptom
  //      (skeleton never replaced, or the persistent "Loading data…" toast
  //      never cleared) so it never fires on a merely-slow-but-fine load.
  // Deliberately one generic mechanism for every platform — not iOS-only —
  // so it also covers e.g. a desktop browser blocking the popup. Standalone
  // detection is used for exactly one thing: the escape-hatch link's label.
  (function() {
    const STUCK_WATCHDOG_MS = 9000;
    const banner = document.getElementById('stuckRecoveryBanner');
    const msg = document.getElementById('stuckRecoveryMsg');
    const btn = document.getElementById('stuckRecoveryBtn');
    const escapeLink = document.getElementById('stuckRecoveryEscape');
    let shown = false;

    function isStandalone() {
      return navigator.standalone === true ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    }

    function isStillStuck() {
      const skeletonVisible = isHome() && !calInited;
      const toastEl = document.getElementById('toast');
      const toastStuck = toastEl && toastEl.classList.contains('show') && toastEl.classList.contains('loading');
      // Deliberately cause-agnostic: "sign-in itself never resolved" and "sign-in
      // succeeded but the follow-up data fetch is stuck" look identical from
      // here (skeleton or a persistent loading toast, either way). showBanner()
      // below picks the right copy/action for whichever it actually is. An
      // earlier version of this check additionally required !Auth.hasValidToken()
      // to avoid a misleading "still connecting to Google" message — but that
      // also silently disabled the only recovery path for a stuck data fetch
      // after an already-successful sign-in (a real regression — see Session 52).
      return skeletonVisible || toastStuck;
    }

    function showBanner() {
      if (shown) return;
      shown = true;
      // A valid token already in hand means sign-in isn't actually the
      // problem — it's loadHistData()/fetchCurrentMonthFresh() that's stuck.
      // Reflect that honestly (not "still connecting to Google") and skip
      // re-running sign-in in the retry handler below.
      const signedIn = Auth.hasValidToken();
      msg.textContent = signedIn ? 'Still loading your data…' : 'Still connecting to Google…';
      btn.textContent = signedIn ? 'Retry' : 'Retry sign-in';
      if (isStandalone()) {
        escapeLink.textContent = 'Open Nota in Safari instead';
        escapeLink.href = location.href;
        escapeLink.target = '_blank';
        escapeLink.rel = 'noopener';
        escapeLink.onclick = null;
      } else {
        escapeLink.textContent = 'Reload the page';
        escapeLink.href = '#';
        escapeLink.removeAttribute('target');
        escapeLink.onclick = (e) => { e.preventDefault(); location.reload(); };
      }
      banner.style.display = 'flex';
    }

    function hideBanner() {
      shown = false;
      banner.style.display = 'none';
    }

    window.addEventListener('notaTokenStuck', showBanner);
    setTimeout(() => { if (isStillStuck()) showBanner(); }, STUCK_WATCHDOG_MS);

    btn.addEventListener('click', async () => {
      // Read once, at the moment of the click — used consistently through
      // this whole handler (including the finally block) even though
      // Auth's own state could in principle change mid-await.
      const alreadySignedIn = Auth.hasValidToken();
      btn.disabled = true;
      btn.textContent = 'Retrying…';
      try {
        if (!alreadySignedIn) {
          // Gesture-driven: invoked synchronously from this click, so the
          // popup it opens isn't blocked. signIn() never throws — check its
          // result.
          const ok = await Auth.signIn();
          if (!ok) return; // signIn() already re-enabled its own button/status
        }
        // Whether sign-in just ran or was already fine, the actual stuck
        // thing is the data fetch — re-run it either way.
        hideBanner();
        showToast('Loading data…', 'loading', 0);
        const [, freshMonth] = await Promise.all([loadHistData(), fetchCurrentMonthFresh()]);
        patchCurMonthCache();
        calInited = false;
        if (isHome()) initCalendar();
        showToast(freshMonth ? '✓ Updated' : 'Connected ✓', 'success', 3000);
      } catch (err) {
        console.warn('[home] stuck-recovery retry failed', err);
      } finally {
        btn.disabled = false;
        btn.textContent = alreadySignedIn ? 'Retry' : 'Retry sign-in';
      }
    });
  })();

  // Fire-and-forget: repopulates allCategories/allPMs/allStocks/allAccounts/CAT_COLORS/
  // ACCOUNT_CCY/STOCK_TYPE from the user's Config sheet once it resolves. Any picker/lookup
  // that runs before this resolves just sees the hardcoded defaults for a moment.
  fetchConfig();
  buildAccountBalances();
  renderAccountBalanceCards();

  // Reliable tap-to-edit on mobile: inline onclick is swallowed by iOS
  // -webkit-overflow-scrolling:touch scroll layers. Use touchstart/touchend
  // event delegation on the container to detect taps vs scrolls.
  (function() {
    const list = document.getElementById('calTxList');
    if (!list) return;
    let _ts = 0, _tx = 0, _ty = 0, _touchFired = 0;
    list.addEventListener('touchstart', e => {
      _ts = Date.now(); _tx = e.touches[0].clientX; _ty = e.touches[0].clientY;
    }, {passive: true});
    list.addEventListener('touchend', e => {
      const dt = Date.now() - _ts;
      const dx = Math.abs(e.changedTouches[0].clientX - _tx);
      const dy = Math.abs(e.changedTouches[0].clientY - _ty);
      if (dt > 400 || dx > 8 || dy > 8) return; // scroll or long-press
      const projItem = e.target.closest('.cal-tx-item[data-ruleid]');
      if (projItem) { _touchFired = Date.now(); openProjectedActionModal(projItem.dataset.ruleid, projItem.dataset.date); return; }
      const xfrItem = e.target.closest('.cal-tx-item[data-xfrid]');
      if (xfrItem) { _touchFired = Date.now(); openEditTransferOverlay(calCurrentTxns[parseInt(xfrItem.dataset.idx)]); return; }
      const item = e.target.closest('.cal-tx-item[data-idx]');
      if (!item) return;
      _touchFired = Date.now();
      openEditOverlay(parseInt(item.dataset.idx));
    }, {passive: true});
    // click fallback for non-touch (desktop); suppressed after touchend to avoid double-fire
    list.addEventListener('click', e => {
      if (Date.now() - _touchFired < 600) return;
      const projItem = e.target.closest('.cal-tx-item[data-ruleid]');
      if (projItem) { openProjectedActionModal(projItem.dataset.ruleid, projItem.dataset.date); return; }
      const xfrItem = e.target.closest('.cal-tx-item[data-xfrid]');
      if (xfrItem) { openEditTransferOverlay(calCurrentTxns[parseInt(xfrItem.dataset.idx)]); return; }
      const item = e.target.closest('.cal-tx-item[data-idx]');
      if (!item) return;
      openEditOverlay(parseInt(item.dataset.idx));
    });
  })();

  // Step 1: Show skeleton instantly — but only if the shell-transition catch-up
  // above hasn't already rendered the real (data-less) calendar. On a slow
  // launch the user's first tap can land before this handler even runs,
  // meaning _showRealCalendarShell() already called initCalendar() (setting
  // calInited = true) a few lines up. initCalendarSkeleton() doesn't touch
  // calInited, so an unconditional call here would silently overwrite that
  // real render with the skeleton and leave it stuck — every later
  // `if (isHome()) initCalendar()` call (the cache-render branch below,
  // the no-cache branch's post-fetch render) would then no-op forever,
  // since initCalendar() itself guards on calInited already being true.
  if (isHome() && !calInited) initCalendarSkeleton();

  // Step 2: Try rendering from localStorage cache for instant display
  const cachedCurMonth = (() => {
    const today = new Date();
    const y = today.getFullYear(), m = today.getMonth() + 1;
    const cacheKey = curMonthCacheKey(y, m);
    try { return JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch(e) { return null; }
  })();
  const cachedHistLoaded = !!(localStorage.getItem('notapub_txCat'));

  if (cachedHistLoaded && cachedCurMonth) {
    // Render from cache — near-instant
    const cachedCat = localStorage.getItem('notapub_txCat');
    const cachedPm  = localStorage.getItem('notapub_txPm');
    if (cachedCat) HIST.txCat = JSON.parse(cachedCat);
    if (cachedPm)  HIST.txPm  = JSON.parse(cachedPm);
    // Note: histLoaded stays false here — the localStorage cache only proves history
    // loaded in a *past* session, not that HIST.opex holds more than this cached
    // current month right now. Flipping it true here let other tabs (Insights, Net
    // Worth, Goals, Search) render off current-month-only data before the real
    // loadHistData() fetch below actually completed. It's set for real once that
    // fetch resolves, further down.
    const today = new Date();
    _applyCurrentMonthRows(cachedCurMonth, today.getFullYear(), today.getMonth() + 1);
    patchCurMonthCache();
    calInited = false;
    if (isHome()) initCalendar();
    // Show loading toast then fetch fresh in background
    showToast('Loading data…', 'loading', 0);
    const [,freshMonth] = await Promise.all([
      loadHistData(),
      fetchCurrentMonthFresh()
    ]);
    // Always re-render: first render used cache-only HIST.opex (no data.json history).
    // Re-render after both loadHistData + fetchCurrentMonthFresh complete so the
    // current-month total and any pre-loaded older months reflect full data.
    patchCurMonthCache();
    calInited = false;
    if (isHome()) {
      if (calOlderShown) calRefreshOlderMonths();
      initCalendar();
      if (freshMonth) showToast('✓ Updated', 'updated', 3000);
      else hideToast();
    } else {
      hideToast();
    }
  } else {
    // No cache — sequential load (first visit)
    showToast('Loading data…', 'loading', 0);
    await loadHistData();
    // Race fetchCurrentMonth against a 8s timeout so a hung network never
    // prevents initCalendar from running (e.g. no internet, sandboxed preview).
    const _monthFetch = fetchCurrentMonth();
    await Promise.race([_monthFetch, new Promise(r => setTimeout(r, 15000))]);
    patchCurMonthCache();
    hideToast();
    calInited = false;
    if (isHome()) initCalendar();
    // If Apps Script was cold and timed out above, re-render when it eventually finishes.
    // If it instead failed outright (transient network/auth hiccup on cold launch),
    // retry a couple times with backoff instead of leaving the calendar empty until
    // the user happens to revisit the Home tab (which re-triggers fetchCurrentMonth).
    _monthFetch
      .then(() => { patchCurMonthCache(); calInited = false; if (isHome()) initCalendar(); })
      .catch(async (err) => {
        console.warn('[home] initial month fetch failed, retrying', err);
        for (let attempt = 0; attempt < 2; attempt++) {
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          try {
            await fetchCurrentMonth(true);
            patchCurMonthCache();
            calInited = false;
            if (isHome()) initCalendar();
            return;
          } catch (e) { /* try next attempt */ }
        }
        console.error('[home] month fetch retries exhausted');
      });
  }

  // Retry any locally-queued transactions that failed to sync previously
  retryPendingQueue();
  // Sync recurring rules with Google Sheets first, then run due-check/retry on merged data
  // (avoids racing a stale pre-fetch push against the server merge — see checkRecurringOnLoad)
  fetchRecurring().then(() => {
    pruneExpiredRecurring();
    checkRecurringOnLoad();
    retryPendingRecurring();
  });
  // Request persistent storage so iOS doesn't silently evict PWA localStorage
  navigator.storage?.persist?.();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !_suppressVisRefresh && !isSyncing) {
      fetchCurrentMonth(true);
      // Queued writes used to sit until a full reload: retryPendingQueue() ran at boot
      // and nowhere else, despite the comments at submitTransfer/updateTransaction
      // promising a retry "on next load/focus". Re-entry is guarded inside the function.
      retryPendingQueue();
    }
  });

  // Connection restored — flush anything that failed while offline without waiting for
  // the user to background and re-foreground the app.
  window.addEventListener('online', () => { if (!isSyncing) retryPendingQueue(); });

  // ── INACTIVITY TIMEOUT (30 min) ──────────────────────────────
  // Clears local cache and reloads after 30 minutes of no interaction.
  // Protects against someone accessing the app on an unattended device.
  (function() {
    const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    let inactivityTimer = setTimeout(onInactive, TIMEOUT_MS);
    function resetTimer() {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(onInactive, TIMEOUT_MS);
    }
    function onInactive() {
      // Clear sensitive cached data, then reload to fresh state.
      // nota_queue_v2 and nota_history_v2 are intentionally excluded: they hold
      // unsynced transactions that have not reached the server yet — deleting them
      // causes permanent data loss with no recovery path.
      [curMonthCacheKey(),
       'notapub_invest_v2', 'notapub_fx', 'notapub_prices']
        .forEach(k => localStorage.removeItem(k));
      location.reload();
    }
    ['click','touchstart','keydown','scroll','mousemove'].forEach(ev =>
      document.addEventListener(ev, resetTimer, { passive: true })
    );
  })();
});

// Patch nota_curMonth_YYYY_M with any synced txHistory items that are missing from it.
// Guards against: (a) browser closed between cache-delete and fetchCurrentMonth completing,
// (b) fetchCurrentMonth timing out on cold Apps Script start. Uses count-based dedup so
// two identical transactions (e.g. two KRL 4k rides) are handled correctly.
// fetchCurrentMonth(true) called afterward will overwrite with authoritative rows + rowIndex.
function patchCurMonthCache() {
  // After a fresh sheet fetch, the sheet is authoritative. synced:true txHistory entries
  // absent from the clean cache were deleted from the sheet — don't re-add them.
  if (curMonthLastFetch > 0) return;
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth() + 1;
  const cacheKey = curMonthCacheKey(y, m);
  const mPad = String(m).padStart(2,'0');
  const prefix = `${y}-${mPad}-`;
  const syncedLocal = txHistory.filter(h => h.synced && typeof h.date === 'string' && h.date.startsWith(prefix));
  if (!syncedLocal.length) return;
  const cached = JSON.parse(localStorage.getItem(cacheKey) || '[]');
  // Count how many of each signature already exist in the cache
  const cacheCount = {};
  cached.forEach(e => {
    const k = sigOfSheetRow(e);
    cacheCount[k] = (cacheCount[k]||0) + 1;
  });
  const usedCount = {};
  let changed = false;
  for (const h of syncedLocal) {
    const d = parseInt(h.date.split('-')[2]);
    const isInc = h.type === 'income';
    const k = sigOfTxHistory(h);
    usedCount[k] = (usedCount[k]||0) + 1;
    if ((cacheCount[k]||0) >= usedCount[k]) continue; // cache already has this many
    const _live = (HIST.opex||[]).find(r=>r.y===y&&r.m===m-1&&r.d===d&&r.rowIndex&&r.tx.toLowerCase()===h.tx.toLowerCase()&&((r.exp||r.inc||0)===h.amount));
    dupDebugLog('patchCurMonthCache:add', { sig: k, cacheCount: cacheCount[k]||0, usedCount: usedCount[k], attachedRowIndex: _live?.rowIndex || null });
    cached.push({d, cat:h.category, tx:h.tx, pm:h.pm,
      ...(h.notes?{notes:h.notes}:{}),
      ...(isInc?{inc:h.amount}:{exp:h.amount}),
      ...(_live?.rowIndex?{rowIndex:_live.rowIndex}:{})});
    changed = true;
  }
  if (changed) {
    localStorage.setItem(cacheKey, JSON.stringify(cached));
    if (histLoaded) _applyCurrentMonthRows(cached, y, m);
  }
}

// In-flight guard. retryPendingQueue() now runs from three places (boot, `online`,
// visibilitychange), and two overlapping loops would POST every queued item twice.
// data-store.js has NO clientId idempotency cache — that lived in the Apps Script
// backend and died with it — so a double-POST writes a duplicate sheet row with
// nothing server-side to catch it. The HIST.opex signature check below is now the
// only dedup there is, and it can't see an in-flight request.
let _retryQueueInFlight = false;
async function retryPendingQueue() {
  if (_retryQueueInFlight) return;
  _retryQueueInFlight = true;
  try { await _retryPendingQueue(); }
  finally { _retryQueueInFlight = false; }
}

async function _retryPendingQueue() {
  if (!queue.length) return;
  const pending = [...queue];
  let synced = 0;
  for (const r0 of pending) {
    // Re-resolve against the live queue instead of trusting the snapshot: an edit made
    // while this loop is running patches the queued entry in place (updateTransaction /
    // updateInvestTransaction / the transfer edit path), and a delete removes it entirely.
    // Sending the snapshot would resurrect a deleted transaction or write stale values.
    const r = queue.find(q => q.id === r0.id || String(q.id) === String(r0.id));
    if (!r) continue;
    const isInvest = r.type === 'invest' || r.action === 'invest';
    const isTransfer = r.type === 'transfer';
    // Belt-and-suspenders dedup: an earlier fetchCurrentMonth/fetchCurrentMonthFresh in
    // this same boot already populated HIST.opex, so check in-memory first — no extra
    // network call — before blindly re-POSTing an item whose original request may have
    // succeeded server-side despite a client-side timeout (see syncOpex/fetchWithTimeout).
    // Transfers don't land in HIST.opex so this check doesn't apply to them; with the
    // Apps Script idempotency cache gone they have no dedup at all.
    if (!isInvest && !isTransfer && r.date) {
      const d = parseInt(r.date.split('-')[2], 10);
      const sig = sigOfTxHistory(r);
      const alreadyCovered = (HIST.opex || []).some(o =>
        o.y === +r.date.slice(0,4) && o.m === +r.date.slice(5,7) - 1 && o.d === d && sigOfSheetRow(o) === sig);
      if (alreadyCovered) {
        queue = queue.filter(q => q.id !== r.id);
        txHistory = txHistory.map(h => h.id === r.id ? {...h, synced:true} : h);
        synced++;
        continue;
      }
    }
    const ok = isInvest ? await syncInvest(r) : isTransfer ? await syncTransfer(r) : await syncOpex(r);
    if (ok) {
      queue = queue.filter(q => q.id !== r.id);
      // Invest rows live in investHistory, not txHistory (see submitInvest). Mapping only
      // txHistory left every retried investment stuck at synced:false forever — it kept
      // rendering as "pending" in Search and stayed in the unsynced list at line ~2521.
      if (isInvest) investHistory = investHistory.map(h => h.id === r.id ? {...h, synced:true} : h);
      else txHistory = txHistory.map(h => h.id === r.id ? {...h, synced:true} : h);
      synced++;
    }
  }
  if (synced > 0) {
    saveLocal();
    updateStatus();
    // Same optimistic-insert pattern as submitOpex: patch cache before forced refresh
    // so a browser close between the removeItem and the fetch doesn't lose the rows.
    patchCurMonthCache();
    fetchCurrentMonth(true).then(rowCount => {
      calInited = false;
      if (document.getElementById('page-home').classList.contains('active')) initCalendar();
      if (rowCount === 0) showToast('Sent to sheet — couldn\'t confirm readback', 'error', 6000);
      else showToast(`${synced} pending transaction${synced>1?'s':''} synced ✓`, 'success', 4000);
    });
  }
}
