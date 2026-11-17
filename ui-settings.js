// Nota — the leftovers of the original ui-settings.js, kept at its original load position.
//
// Config, accounts, goals and recurring now live in their own files. What is left is two
// nav helpers, one data-layer function and the global error listener. None of them is a
// settings concern, and none of them had anywhere better to go in this pass:
//   - fetchCurrentMonthFresh() belongs with the other month-fetching code in index.html
//     (it duplicates fetchCurrentMonth there); moving it is part of pulling the inline
//     script out, not of this split.
//   - the error listener is registered at this point in the load order on purpose; moving
//     it earlier would catch more, which is a behaviour change and needs its own commit.

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
    // Bound this the same way as fetchCurrentMonth()/loadHistData() (index.html) —
    // a raw fetch() here routes through requireReady()/Auth.getAccessToken() and can
    // hang forever if a stuck token wait is never resolved (see auth.js _tokenReady).
    const res = await fetchWithTimeout(apiGet(`type=month&y=${y}&m=${m}`), { method: 'GET' }, 10000);
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
