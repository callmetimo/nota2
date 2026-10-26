// Nota — Email Import.
// Reads bank notification emails from the signed-in user's own Gmail (read-only, in the
// browser — nothing is sent to any server other than the user's own Sheet), turns them into
// suggested transactions and lets the user confirm them in a popup, the same way the
// "Recurring Today" popup works. Parsing lives in email-parser.js; this file owns Gmail
// access, rules/settings storage, the review popup and the Settings page.
//
// Depends on globals from index.html / ui-settings.js: Auth, EmailParser, apiGet, apiBody,
// fetchWithTimeout, esc, fRp, isoDisp, showToast, allCategories, allPMs, isSyncing,
// _addAndSyncRecurringRule, saveLocal, calInited, initCalendar, fetchCurrentMonth.

const EmailImport = (() => {
  const LS_FLAG = 'notapub_email_import_on';          // shared with auth.js
  const LS_STATE = 'notapub_email_import_state';      // { config, seen, dirty }
  const LS_LAST = 'notapub_email_import_last';        // ms timestamp of last successful check
  const LS_STATS = 'notapub_email_import_stats';      // { unreadable }
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const MIN_INTERVAL_MS = 5 * 60 * 1000;
  const FIRST_RUN_DAYS = 7;
  const MAX_SEEN = 600;
  const MAX_FETCH = 60;

  // Only these exact senders are listed (forwarded copies keep the original From). They are tied
  // to the templates email-parser.js understands, so they are fixed here rather than a setting;
  // add a sender here together with its parser.
  const SENDERS = ['bca@bca.co.id', 'kartukreditbca@bca.co.id', 'BIFAST.NOREPLY@cimbniaga.co.id'];
  const QUERY_BASE = `from:(${SENDERS.join(' OR ')})`;

  let config = { types: {}, accounts: [], rules: [] };
  let seen = [];                 // newest last
  let seenSet = new Set();
  let dirty = false;
  let pending = [];              // items waiting for the user in the popup
  let checking = false;
  let serverLoaded = false;
  let pushTimer = null;
  let lastError = '';
  let editIdx = -1;              // popup item being edited
  let editRuleIdx = -1;          // rules[] index being edited (-1 = new)
  let editAcctIdx = -1;
  let popupWaitTimer = null;

  // ── enabled flag (per device — it also decides which scopes Auth requests) ──
  function isEnabled() { try { return localStorage.getItem(LS_FLAG) === '1'; } catch (e) { return false; } }

  // ── state persistence ─────────────────────────────────────
  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_STATE) || 'null');
      if (raw && typeof raw === 'object') {
        if (raw.config && typeof raw.config === 'object') config = normalizeConfig(raw.config);
        if (Array.isArray(raw.seen)) seen = raw.seen.map(String);
        dirty = !!raw.dirty;
      }
    } catch (e) { /* start empty */ }
    seenSet = new Set(seen);
  }

  function normalizeConfig(c) {
    const out = { types: {}, accounts: [], rules: [] };
    if (c.types && typeof c.types === 'object') {
      Object.keys(c.types).forEach(k => { if (c.types[k] === 'ask' || c.types[k] === 'ignore') out.types[k] = c.types[k]; });
    }
    if (Array.isArray(c.accounts)) {
      out.accounts = c.accounts.filter(a => a && a.key && a.pm).map(a => ({ key: String(a.key), pm: String(a.pm) }));
    }
    if (Array.isArray(c.rules)) {
      out.rules = c.rules.filter(r => r && r.pattern).map(r => ({
        mode: ['contains', 'equals', 'starts'].includes(r.mode) ? r.mode : 'contains',
        pattern: String(r.pattern), tx: String(r.tx || ''), cat: String(r.cat || ''),
      }));
    }
    return out;
  }

  function persistLocal() {
    try { localStorage.setItem(LS_STATE, JSON.stringify({ config, seen, dirty })); } catch (e) {}
  }

  function markSeen(...keys) {
    keys.filter(Boolean).forEach(k => { if (!seenSet.has(k)) { seenSet.add(k); seen.push(k); } });
    if (seen.length > MAX_SEEN) {
      seen = seen.slice(seen.length - MAX_SEEN);
      seenSet = new Set(seen);
    }
    save();
  }

  function save() {
    dirty = true;
    persistLocal();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushToServer, 800);
  }

  async function pushToServer() {
    if (!isEnabled() && !config.rules.length && !config.accounts.length) return;
    try {
      const res = await fetch(apiGet('type=emailimport'), {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: apiBody({ type: 'emailimport', action: 'save', config, seen }),
      });
      const j = await res.json();
      if (j.status === 'ok') { dirty = false; persistLocal(); }
      else console.warn('[email-import] save failed', j.message);
    } catch (e) { console.warn('[email-import] save error', e.message); }
  }

  // Server is the source of truth once it has data, unless this device has unsent edits.
  // `seen` is always merged (union), so an id handled on any device is never re-offered.
  async function loadFromServer() {
    if (serverLoaded) return;
    try {
      const res = await fetch(apiGet('type=emailimport'), { method: 'GET' });
      const j = await res.json();
      if (j.status !== 'ok') return;
      serverLoaded = true;
      if (j.exists && j.config && !dirty) config = normalizeConfig(j.config);
      if (Array.isArray(j.seen)) {
        const merged = [...j.seen.map(String), ...seen.filter(s => !j.seen.includes(s))];
        seen = merged.slice(-MAX_SEEN);
        seenSet = new Set(seen);
      }
      persistLocal();
      if (dirty || !j.exists) pushToServer();
    } catch (e) { console.warn('[email-import] load error', e.message); }
  }

  // ── Gmail ─────────────────────────────────────────────────
  async function gmailFetch(path) {
    const token = await Auth.getAccessToken();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(GMAIL + path, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`Gmail ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Gmail request timed out');
      throw e;
    } finally { clearTimeout(timer); }
  }

  function b64urlToText(data) {
    const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Walks the MIME tree; prefers a text/plain part, falls back to text/html.
  function messageBody(msg) {
    let plain = '', html = '';
    (function walk(part) {
      if (!part) return;
      const data = part.body && part.body.data;
      if (data && /^text\/plain/i.test(part.mimeType || '')) plain += b64urlToText(data) + '\n';
      else if (data && /^text\/html/i.test(part.mimeType || '')) html += b64urlToText(data) + '\n';
      (part.parts || []).forEach(walk);
    })(msg.payload);
    return plain.trim().length > 40 && /:/.test(plain) ? plain : (html || plain);
  }

  function localISO(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ── rules ─────────────────────────────────────────────────
  function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

  function ruleMatches(rule, text) {
    const t = norm(text), p = norm(rule.pattern);
    if (!t || !p) return false;
    if (rule.mode === 'equals') return t === p;
    if (rule.mode === 'starts') return t.startsWith(p);
    return t.includes(p);
  }

  function typeAction(typeId) {
    if (config.types[typeId]) return config.types[typeId];
    const t = EmailParser.TYPES.find(x => x.id === typeId);
    return t ? t.defaultAction : 'ask';
  }

  function findAccountPm(sourceKey) {
    if (!sourceKey) return '';
    const k = sourceKey.replace(/x/gi, '*');
    const hit = config.accounts.find(a => a.key.replace(/x/gi, '*').replace(/\s/g, '') === k);
    return hit ? hit.pm : '';
  }

  function isComplete(it) {
    return !!(it.tx && it.cat && it.pm && it.amount > 0 && it.date);
  }

  function buildItem(parsed, gmailId) {
    const rule = config.rules.find(r => ruleMatches(r, parsed.merchant));
    const pmValid = pm => pm && (typeof allPMs === 'undefined' || allPMs.includes(pm));
    const catValid = c => c && (typeof allCategories === 'undefined' || allCategories.includes(c));
    const pm = findAccountPm(parsed.sourceKey);
    const cat = rule ? rule.cat : '';
    const notes = [parsed.notes, parsed.ccy !== 'IDR' && parsed.nativeAmount ? `${parsed.ccy} ${parsed.nativeAmount}` : '']
      .filter(Boolean).join(' · ');
    const it = {
      gmailId, ref: parsed.ref || '', typeId: parsed.typeId, typeLabel: parsed.typeLabel,
      direction: parsed.direction, date: parsed.date, amount: parsed.amount || 0,
      merchant: parsed.merchant, sourceKey: parsed.sourceKey || '',
      defaultTx: parsed.defaultTx || parsed.merchant || parsed.typeLabel,
      tx: (rule && rule.tx) || parsed.defaultTx || parsed.merchant || parsed.typeLabel,
      cat: catValid(cat) ? cat : '', pm: pmValid(pm) ? pm : '', notes,
      foreign: parsed.ccy !== 'IDR' ? `${parsed.ccy} ${parsed.nativeAmount}` : '',
      checked: false,
    };
    it.checked = isComplete(it);
    return it;
  }

  // ── checking for new mail ─────────────────────────────────
  async function check(opts = {}) {
    if (!isEnabled() || checking) return;
    if (!Auth.hasGmailScope()) { lastError = Auth.hasValidToken() ? 'Gmail is not connected' : ''; renderPage(); return; }
    const last = Number(localStorage.getItem(LS_LAST) || 0);
    if (!opts.force && last && Date.now() - last < MIN_INTERVAL_MS) { maybeShowPopup(); return; }
    // Background re-checks (app returning to foreground) must not rebuild a list the user is mid-edit on.
    if (!opts.force && document.getElementById('emailEditModal')?.classList.contains('open')) return;
    checking = true; lastError = '';
    renderPage();
    try {
      await loadFromServer();
      const days = last ? Math.min(35, Math.max(3, Math.ceil((Date.now() - last) / 86400000) + 2)) : FIRST_RUN_DAYS;
      const list = await gmailFetch('/messages?maxResults=100&q=' + encodeURIComponent(`${QUERY_BASE} newer_than:${days}d`));
      const ids = (list.messages || []).map(m => m.id).filter(id => !seenSet.has('g:' + id)).slice(0, MAX_FETCH);
      const found = [];
      let unreadable = Number((JSON.parse(localStorage.getItem(LS_STATS) || '{}')).unreadable || 0);
      const queue = ids.slice();
      const worker = async () => {
        while (queue.length) {
          const id = queue.shift();
          let msg;
          try { msg = await gmailFetch(`/messages/${id}?format=full`); }
          catch (e) { if (e.status === 401 || e.status === 403) throw e; continue; } // transient: retry next check
          const body = messageBody(msg);
          const parsed = EmailParser.parse(body, localISO(Number(msg.internalDate) || Date.now()));
          if (!parsed) { markSeen('g:' + id); unreadable++; continue; }
          if (parsed.status === 'failed' || typeAction(parsed.typeId) === 'ignore') { markSeen('g:' + id, parsed.ref && 'r:' + parsed.ref); continue; }
          if (parsed.ref && seenSet.has('r:' + parsed.ref)) { markSeen('g:' + id); continue; }
          found.push(buildItem(parsed, id));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      // Same transaction mailed twice (e.g. forwarded copy + original): keep one.
      const byRef = new Set();
      const existing = new Map(pending.map(it => [it.gmailId, it]));
      // Reuse an item already in the list (same email) so edits the user has made are kept.
      pending = found.filter(it => {
        if (!it.ref) return true;
        if (byRef.has(it.ref)) { markSeen('g:' + it.gmailId); return false; }
        byRef.add(it.ref); return true;
      }).map(it => existing.get(it.gmailId) || it)
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      localStorage.setItem(LS_LAST, String(Date.now()));
      localStorage.setItem(LS_STATS, JSON.stringify({ unreadable }));
    } catch (e) {
      console.warn('[email-import] check failed', e);
      lastError = (e.status === 401 || e.status === 403)
        ? 'Gmail access was refused — reconnect Gmail below'
        : 'Could not check Gmail: ' + e.message;
    } finally {
      checking = false;
      renderPage();
    }
    maybeShowPopup();
  }

  // Never stack on top of the recurring popup; wait for it to close.
  function maybeShowPopup(attempt = 0) {
    clearTimeout(popupWaitTimer);
    if (!pending.length) return;
    const rp = document.getElementById('recurringPrompt');
    if (rp && rp.classList.contains('open') && attempt < 40) {
      popupWaitTimer = setTimeout(() => maybeShowPopup(attempt + 1), 1500);
      return;
    }
    renderPopup();
    document.getElementById('emailImportPrompt').classList.add('open');
  }

  // ── review popup ──────────────────────────────────────────
  function renderPopup() {
    const n = pending.length;
    document.getElementById('emailImportSubtitle').textContent =
      `${n} new transaction${n !== 1 ? 's' : ''} found in your bank emails. Tap one to edit.`;
    document.getElementById('emailImportList').innerHTML = pending.map((it, i) => {
      const ok = isComplete(it);
      const income = it.direction === 'income';
      const missing = !it.cat ? 'Pick category' : (!it.pm ? 'Pick payment method' : (!(it.amount > 0) ? 'Enter amount' : ''));
      return `<div class="recurring-prompt-item" ${ok ? '' : 'style="border-left:2px solid #ff9500;padding-left:8px"'}>
        <input class="recurring-prompt-check" type="checkbox" data-eidx="${i}" ${it.checked && ok ? 'checked' : ''} ${ok ? '' : 'disabled'} onchange="EmailImport.onCheck(${i}, this.checked)">
        <div class="recurring-prompt-info" onclick="EmailImport.openEdit(${i})" style="cursor:pointer">
          <div class="recurring-prompt-tx">${esc(it.tx)}</div>
          <div class="recurring-prompt-meta">${missing ? `<span style="color:#ff9500">${esc(missing)}</span>` : esc(it.cat)} · ${esc(it.pm || '—')} · ${esc(isoDisp(it.date))}</div>
        </div>
        <div class="recurring-prompt-amt" style="color:${income ? 'var(--green)' : 'var(--text)'}">${it.amount > 0 ? (income ? '+' : '-') + fRp(it.amount) : (it.foreign ? esc(it.foreign) : '—')}</div>
      </div>`;
    }).join('');
    updateAddBtn();
  }

  function updateAddBtn() {
    const n = pending.filter(it => it.checked && isComplete(it)).length;
    const btn = document.getElementById('emailImportAddBtn');
    btn.textContent = n ? `Add ${n} Transaction${n !== 1 ? 's' : ''}` : 'Nothing selected';
    btn.disabled = !n;
    btn.style.opacity = n ? '1' : '0.4';
  }

  function onCheck(i, v) { if (pending[i]) pending[i].checked = !!v; updateAddBtn(); }

  function closePopup() {   // "Later": nothing is marked handled, items come back next check
    document.getElementById('emailImportPrompt').classList.remove('open');
  }

  function skipAll() {
    markSeen(...pending.flatMap(it => ['g:' + it.gmailId, it.ref && 'r:' + it.ref]));
    pending = [];
    closePopup();
    renderPage();
    showToast('Skipped', 'success');
  }

  function addSelected() {
    if (isSyncing) return;
    const chosen = pending.filter(it => it.checked && isComplete(it));
    if (!chosen.length) return;
    isSyncing = true;
    const btn = document.getElementById('emailImportAddBtn');
    btn.disabled = true;
    const promises = chosen.map(it => _addAndSyncRecurringRule({
      _date: it.date, tx: it.tx, amount: it.amount, cat: it.cat, pm: it.pm, notes: it.notes,
      type: it.direction === 'income' ? 'income' : 'expense',
    }));
    markSeen(...chosen.flatMap(it => ['g:' + it.gmailId, it.ref && 'r:' + it.ref]));
    const done = new Set(chosen);
    pending = pending.filter(it => !done.has(it));
    saveLocal(); updateStatus();
    const n = chosen.length;
    showToast(`${n} transaction${n !== 1 ? 's' : ''} added ✓`, 'success');
    if (pending.length) { renderPopup(); } else { closePopup(); }
    renderPage();
    Promise.all(promises).then(() => {
      isSyncing = false;
      btn.disabled = false;
      calInited = false;
      if (document.getElementById('page-home').classList.contains('active')) initCalendar();
      fetchCurrentMonth(true).then(() => {
        calInited = false;
        if (document.getElementById('page-home').classList.contains('active')) initCalendar();
      });
    });
  }

  // ── edit one suggested transaction ────────────────────────
  function optionsHtml(list, selected, placeholder) {
    return `<option value="">${esc(placeholder)}</option>` +
      list.map(v => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(v)}</option>`).join('');
  }

  // Suggested "match text": first word if it is distinctive enough, else the first two.
  function suggestPattern(merchant) {
    const words = String(merchant || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    return (words[0].length >= 5 || words.length === 1) ? words[0] : words.slice(0, 2).join(' ');
  }

  function openEdit(i) {
    const it = pending[i];
    if (!it) return;
    editIdx = i;
    document.getElementById('emailEditSubtitle').textContent =
      `From email: ${it.merchant || it.typeLabel} · ${it.typeLabel} · ${isoDisp(it.date)}`;
    document.getElementById('emailEditTx').value = it.tx;
    document.getElementById('emailEditCat').innerHTML = optionsHtml(allCategories, it.cat, 'Pick a category');
    document.getElementById('emailEditPm').innerHTML = optionsHtml(allPMs, it.pm, 'Pick a payment method');
    document.getElementById('emailEditAmount').value = it.amount > 0 ? String(it.amount) : '';
    document.getElementById('emailEditAmount').placeholder = it.foreign ? `${it.foreign} → enter Rp` : '0';
    document.getElementById('emailEditDate').value = it.date || '';
    const remember = document.getElementById('emailEditRemember');
    remember.checked = true;
    document.getElementById('emailEditPattern').value = suggestPattern(it.merchant);
    document.getElementById('emailEditRememberHint').textContent = it.sourceKey
      ? `Also links ${it.sourceKey} to the payment method above.` : '';
    onRememberToggle();
    document.getElementById('emailEditModal').classList.add('open');
  }

  function onRememberToggle() {
    const on = document.getElementById('emailEditRemember').checked;
    document.getElementById('emailEditPatternWrap').style.display = on ? 'block' : 'none';
  }

  function closeEdit() { document.getElementById('emailEditModal').classList.remove('open'); editIdx = -1; }

  function parseAmountInput(v) {
    const digits = String(v || '').replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
  }

  function saveEdit() {
    const it = pending[editIdx];
    if (!it) { closeEdit(); return; }
    const tx = document.getElementById('emailEditTx').value.trim();
    const cat = document.getElementById('emailEditCat').value;
    const pm = document.getElementById('emailEditPm').value;
    const amount = parseAmountInput(document.getElementById('emailEditAmount').value);
    const date = document.getElementById('emailEditDate').value;
    if (!tx) { showToast('Enter a transaction name', 'error'); return; }
    if (!cat) { showToast('Pick a category', 'error'); return; }
    if (!pm) { showToast('Pick a payment method', 'error'); return; }
    if (!(amount > 0)) { showToast('Enter an amount', 'error'); return; }
    if (!date) { showToast('Pick a date', 'error'); return; }
    Object.assign(it, { tx, cat, pm, amount, date });
    it.checked = true;
    if (document.getElementById('emailEditRemember').checked) {
      const pattern = document.getElementById('emailEditPattern').value.trim();
      // Only carry the name into the rule if the user actually changed it — otherwise a broad
      // match text like "WARUNG" would rename every merchant containing it.
      if (pattern) upsertRule({ mode: 'contains', pattern, tx: tx === it.defaultTx ? '' : tx, cat });
      if (it.sourceKey && !config.accounts.some(a => a.key.replace(/x/gi, '*') === it.sourceKey)) {
        config.accounts.push({ key: it.sourceKey, pm });
      }
      save();
      reapplyToPending(it);
    }
    closeEdit();
    renderPopup();
    renderPage();
  }

  // After a rule/account is remembered, fill the same gaps in the other rows still waiting —
  // only blanks, never overwriting something the user already chose.
  function reapplyToPending(except) {
    pending.forEach(o => {
      if (o === except) return;
      if (!o.pm) {
        const pm = findAccountPm(o.sourceKey);
        if (pm && allPMs.includes(pm)) o.pm = pm;
      }
      if (!o.cat) {
        const rule = config.rules.find(r => ruleMatches(r, o.merchant));
        if (rule && allCategories.includes(rule.cat)) {
          o.cat = rule.cat;
          if (rule.tx) o.tx = rule.tx;
        }
      }
      if (isComplete(o)) o.checked = true;
    });
  }

  function upsertRule(rule) {
    const idx = config.rules.findIndex(r => norm(r.pattern) === norm(rule.pattern) && r.mode === rule.mode);
    if (idx >= 0) config.rules[idx] = rule; else config.rules.push(rule);
  }

  // ── Settings page ─────────────────────────────────────────
  function fmtAgo(ms) {
    if (!ms) return 'never';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
  }

  const MODE_LABEL = { contains: 'contains', equals: 'equals', starts: 'starts with' };

  function renderPage() {
    const el = document.getElementById('emailImportContainer');
    if (!el) return;
    const on = isEnabled();
    const gm = Auth.hasGmailScope();
    const last = Number(localStorage.getItem(LS_LAST) || 0);
    const unreadable = Number((JSON.parse(localStorage.getItem(LS_STATS) || '{}')).unreadable || 0);
    let h = `<div class="account-info-card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div style="font-size:15px;font-weight:600">Import from bank emails</div>
        <label class="toggle-switch"><input type="checkbox" ${on ? 'checked' : ''} onchange="EmailImport.onToggle(this)"><span class="toggle-slider"></span></label>
      </div>
      <p style="font-size:12px;color:var(--text2);line-height:1.5;margin-top:8px">When you open Nota, it looks for new bank emails (BCA transaction journal, credit card notices, incoming BI-FAST) in your Gmail and shows them in a popup. Nothing is recorded until you confirm. Emails are read on this device only (read-only access).</p>
    </div>`;

    if (!on) {
      h += `<p style="font-size:12px;color:var(--text3);text-align:center;padding:8px 12px 24px;line-height:1.5">Turning this on asks Google for permission to read your Gmail. You can switch it off any time.</p>`;
      el.innerHTML = h; return;
    }

    h += `<div class="account-info-card">
      <div class="account-info-row"><span class="account-info-label">Gmail</span><span style="color:${gm ? 'var(--green)' : '#ff9500'}">${gm ? 'Connected' : (Auth.hasValidToken() ? 'Not connected' : 'Waiting for sign-in…')}</span></div>
      <div class="account-info-row"><span class="account-info-label">Last check</span><span>${checking ? 'checking…' : esc(fmtAgo(last))}</span></div>
      <div class="account-info-row"><span class="account-info-label">Waiting for review</span><span>${pending.length}</span></div>
      ${unreadable ? `<div class="account-info-row"><span class="account-info-label">Skipped (not a transaction)</span><span>${unreadable}</span></div>` : ''}
      ${lastError ? `<p style="font-size:12px;color:var(--red);margin-top:8px;line-height:1.4">${esc(lastError)}</p>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        ${gm ? '' : `<button class="submit-btn expense" style="margin-top:0;flex:1" onclick="EmailImport.connect()">Connect Gmail</button>`}
        <button class="submit-btn" style="margin-top:0;flex:1;background:var(--bg3);color:var(--text)" onclick="EmailImport.checkNow()" ${gm && !checking ? '' : 'disabled'}>Check now</button>
      </div>
      ${pending.length ? `<button class="submit-btn expense" style="margin-top:8px" onclick="EmailImport.reopenPopup()">Review ${pending.length} transaction${pending.length !== 1 ? 's' : ''}</button>` : ''}
    </div>
    <p style="font-size:12px;color:var(--text2);line-height:1.5;margin:-6px 4px 14px">Bank emails in another Gmail address? In that Gmail, add a filter that auto-forwards them to this account (Gmail → Settings → Forwarding and POP/IMAP, then Filters).</p>`;

    // Email types
    h += `<div class="config-section-hdr" style="display:flex;justify-content:space-between;align-items:center;margin:18px 0 8px"><span class="form-label" style="margin:0">Email types</span></div>`;
    EmailParser.TYPES.forEach(t => {
      const act = typeAction(t.id);
      h += `<div class="config-row" style="cursor:default">
        <div class="config-row-name">${esc(t.label)}</div>
        <div class="pill-toggle" style="display:flex;gap:4px">
          <span class="smart-pill ${act === 'ask' ? 'selected' : ''}" onclick="EmailImport.setType('${t.id}','ask')">Ask me</span>
          <span class="smart-pill ${act === 'ignore' ? 'selected' : ''}" onclick="EmailImport.setType('${t.id}','ignore')">Ignore</span>
        </div></div>`;
    });
    h += `<p style="font-size:11px;color:var(--text2);margin:4px 4px 0;line-height:1.4">Credit card bill payments are ignored by default: they move money to your card and are not an expense.</p>`;

    // Accounts
    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 8px"><span class="form-label" style="margin:0">Account &amp; card → payment method</span><button class="config-add-btn" onclick="EmailImport.openAcct(-1)">+ Add</button></div>`;
    h += config.accounts.length ? config.accounts.map((a, i) => `<div class="config-row" onclick="EmailImport.openAcct(${i})">
      <div><div class="config-row-name">${esc(a.key)}</div></div><span class="config-row-meta">${esc(a.pm)} ›</span></div>`).join('')
      : `<p style="font-size:12px;color:var(--text3);padding:4px 4px 0">None yet. They are added when you confirm a transaction with "Remember" on.</p>`;

    // Rules
    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 8px"><span class="form-label" style="margin:0">Merchant rules</span><button class="config-add-btn" onclick="EmailImport.openRule(-1)">+ Add</button></div>`;
    h += config.rules.length ? config.rules.map((r, i) => `<div class="config-row" onclick="EmailImport.openRule(${i})">
      <div><div class="config-row-name">${esc(r.pattern)}</div><div class="config-row-meta">${esc(MODE_LABEL[r.mode])}${r.tx ? ' → ' + esc(r.tx) : ''} · ${esc(r.cat || 'no category')}</div></div><span class="config-row-meta">›</span></div>`).join('')
      : `<p style="font-size:12px;color:var(--text3);padding:4px 4px 0">None yet. Fix a transaction in the popup with "Remember" on and it appears here.</p>`;
    h += `<div style="height:24px"></div>`;
    el.innerHTML = h;
  }

  function setType(id, action) { config.types[id] = action; save(); renderPage(); }

  async function onToggle(input) {
    if (input.checked) {
      input.disabled = true;
      try {
        await Auth.enableGmail();
        showToast('Gmail connected ✓', 'success');
        renderPage();
        loadFromServer().then(() => check({ force: true }));
      } catch (e) {
        console.warn('[email-import] enable failed', e);
        input.checked = false;
        showToast('Gmail was not connected', 'error');
      } finally { input.disabled = false; renderPage(); }
    } else {
      Auth.disableGmail();
      pending = [];
      closePopup();
      renderPage();
      showToast('Email import turned off', 'success');
    }
  }

  async function connect() {
    try { await Auth.enableGmail(); showToast('Gmail connected ✓', 'success'); renderPage(); check({ force: true }); }
    catch (e) { showToast('Gmail was not connected', 'error'); renderPage(); }
  }

  function checkNow() { check({ force: true }); }
  function reopenPopup() { maybeShowPopup(); }

  // rule editor
  function openRule(i) {
    editRuleIdx = i;
    const r = i >= 0 ? config.rules[i] : { mode: 'contains', pattern: '', tx: '', cat: '' };
    document.getElementById('emailRuleTitle').textContent = i >= 0 ? 'Edit rule' : 'New rule';
    document.getElementById('emailRuleMode').value = r.mode;
    document.getElementById('emailRulePattern').value = r.pattern;
    document.getElementById('emailRuleTx').value = r.tx;
    document.getElementById('emailRuleCat').innerHTML = optionsHtml(allCategories, r.cat, 'Pick a category');
    document.getElementById('emailRuleDeleteBtn').style.display = i >= 0 ? '' : 'none';
    document.getElementById('emailRuleModal').classList.add('open');
  }
  function closeRule() { document.getElementById('emailRuleModal').classList.remove('open'); editRuleIdx = -1; }
  function saveRule() {
    const pattern = document.getElementById('emailRulePattern').value.trim();
    const cat = document.getElementById('emailRuleCat').value;
    if (!pattern) { showToast('Enter the merchant text to match', 'error'); return; }
    if (!cat) { showToast('Pick a category', 'error'); return; }
    const rule = { mode: document.getElementById('emailRuleMode').value, pattern, tx: document.getElementById('emailRuleTx').value.trim(), cat };
    if (editRuleIdx >= 0) config.rules[editRuleIdx] = rule; else config.rules.push(rule);
    save(); closeRule(); renderPage();
  }
  function deleteRule() {
    if (editRuleIdx >= 0) config.rules.splice(editRuleIdx, 1);
    save(); closeRule(); renderPage();
  }

  // account mapping editor
  function openAcct(i) {
    editAcctIdx = i;
    const a = i >= 0 ? config.accounts[i] : { key: '', pm: '' };
    document.getElementById('emailAcctKey').value = a.key;
    document.getElementById('emailAcctPm').innerHTML = optionsHtml(allPMs, a.pm, 'Pick a payment method');
    document.getElementById('emailAcctDeleteBtn').style.display = i >= 0 ? '' : 'none';
    document.getElementById('emailAcctModal').classList.add('open');
  }
  function closeAcct() { document.getElementById('emailAcctModal').classList.remove('open'); editAcctIdx = -1; }
  function saveAcct() {
    const key = EmailParser.sourceKey(document.getElementById('emailAcctKey').value) || document.getElementById('emailAcctKey').value.replace(/\s/g, '');
    const pm = document.getElementById('emailAcctPm').value;
    if (!key) { showToast('Enter the account or card number as shown in the email', 'error'); return; }
    if (!pm) { showToast('Pick a payment method', 'error'); return; }
    if (editAcctIdx >= 0) config.accounts[editAcctIdx] = { key, pm }; else config.accounts.push({ key, pm });
    save(); closeAcct(); renderPage();
  }
  function deleteAcct() {
    if (editAcctIdx >= 0) config.accounts.splice(editAcctIdx, 1);
    save(); closeAcct(); renderPage();
  }

  // Called when the Email Import page opens.
  function onPageOpen() {
    renderPage();
    loadFromServer().then(renderPage);
  }

  function init() {
    loadLocal();
    if (!isEnabled()) return;
    window.addEventListener('notaTokenObtained', () => setTimeout(() => check(), 1500));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') setTimeout(() => check(), 1000);
    });
    if (Auth.hasValidToken()) setTimeout(() => check(), 3000);
  }

  // Test hooks (used by the dev-only mock in tests; harmless in production).
  const _internals = {
    get config() { return config; }, get pending() { return pending; }, get seen() { return seen; },
    setPending(p) { pending = p; }, buildItem, messageBody, ruleMatches, findAccountPm, isComplete, suggestPattern,
  };

  return {
    init, check, onToggle, connect, checkNow, reopenPopup, onPageOpen, renderPage,
    onCheck, closePopup, skipAll, addSelected, openEdit, closeEdit, saveEdit, onRememberToggle,
    setType, openRule, closeRule, saveRule, deleteRule, openAcct, closeAcct, saveAcct, deleteAcct,
    _internals,
  };
})();

// Run after the DOM and the other scripts above are in place.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => EmailImport.init());
else EmailImport.init();
