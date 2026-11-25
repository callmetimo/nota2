// Nota — recurring transactions: the recurrence rules, when they next fall due, the
// prompt that offers them, and the Settings list that edits them.
//
// Split out of ui-settings.js, unchanged. The largest of the four at ~758 lines.
//
// Rules live in RECURRING_RULES (declared in index.html) and are pushed to the sheet
// debounced; see the README on the push/merge race this has been bitten by before.

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
    // Was a raw fetch() — same hang risk as the others fixed alongside this one.
    const res = await fetchWithTimeout(apiGet('type=recurring'), { method: 'GET' });
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
            lastFired: (local?.lastFired && _firedThrough(local) > _firedThrough(r))
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
  // clientTs is sent so the server COULD reject this write if a newer one already landed —
  // fetchWithTimeout's Promise.race does NOT cancel the underlying fetch, so an abandoned
  // (client-timed-out) request can still complete server-side minutes later and silently
  // overwrite newer data. NOTE: data-store.js's handleRecurring() does not currently act on
  // this field — no staleness guard actually exists server-side yet (would need a persisted
  // last-write timestamp that doesn't exist anywhere today). Sent here for a future fix.
  const clientTs = Date.now();
  try {
    // allowEmpty confirms to the server this is a deliberate "delete the last rule" push, not
    // an accidental empty array from a client-side bug — data-store.js's handleRecurring()
    // refuses to wipe an already-populated sheet with an empty saveAll unless this is set.
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

function _autoSetEndYear(yearId) {
  const yEl = document.getElementById(yearId);
  if (!yEl.value) yEl.value = String(new Date().getFullYear());
}

function _getEndMonthValue(monthId, yearId) {
  const m = document.getElementById(monthId).value;
  const y = document.getElementById(yearId).value.trim();
  // Year is a free-typed number field — require a real 4-digit year (matching endMonth's own
  // storage format) before combining. If month is set but year is missing/invalid, treat it
  // the same as no end date at all (silent — "Repeat until" is explicitly optional) rather
  // than blocking the rest of the save.
  if (!m || !/^\d{4}$/.test(y)) return null;
  return `${y}-${m}`;
}

function _setEndMonthValue(monthId, yearId, value) {
  const mEl = document.getElementById(monthId);
  const yEl = document.getElementById(yearId);
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    const [year, month] = value.split('-');
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
const _MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const _DAY_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const _FREQ_UNITS = { daily: ['day', 'days'], weekly: ['week', 'weeks'], monthly: ['month', 'months'], yearly: ['year', 'years'] };
const _ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── Recurrence engine ─────────────────────────────────────────
// A rule repeats every `interval` `frequency`-units (daily/weekly/monthly/yearly) from `startDate`.
// Rules saved before this existed have no frequency/interval/startDate: they read as monthly,
// every 1, with the start derived from dayOfMonth + lastFired (see _ruleStart) — old rows are
// never rewritten just to fill these in.
// lastFired is either a legacy "YYYY-MM" (every occurrence in that month is handled) or a full
// "YYYY-MM-DD" (everything on or before that day is handled) — see _firedThrough.
function _p2(n) { return String(n).padStart(2, '0'); }
function _lastDayOf(year, month) { return new Date(year, month, 0).getDate(); }
function _isoOf(y, m, d) { return `${y}-${_p2(m)}-${_p2(d)}`; }
function _isoAddDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return _isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function _isoDiffDays(a, b) {  // b - a, in whole days
  const pa = a.split('-').map(Number), pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

function _ruleFreq(r) { return _FREQ_UNITS[r.frequency] ? r.frequency : 'monthly'; }
function _ruleInterval(r) {
  const n = Math.floor(Number(r.interval));
  return n >= 1 ? Math.min(n, 999) : 1;
}
// Day-of-month used by monthly/yearly rules; sticks to the original day so a Jan 31 rule
// lands on Feb 28 then back on Mar 31 instead of drifting to the 28th forever.
function _ruleAnchorDay(r) {
  return _ISO_DATE_RE.test(r.startDate || '') ? parseInt(r.startDate.slice(8, 10), 10) : (r.dayOfMonth || 1);
}
function _ruleStart(r) {
  if (_ISO_DATE_RE.test(r.startDate || '')) return r.startDate;
  const lf = r.lastFired || '';
  const [y, mFromFired] = (lf.length >= 7 ? lf.slice(0, 7) : curMonthKey()).split('-').map(Number);
  const m = _ruleFreq(r) === 'yearly' ? (r.monthOfYear || 1) : mFromFired;
  return _isoOf(y, m, Math.min(r.dayOfMonth || 1, _lastDayOf(y, m)));
}
function _firedThrough(r) {
  const lf = r.lastFired || '';
  if (_ISO_DATE_RE.test(lf)) return lf;
  if (/^\d{4}-\d{2}$/.test(lf)) return _isoOf(lf.slice(0, 4), lf.slice(5, 7), _lastDayOf(+lf.slice(0, 4), +lf.slice(5, 7)));
  return '';
}
function _stampFiredThrough(rule, date) {
  if (date && date > _firedThrough(rule)) rule.lastFired = date;
}

// Every occurrence date (ISO, ascending) of a rule within [fromISO, toISO], ignoring fired state.
function _ruleOccurrences(r, fromISO, toISO) {
  const freq = _ruleFreq(r), n = _ruleInterval(r), start = _ruleStart(r), anchor = _ruleAnchorDay(r);
  const [sy, sm] = start.split('-').map(Number);
  const [fy, fm] = fromISO.split('-').map(Number);
  let k = 0;
  if (fromISO > start) {  // jump close to the window instead of walking from the start date
    if (freq === 'daily') k = Math.floor(_isoDiffDays(start, fromISO) / n);
    else if (freq === 'weekly') k = Math.floor(_isoDiffDays(start, fromISO) / (7 * n));
    else if (freq === 'monthly') k = Math.floor(((fy - sy) * 12 + (fm - sm)) / n);
    else k = Math.floor((fy - sy) / n);
    k = Math.max(0, k - 1);
  }
  const out = [];
  for (let guard = 0; guard < 2000; guard++, k++) {
    let date;
    if (freq === 'daily') date = _isoAddDays(start, k * n);
    else if (freq === 'weekly') date = _isoAddDays(start, k * n * 7);
    else if (freq === 'monthly') {
      const t = sm - 1 + k * n;
      const y = sy + Math.floor(t / 12), m = t % 12 + 1;
      date = _isoOf(y, m, Math.min(anchor, _lastDayOf(y, m)));
    } else {
      const y = sy + k * n;
      date = _isoOf(y, sm, Math.min(anchor, _lastDayOf(y, sm)));
    }
    if (date > toISO) break;
    if (date >= fromISO && date >= start) out.push(date);
  }
  return out;
}

function _ruleDescribe(r) {
  const freq = _ruleFreq(r), n = _ruleInterval(r), anchor = _ruleAnchorDay(r);
  const [sy, sm, sd] = _ruleStart(r).split('-').map(Number);
  const dow = _DAY_FULL[new Date(sy, sm - 1, sd).getDay()];
  if (freq === 'daily') return n === 1 ? 'Every day' : `Every ${n} days`;
  if (freq === 'weekly') return n === 1 ? `Every ${dow}` : `Every ${n} weeks on ${dow}`;
  if (freq === 'monthly') return n === 1 ? `Every ${ordinalSuffix(anchor)} of the month` : `Every ${n} months on the ${ordinalSuffix(anchor)}`;
  return `${n === 1 ? 'Every year' : `Every ${n} years`} on ${_MONTH_FULL[sm - 1]} ${anchor}`;
}

// Reads the Repeats / Every / Starts-on fields. Until the user touches the start date it
// follows the transaction's own date (fallbackStart). Returns null if anything is invalid.
function _readRecurringSchedule(freqId, intId, startId, fallbackStart) {
  const frequency = document.getElementById(freqId).value;
  const interval = parseInt(document.getElementById(intId).value, 10);
  const startEl = document.getElementById(startId);
  const startDate = startEl.dataset.touched ? startEl.value : (fallbackStart || startEl.value);
  if (!_FREQ_UNITS[frequency] || !(interval >= 1 && interval <= 999) || !_ISO_DATE_RE.test(startDate)) return null;
  const [, monthOfYear, dayOfMonth] = startDate.split('-').map(Number);
  return { frequency, interval, startDate, dayOfMonth, monthOfYear };
}

function _updateIntervalUnit(freqId, intId, unitId) {
  const n = parseInt(document.getElementById(intId).value, 10);
  const units = _FREQ_UNITS[document.getElementById(freqId).value] || _FREQ_UNITS.monthly;
  document.getElementById(unitId).textContent = n === 1 ? units[0] : units[1];
}

// Old installment rules (installmentTotal > 0) stay in the sheet untouched but no longer generate anything:
// installments are tracked from the recorded "CICILAN KE X DARI Y" rows in CC Usage. Reverting this
// commit brings them back exactly as they were.
function isLegacyInstallmentRule(r) { return Number(r.installmentTotal) > 0; }

function getRecurringDue() {
  const today = todayISO();
  const due = [];
  loadRecurring().forEach(r => {
    if (!r.active || isLegacyInstallmentRule(r)) return;
    const fired = _firedThrough(r);
    // Every occurrence on or before today that hasn't been handled yet — a backlog is offered
    // in full (one entry per missed occurrence), each carrying its own date as `_date`.
    _ruleOccurrences(r, fired ? _isoAddDays(fired, 1) : '0001-01-01', today).forEach(date => {
      if (r.endMonth && date.slice(0, 7) > r.endMonth) return;
      due.push({ ...r, _date: date });
    });
  });
  return due.sort((a, b) => a._date.localeCompare(b._date));
}

function getRecurringProjections(year, month) {
  const from = _isoOf(year, month, 1), to = _isoOf(year, month, _lastDayOf(year, month));
  const out = [];
  loadRecurring().forEach(r => {
    if (!r.active || isLegacyInstallmentRule(r)) return;
    const fired = _firedThrough(r);
    _ruleOccurrences(r, from, to).forEach(date => {
      if (date <= fired) return;
      if (r.endMonth && date.slice(0, 7) > r.endMonth) return;
      out.push({
        id: `proj_${r.id}_${date}`,
        ruleId: r.id,
        date,
        tx: r.tx,
        amount: r.amount,
        category: r.cat,
        pm: r.pm,
        notes: r.notes || '',
        type: r.type,
        projected: true,
      });
    });
  });
  return out;
}

// Remove recurring rules whose end month has fully passed — from the app and, via the normal
// saveRecurring()/tombstone pipeline, from the Recurring sheet tab too. Strict "<" (not "<=")
// so a rule due in its own final month (endMonth === curMonthKey()) is left alone: both
// getRecurringDue() and getRecurringProjections() above already use ">=", so nothing still-
// current can ever be pruned here. Called once per app load, after fetchRecurring() resolves
// (see index.html), so it prunes against the authoritative merged rule set.
function pruneExpiredRecurring() {
  const mk = curMonthKey();
  const rules = loadRecurring();
  const expired = rules.filter(r => r.endMonth && r.endMonth < mk);
  if (!expired.length) return;
  expired.forEach(r => _tombstoneRecurringId(r.id));
  saveRecurring(rules.filter(r => !(r.endMonth && r.endMonth < mk)));
  if (document.getElementById('page-recurring')?.classList.contains('active')) {
    renderRecurringList();
  }
}

// Repeats / Every fields in the input form: keep the unit word ("month", "weeks", ...) and the
// summary line in step with what the user picked.
function onRecurringFreqChange() {
  _updateIntervalUnit('inputRecurringFreq', 'inputRecurringInterval', 'inputRecurringUnit');
  const sched = _readRecurringSchedule('inputRecurringFreq', 'inputRecurringInterval', 'inputRecurringStart',
    document.getElementById('inputDateRaw').value);
  document.getElementById('inputRecurringSummary').textContent = sched
    ? `${_ruleDescribe(sched)}, starting ${isoDisp(sched.startDate)}` : '';
}

function onRecurringStartTouched() {
  document.getElementById('inputRecurringStart').dataset.touched = '1';
  onRecurringFreqChange();
}

function onRecurringEditFreqChange() {
  _updateIntervalUnit('recurringEditFreq', 'recurringEditInterval', 'recurringEditUnit');
}

function resetRecurringScheduleFields() {
  document.getElementById('inputRecurringFreq').value = 'monthly';
  document.getElementById('inputRecurringInterval').value = 1;
  const startEl = document.getElementById('inputRecurringStart');
  startEl.value = '';
  delete startEl.dataset.touched;
  onRecurringFreqChange();
}

// Toggle the schedule and end-date rows in the input form
function toggleRecurringRow() {
  const on = document.getElementById('inputRecurring').checked;
  document.getElementById('recurringDayRow').style.display = on ? '' : 'none';
  document.getElementById('recurringEndRow').style.display = on ? '' : 'none';
  if (on) {
    const startEl = document.getElementById('inputRecurringStart');
    startEl.value = document.getElementById('inputDateRaw').value || todayISO();
    delete startEl.dataset.touched;
    onRecurringFreqChange();
  } else {
    document.getElementById('inputRecurringEndMonth').value = '';
    document.getElementById('inputRecurringEndYear').value = '';
  }
}

// ── COMBINED "READY TO ADD" POPUP ─────────────────────────────────────────────
// One modal (#pendingPrompt) shared by the recurring-due list and the email-import
// suggestions, so the two never stack. Each source renders its own section and reports
// {rows, checked} via set(); this owns open/close and the single Add button.
const PendingPrompt = (() => {
  const SECTION = { recurring: 'recurringSection', email: 'emailSection' };
  const counts = { recurring: { n: 0, checked: 0 }, email: { n: 0, checked: 0 } };
  const $ = id => document.getElementById(id);
  function open() { const m = $('pendingPrompt'); if (m) m.classList.add('open'); }
  function close() { const m = $('pendingPrompt'); if (m) m.classList.remove('open'); }
  function refresh() {
    let total = 0, checked = 0;
    for (const k in counts) {
      const sec = $(SECTION[k]);
      if (sec) sec.style.display = counts[k].n ? '' : 'none';
      total += counts[k].n; checked += counts[k].checked;
    }
    const btn = $('pendingAddBtn');
    if (btn) {
      btn.textContent = checked ? `Add ${checked} Transaction${checked !== 1 ? 's' : ''}` : 'Done';
      btn.style.opacity = '1';
    }
    if (!total) close();
  }
  function set(name, n, checked) {
    counts[name] = { n, checked };
    refresh();
    if (n) open();
  }
  // "Decide later": nothing is stamped as handled. Email rows return on the next check; recurring
  // occurrences are un-flagged as "already prompted" so they are offered again on the next open.
  function later() {
    close();
    if (typeof _recurringPromptLater === 'function') _recurringPromptLater();
  }
  function addAll() {
    if (isSyncing) return;
    isSyncing = true;
    const btn = $('pendingAddBtn');
    if (btn) btn.disabled = true;
    const release = () => { isSyncing = false; if (btn) btn.disabled = false; };
    let promises = [];
    try {
      if (counts.recurring.n) promises = promises.concat(_addCheckedRecurring());
      if (counts.email.n) promises = promises.concat(EmailImport.addChecked());
    } catch (e) {
      console.error('[pending-prompt] add failed', e && e.message);
    }
    saveLocal(); updateStatus();
    const n = promises.length;
    if (n) showToast(`${n} transaction${n !== 1 ? 's' : ''} added ✓`, 'success');
    // Refresh the calendar once every sync has settled so the server already has the rows
    // when fetchCurrentMonth(true) asks for them (no duplicate between HIST.opex and txHistory).
    // allSettled, not all: one rejected sync must not leave isSyncing stuck true.
    Promise.allSettled(promises).then(() => {
      release();
      calInited = false;
      if (document.getElementById('page-home').classList.contains('active')) initCalendar();
      fetchCurrentMonth(true).then(() => {
        calInited = false;
        if (document.getElementById('page-home').classList.contains('active')) initCalendar();
      });
    }).catch(e => { console.error('[pending-prompt] post-sync failed', e && e.message); release(); });
  }
  return { set, open, close, later, addAll };
})();

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

  // Keyed per occurrence (rule id + date) so a daily/weekly backlog isn't collapsed to one entry.
  const due = getRecurringDue().filter(r => !promptedSet.has(`${r.id}|${r._date}`));
  if (!due.length) return;
  _pendingRecurring = due;

  // Record these rule ids as "prompted" immediately — survives app close without any
  // interaction — but do NOT stamp lastFired here. lastFired only changes once the user
  // actually confirms Add or an explicit Skip (addSelectedRecurring / dismissRecurringPrompt),
  // so if the app is killed between "popup shown" and "user taps Add" (iOS PWA), the rule
  // stays correctly due and gets prompted again on the next open instead of silently
  // vanishing into an unsynced, permanently-projected calendar entry.
  due.forEach(r => promptedSet.add(`${r.id}|${r._date}`));
  localStorage.setItem(promptedKey, JSON.stringify([...promptedSet]));
  // Clean up stale prompt-tracking keys from previous months (old blanket-flag format too)
  Object.keys(localStorage)
    .filter(k => k.startsWith('notapub_rprompt_') && k !== promptedKey)
    .forEach(k => localStorage.removeItem(k));

  _renderRecurringPrompt();
}

// "Decide later" in the combined popup: forget that these occurrences were prompted this month
// so the next app open offers them again (lastFired was never stamped, so they are still due).
function _recurringPromptLater() {
  if (!_pendingRecurring.length) return;
  const promptedKey = 'notapub_rprompt_ids_' + curMonthKey();
  try {
    const drop = new Set(_pendingRecurring.map(r => `${r.id}|${r._date}`));
    const ids = JSON.parse(localStorage.getItem(promptedKey) || '[]').filter(k => !drop.has(String(k)));
    localStorage.setItem(promptedKey, JSON.stringify(ids));
  } catch (e) {}
}

function _renderRecurringPrompt() {
  const n = _pendingRecurring.length;
  document.getElementById('recurringPromptSubtitle').textContent =
    `${n} transaction${n > 1 ? 's' : ''} due`;
  const list = document.getElementById('recurringPromptList');
  list.innerHTML = _pendingRecurring.map((r, i) => `
    <label class="recurring-prompt-item">
      <input class="recurring-prompt-check" type="checkbox" data-ridx="${i}" checked onchange="_updateRecurringPromptBtn()">
      <div class="recurring-prompt-info">
        <div class="recurring-prompt-tx">${esc(r.tx)}</div>
        <div class="recurring-prompt-meta">${esc(r.cat)} · ${esc(r.pm)} · ${esc(isoDisp(r._date))}</div>
      </div>
      <div class="recurring-prompt-amt ${r.type === 'income' ? 'income' : ''}" style="color:${r.type==='income'?'var(--green)':'var(--text)'}">${r.type === 'income' ? '+' : '-'}${fRp(r.amount)}</div>
    </label>`).join('');
  PendingPrompt.set('recurring', n, n);
}

function _updateRecurringPromptBtn() {
  const n = document.querySelectorAll('#recurringPromptList input:checked').length;
  PendingPrompt.set('recurring', _pendingRecurring.length, n);
}

// Shared by addSelectedRecurring() (bulk, from the due-popup) and handleProjectedAddSync()
// (single, from tapping a still-projected calendar entry and choosing "Add & Sync") — builds
// the local optimistic transaction and pushes it to the sheet the same way submitOpex() does.
function _addAndSyncRecurringRule(r) {
  const today = r._date || todayISO();  // the occurrence's own date (a backlog item may be older)
  const rec = { id: Date.now() + Math.random(), date: today, tx: r.tx, amount: r.amount,
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
    // Only the current month has a live cache to keep in step; an older backlog occurrence is
    // picked up from the sheet instead (seeding a cache for a month never loaded would make
    // that cache look authoritative and hide the rest of the month).
    if (today.slice(0, 7) !== curMonthKey()) { saveLocal(); return; }
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
let _projectedActionDate = null;

function openProjectedActionModal(ruleId, date) {
  const rules = loadRecurring();
  const r = rules.find(x => String(x.id) === String(ruleId));
  if (!r) return;
  _projectedActionRuleId = ruleId;
  _projectedActionDate = date || null;
  document.getElementById('projectedActionSubtitle').textContent =
    `"${r.tx}" (${fRp(r.amount)})${date ? ' on ' + isoDisp(date) : ''} — add & sync to Google Sheets, or skip this occurrence if you've already recorded it another way.`;
  document.getElementById('projectedActionModal').classList.add('open');
}

function closeProjectedActionModal() {
  document.getElementById('projectedActionModal').classList.remove('open');
  _projectedActionRuleId = null;
}

function handleProjectedAddSync() {
  const ruleId = _projectedActionRuleId;
  const date = _projectedActionDate || todayISO();
  closeProjectedActionModal();
  if (isSyncing || !ruleId) return;
  const rules = loadRecurring();
  const idx = rules.findIndex(x => String(x.id) === String(ruleId));
  if (idx === -1) return;
  const r = rules[idx];
  isSyncing = true;
  _stampFiredThrough(rules[idx], date);
  saveRecurring(rules);
  showToast('Saving…', 'loading', 0);
  _addAndSyncRecurringRule({ ...r, _date: date }).then(() => {
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
  const date = _projectedActionDate || todayISO();
  closeProjectedActionModal();
  if (!ruleId) return;
  const rules = loadRecurring();
  const idx = rules.findIndex(x => String(x.id) === String(ruleId));
  if (idx === -1) return;
  _stampFiredThrough(rules[idx], date);
  saveRecurring(rules);
  showToast('Occurrence skipped', 'success');
  calInited = false;
  if (document.getElementById('page-home').classList.contains('active')) {
    initCalendar();
    calRefreshOpenDayPanel();
  }
}

// Queues the checked occurrences (called by PendingPrompt.addAll, which owns the isSyncing guard,
// the toast and the calendar refresh). Unchecked ones are dropped: dismissRecurringPrompt() stamps
// every pending occurrence as handled so the prompt does not re-appear on the next open.
function _addCheckedRecurring() {
  const checkedIdx = new Set([...document.querySelectorAll('#recurringPromptList input[type=checkbox]:checked')]
    .map(cb => +cb.dataset.ridx));
  const rules = loadRecurring();
  const promises = [];
  _pendingRecurring.forEach((r, i) => {
    if (!checkedIdx.has(i)) return;
    const idx = rules.findIndex(x => x.id === r.id);
    if (idx !== -1) _stampFiredThrough(rules[idx], r._date);
    promises.push(_addAndSyncRecurringRule(r));
  });
  saveRecurring(rules);
  dismissRecurringPrompt();
  return promises;
}

function dismissRecurringPrompt() {
  const rules = loadRecurring();
  let changed = false;
  (_pendingRecurring || []).forEach(r => {
    const idx = rules.findIndex(x => x.id === r.id);
    if (idx === -1) return;
    const before = rules[idx].lastFired;
    _stampFiredThrough(rules[idx], r._date);
    if (rules[idx].lastFired !== before) changed = true;
  });
  if (changed) saveRecurring(rules);
  _pendingRecurring = [];
  PendingPrompt.set('recurring', 0, 0);
}

// ── RECURRING LIST PAGE ───────────────────────────────────────────────────────

function renderRecurringList() {
  const all = loadRecurring();
  const rules = all.filter(r => !isLegacyInstallmentRule(r));
  const hidden = all.length - rules.length;
  const hiddenNote = hidden
    ? `<p style="color:var(--text2);text-align:center;padding:12px 0;font-size:12px">${hidden} old installment rule${hidden > 1 ? 's' : ''} hidden — installments are now tracked in CC Usage.</p>`
    : '';
  const container = document.getElementById('recurringListContainer');
  if (!rules.length) {
    container.innerHTML = '<p style="color:var(--text2);text-align:center;padding:48px 0 24px;font-size:14px">No recurring transactions yet.<br>' + notaTap(1) + ' + to add one.</p>' + hiddenNote;
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
  container.innerHTML = html + hiddenNote;
}

function _recurringCard(r) {
  const isInc = r.type === 'income';
  const endLabel = r.endMonth ? `<div class="recurring-card-day" style="color:var(--text2)">Until ${_formatEndMonth(r.endMonth)}</div>` : '';
  return `<div class="recurring-card">
    <div class="recurring-card-dot ${isInc ? 'income' : 'expense'}"></div>
    <div class="recurring-card-info">
      <div class="recurring-card-tx">${esc(r.tx)}</div>
      <div class="recurring-card-meta">${esc(r.cat)} · ${esc(r.pm)}</div>
      <div class="recurring-card-day">${esc(_ruleDescribe(r))}</div>
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
  document.getElementById('recurringEditFreq').value     = _ruleFreq(r);
  document.getElementById('recurringEditInterval').value = _ruleInterval(r);
  document.getElementById('recurringEditStart').value    = _ruleStart(r);
  onRecurringEditFreqChange();
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
  const sched = _readRecurringSchedule('recurringEditFreq', 'recurringEditInterval', 'recurringEditStart', '');
  if (!tx || !cat || !amt || !pm || !sched) {
    showToast('All fields required (every 1–999, valid start date)', 'error'); return;
  }
  const rules = loadRecurring();
  const idx = rules.findIndex(x => x.id === id);
  if (idx === -1) { closeRecurringEditModal(); return; }
  const endMonth = _getEndMonthValue('recurringEditEndMonth', 'recurringEditEndYear');
  rules[idx] = { ...rules[idx], type: _recurringEditType, tx, cat, amount: amt, pm, notes, endMonth: endMonth || null, ...sched };
  saveRecurring(rules);
  closeRecurringEditModal();
  renderRecurringList();
  showToast('Updated ✓', 'success');
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
  showToast('Deleted ✓', 'success');
}
