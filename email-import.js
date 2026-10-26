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
  const LS_UNREADABLE = 'notapub_email_import_unreadable'; // latest email the parser could not read (digits masked)
  const LS_RESCUED = 'notapub_email_import_rescued';  // parser version the one-time re-read already ran for
  const LS_ACCOUNT = 'notapub_email_import_account';  // Gmail address this app reads (the signed-in account)
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const MIN_INTERVAL_MS = 5 * 60 * 1000;
  const FIRST_RUN_DAYS = 7;
  const MAX_SEEN = 600;
  const MAX_FETCH = 60;

  // Only these exact senders are listed (forwarded copies keep the original From). They are tied
  // to the templates email-parser.js understands, so they are fixed here rather than a setting;
  // add a sender here together with its parser.
  const SENDERS = ['bca@bca.co.id', 'kartukreditbca@bca.co.id', 'BIFAST.NOREPLY@cimbniaga.co.id', 'mcm@bankmandiri.co.id'];
  // Subjects are a second net: a sender address can differ from what we expect (e.g. a different
  // BCA mailbox name), and the parser only accepts known templates anyway.
  const SUBJECTS = ['Internet Transaction Journal', 'Credit Card Transaction Notification', 'Incoming BI FAST', 'BI FAST Transfer'];
  const QUERY_BASE = `(from:(${SENDERS.join(' OR ')}) OR subject:(${SUBJECTS.map(s => `"${s}"`).join(' OR ')}))`;

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

  // The same incoming transfer can be reported by two banks (the sender's Mandiri notice and
  // the receiving CIMB notice), with no shared reference number. For BI-FAST only, treat
  // same day + amount + receiving account as one payment. Not applied to other types: two
  // identical purchases on one day (e.g. two 50,000 Flazz top-ups) are normal.
  function signature(it) {
    return it.typeId === 'bifast' && it.amount > 0 && it.sourceKey
      ? `s:${it.date}|${it.amount}|${it.sourceKey}|${it.direction}` : '';
  }
  function seenKeys(it) { return ['g:' + it.gmailId, it.ref && 'r:' + it.ref, signature(it)]; }

  // A card bill payment moves money between two of the user's own accounts: it is recorded as a
  // Transfer (From = `pm`, To = `toPm`), not as an expense with a category.
  function isTransfer(it) { return it.direction === 'transfer'; }

  function isComplete(it) {
    if (isTransfer(it)) return !!(it.pm && it.toPm && it.pm !== it.toPm && it.amount > 0 && it.date);
    return !!(it.tx && it.cat && it.pm && it.amount > 0 && it.date);
  }

  function buildItem(parsed, gmailId) {
    const rule = parsed.direction === 'transfer' ? null : config.rules.find(r => ruleMatches(r, parsed.merchant));
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
      targetKey: parsed.targetKey || '',
      toPm: pmValid(findAccountPm(parsed.targetKey)) ? findAccountPm(parsed.targetKey) : '',
      checked: false,
    };
    it.checked = isComplete(it);
    return it;
  }

  // ── emails the parser could not read ──────────────────────
  // Marked per parser version (not forever), so improving the parser re-reads them.
  function unrKey(id) { return `u${EmailParser.VERSION}:${id}`; }

  function maskDigits(s) {
    return String(s || '').replace(/\d{6,}/g, m => m.slice(0, 3) + '…' + m.slice(-2));
  }

  function headerOf(msg, name) {
    const h = ((msg.payload && msg.payload.headers) || []).find(x => String(x.name).toLowerCase() === name);
    return h ? h.value : '';
  }

  // Keeps the latest unreadable email (digits masked, stays on this device) so the user can copy
  // it into a bug report from the Email Import page.
  function rememberUnreadable(msg, body) {
    try {
      const text = /<\s*(html|body|table|div|br|td|p)\b/i.test(body) ? EmailParser.htmlToText(body) : String(body || '');
      localStorage.setItem(LS_UNREADABLE, JSON.stringify({
        from: headerOf(msg, 'from'), subject: headerOf(msg, 'subject'),
        date: localISO(Number(msg.internalDate) || Date.now()), text: maskDigits(text).slice(0, 3000),
      }));
    } catch (e) { /* diagnostics only */ }
  }

  async function copyUnreadable() {
    let info = null;
    try { info = JSON.parse(localStorage.getItem(LS_UNREADABLE) || 'null'); } catch (e) {}
    if (!info) { showToast('No skipped email to copy', 'error'); return; }
    const out = `From: ${info.from}\nSubject: ${info.subject}\nDate: ${info.date}\n\n${info.text}`;
    try { await navigator.clipboard.writeText(out); showToast('Copied (long numbers masked)', 'success'); }
    catch (e) { showToast('Could not copy', 'error'); }
  }

  // Live diagnostic for "why isn't email X showing?": re-runs the search and, for every message
  // Gmail returns, shows sender / subject / date and what Nota did with it. Reads headers only (no
  // email bodies), masks long digit runs, and copies to the clipboard — nothing is sent anywhere.
  async function copyReport() {
    if (!Auth.hasGmailScope()) { showToast('Connect Gmail first', 'error'); return; }
    showToast('Building report…', 'loading', 0);
    const lines = [];
    try {
      const profile = await gmailFetch('/profile');
      const days = 14;
      const q = `${QUERY_BASE} newer_than:${days}d`;
      lines.push(`Nota ${typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?'} · parser v${EmailParser.VERSION}`);
      lines.push(`Gmail account Nota reads: ${profile.emailAddress}`);
      lines.push(`Query: ${q}`);
      lines.push(`Types: ${EmailParser.TYPES.map(t => `${t.id}=${typeAction(t.id)}`).join(', ')}`);
      lines.push(`Seen entries: g=${seen.filter(s => s[0] === 'g').length} i=${seen.filter(s => s[0] === 'i').length} u=${seen.filter(s => s[0] === 'u').length} r=${seen.filter(s => s[0] === 'r').length} s=${seen.filter(s => s[0] === 's').length}; waiting=${pending.length}`);
      const list = await gmailFetch('/messages?maxResults=100&q=' + encodeURIComponent(q));
      const ids = (list.messages || []).map(m => m.id);
      lines.push(`Gmail returned ${ids.length} message(s):`);
      const pendingIds = new Set(pending.map(p => p.gmailId));
      const rows = new Array(ids.length);
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const i = next++;
          const id = ids[i];
          let msg = null;
          try { msg = await gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`); } catch (e) { /* keep going */ }
          const outcome = pendingIds.has(id) ? 'WAITING in popup'
            : seenSet.has('g:' + id) ? 'handled (g)' : seenSet.has('i:' + id) ? 'ignored by type (i)'
            : seenSet.has(unrKey(id)) ? 'could not read (u)' : 'NEW - not yet processed';
          rows[i] = `${i + 1}. ${msg ? maskDigits(headerOf(msg, 'from')) : '?'} | ${msg ? maskDigits(headerOf(msg, 'subject')) : '?'} | ${msg ? headerOf(msg, 'date') : '?'} | ${outcome}`;
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      lines.push(...rows);
    } catch (e) {
      lines.push('Report failed: ' + e.message);
    }
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); showToast('Report copied — paste it to Claude', 'success'); }
    catch (e) { window.prompt('Copy this report:', text); }
  }

  // One-time per parser version: emails that an OLDER parser filed as "not a transaction" were
  // recorded as handled forever. Re-read the most recent handled ones, and release any that the
  // current parser understands but that were never actually added/skipped by the user (those
  // leave a reference/signature behind; refless ones can't be told apart, so they may reappear
  // once and can simply be skipped).
  async function rescueMisread() {
    if (localStorage.getItem(LS_RESCUED) === String(EmailParser.VERSION)) return;
    const ids = seen.filter(s => s.startsWith('g:')).slice(-MAX_FETCH).map(s => s.slice(2));
    const release = [];
    for (const id of ids) {
      let msg;
      try { msg = await gmailFetch(`/messages/${id}?format=full`); }
      catch (e) { if (e.status === 401 || e.status === 403) throw e; continue; }
      const parsed = EmailParser.parse(messageBody(msg), localISO(Number(msg.internalDate) || Date.now()), headerOf(msg, 'subject'));
      if (!parsed) continue;
      // Card bill payments were silently ignored (and their reference marked handled) before they
      // became transfers, and could not have been added by the user — always release those.
      const handled = parsed.typeId !== 'ccbill' && ((parsed.ref && seenSet.has('r:' + parsed.ref))
        || (parsed.typeId === 'bifast' && seenSet.has(`s:${parsed.date}|${parsed.amount}|${parsed.sourceKey}|${parsed.direction}`)));
      if (!handled) { release.push('g:' + id); if (parsed.typeId === 'ccbill' && parsed.ref) release.push('r:' + parsed.ref); }
    }
    if (release.length) {
      const drop = new Set(release);
      seen = seen.filter(s => !drop.has(s));
      seenSet = new Set(seen);
      save();
    }
    localStorage.setItem(LS_STATS, JSON.stringify({ unreadable: 0 }));
    localStorage.setItem(LS_RESCUED, String(EmailParser.VERSION));
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
      if (!localStorage.getItem(LS_ACCOUNT)) {
        try { localStorage.setItem(LS_ACCOUNT, (await gmailFetch('/profile')).emailAddress || ''); } catch (e) { /* shown next time */ }
      }
      const days = opts.days || (last ? Math.min(35, Math.max(3, Math.ceil((Date.now() - last) / 86400000) + 2)) : FIRST_RUN_DAYS);
      await rescueMisread();
      const list = await gmailFetch('/messages?maxResults=100&q=' + encodeURIComponent(`${QUERY_BASE} newer_than:${days}d`));
      const ids = (list.messages || []).map(m => m.id)
        .filter(id => !seenSet.has('g:' + id) && !seenSet.has('i:' + id) && !seenSet.has(unrKey(id))).slice(0, MAX_FETCH);
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
          const parsed = EmailParser.parse(body, localISO(Number(msg.internalDate) || Date.now()), headerOf(msg, 'subject'));
          if (!parsed) { markSeen(unrKey(id)); unreadable++; rememberUnreadable(msg, body); continue; }
          if (parsed.status === 'failed') { markSeen('g:' + id, parsed.ref && 'r:' + parsed.ref); continue; }
          // Ignored by the user's own setting: remembered separately (`i:`) so that switching the type
          // back to "Ask me" brings these emails back (setType() clears every `i:` entry).
          if (typeAction(parsed.typeId) === 'ignore') { markSeen('i:' + id); continue; }
          if (parsed.ref && seenSet.has('r:' + parsed.ref)) { markSeen('g:' + id); continue; }
          found.push(buildItem(parsed, id));
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      // Same transaction mailed twice (e.g. forwarded copy + original): keep one.
      const byRef = new Set();
      const bySig = new Map();   // signature -> item kept for this batch
      const existing = new Map(pending.map(it => [it.gmailId, it]));
      // Reuse an item already in the list (same email) so edits the user has made are kept.
      pending = found.filter(it => {
        const sig = signature(it);
        if (sig && seenSet.has(sig)) { markSeen('g:' + it.gmailId); return false; }   // already handled via the other bank's email
        if (it.ref) {
          if (byRef.has(it.ref)) { markSeen('g:' + it.gmailId); return false; }
          byRef.add(it.ref);
        }
        if (sig) {
          const kept = bySig.get(sig);
          if (kept) {   // two emails, one payment: keep whichever carries the sender's note
            if (!kept.notes && it.notes) kept.notes = it.notes;
            // Not marked seen yet: until the payment is added/skipped, re-reading this copy next
            // check is what lets its note reach the kept row again. The signature check above
            // retires it once the payment is handled.
            return false;
          }
          bySig.set(sig, it);
        }
        return true;
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
      const xfer = isTransfer(it);
      const orange = t => `<span style="color:#ff9500">${esc(t)}</span>`;
      let meta;
      if (xfer) {
        const from = it.pm ? esc(it.pm) : orange('Pick "from"');
        const to = it.toPm ? esc(it.toPm) : orange('Pick card');
        meta = `${from} → ${to} · ${esc(isoDisp(it.date))}`;
      } else {
        const missing = !it.cat ? 'Pick category' : (!it.pm ? 'Pick payment method' : (!(it.amount > 0) ? 'Enter amount' : ''));
        meta = `${missing ? orange(missing) : esc(it.cat)} · ${esc(it.pm || '—')} · ${esc(isoDisp(it.date))}`;
      }
      const amt = it.amount > 0 ? (xfer ? '' : (income ? '+' : '-')) + fRp(it.amount) : (it.foreign ? esc(it.foreign) : '—');
      return `<div class="recurring-prompt-item" ${ok ? '' : 'style="border-left:2px solid #ff9500;padding-left:8px"'}>
        <input class="recurring-prompt-check" type="checkbox" data-eidx="${i}" ${it.checked && ok ? 'checked' : ''} ${ok ? '' : 'disabled'} onchange="EmailImport.onCheck(${i}, this.checked)">
        <div class="recurring-prompt-info" onclick="EmailImport.openEdit(${i})" style="cursor:pointer">
          <div class="recurring-prompt-tx">${xfer ? '🔁 Transfer · ' : ''}${esc(it.tx)}</div>
          <div class="recurring-prompt-meta">${meta}</div>
        </div>
        <div class="recurring-prompt-amt" style="color:${xfer ? '#a78bfa' : (income ? 'var(--green)' : 'var(--text)')}">${amt}</div>
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
    markSeen(...pending.flatMap(seenKeys));
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
    const promises = chosen.map(it => isTransfer(it)
      ? addAndSyncTransfer(it)
      : _addAndSyncRecurringRule({
        _date: it.date, tx: it.tx, amount: it.amount, cat: it.cat, pm: it.pm, notes: it.notes,
        type: it.direction === 'income' ? 'income' : 'expense',
      }));
    markSeen(...chosen.flatMap(seenKeys));
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

  // Same local-first path as submitTransfer() (index.html): optimistic row + queue, then
  // syncTransfer() writes both legs; a failed sync stays in the queue for retryPendingQueue().
  function addAndSyncTransfer(it) {
    const r = { id: Date.now() + Math.random(), date: it.date, fromPm: it.pm, toPm: it.toPm, amount: it.amount,
      notes: it.notes || '', tx: 'Transfer', type: 'transfer', synced: false, nativeAmount: 0, ccy: '' };
    txHistory.unshift(r);
    queue.push({ ...r });
    saveLocal(); updateStatus();
    buildAccountBalances();
    renderAccountBalanceCards();
    return syncTransfer(r).then(ok => {
      if (!ok) return;
      r.synced = true;
      queue = queue.filter(q => q.id !== r.id);
      saveLocal(); updateStatus();
      return loadHistData().then(() => { buildAccountBalances(); renderAccountBalanceCards(); }).catch(() => {});
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
    const xfer = isTransfer(it);
    // A transfer has no name/category, and "payment method" becomes From + To.
    document.getElementById('emailEditTxWrap').style.display = xfer ? 'none' : '';
    document.getElementById('emailEditCatWrap').style.display = xfer ? 'none' : '';
    document.getElementById('emailEditToWrap').style.display = xfer ? '' : 'none';
    document.getElementById('emailEditPmLabel').textContent = xfer ? 'From' : 'Payment Method';
    document.getElementById('emailEditToPm').innerHTML = optionsHtml(allPMs, it.toPm, 'Pick the card / account');
    document.querySelector('#emailEditModal .modal-title').textContent = xfer ? 'Edit transfer' : 'Edit before adding';
    document.getElementById('emailEditTx').value = it.tx;
    document.getElementById('emailEditCat').innerHTML = optionsHtml(allCategories, it.cat, 'Pick a category');
    document.getElementById('emailEditPm').innerHTML = optionsHtml(allPMs, it.pm, xfer ? 'Pick the paying account' : 'Pick a payment method');
    document.getElementById('emailEditAmount').value = it.amount > 0 ? String(it.amount) : '';
    document.getElementById('emailEditAmount').placeholder = it.foreign ? `${it.foreign} → enter Rp` : '0';
    document.getElementById('emailEditDate').value = it.date || '';
    const remember = document.getElementById('emailEditRemember');
    remember.checked = true;
    document.getElementById('emailEditPattern').value = suggestPattern(it.merchant);
    document.getElementById('emailEditRememberHint').textContent = xfer
      ? `Links ${it.sourceKey || 'the paying account'} → From and ${it.targetKey || 'the card'} → To.`
      : (it.sourceKey ? `Also links ${it.sourceKey} to the payment method above.` : '');
    onRememberToggle();
    document.getElementById('emailEditModal').classList.add('open');
  }

  function onRememberToggle() {
    const on = document.getElementById('emailEditRemember').checked;
    const xfer = pending[editIdx] && isTransfer(pending[editIdx]);
    // Transfers have no merchant to match: "remember" only saves the account/card links.
    document.getElementById('emailEditPatternWrap').style.display = on && !xfer ? 'block' : 'none';
  }

  function rememberAccount(key, pm) {
    if (!key || !pm) return;
    const k = key.replace(/x/gi, '*');
    if (!config.accounts.some(a => a.key.replace(/x/gi, '*') === k)) config.accounts.push({ key: k, pm });
  }

  function closeEdit() { document.getElementById('emailEditModal').classList.remove('open'); editIdx = -1; }

  function parseAmountInput(v) {
    const digits = String(v || '').replace(/[^\d]/g, '');
    return digits ? Number(digits) : 0;
  }

  function saveEdit() {
    const it = pending[editIdx];
    if (!it) { closeEdit(); return; }
    if (isTransfer(it)) {
      const from = document.getElementById('emailEditPm').value;
      const to = document.getElementById('emailEditToPm').value;
      const amt = parseAmountInput(document.getElementById('emailEditAmount').value);
      const dt = document.getElementById('emailEditDate').value;
      if (!from) { showToast('Pick the paying account', 'error'); return; }
      if (!to) { showToast('Pick the card / account being paid', 'error'); return; }
      if (from === to) { showToast('From and To must be different', 'error'); return; }
      if (!(amt > 0)) { showToast('Enter an amount', 'error'); return; }
      if (!dt) { showToast('Pick a date', 'error'); return; }
      Object.assign(it, { pm: from, toPm: to, amount: amt, date: dt, checked: true });
      if (document.getElementById('emailEditRemember').checked) {
        rememberAccount(it.sourceKey, from);
        rememberAccount(it.targetKey, to);
        save();
        reapplyToPending(it);
      }
      closeEdit(); renderPopup(); renderPage();
      return;
    }
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
      if (isTransfer(o)) {
        if (!o.toPm) {
          const to = findAccountPm(o.targetKey);
          if (to && allPMs.includes(to)) o.toPm = to;
        }
        if (isComplete(o)) o.checked = true;
        return;
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
      ${localStorage.getItem(LS_ACCOUNT) ? `<div class="account-info-row"><span class="account-info-label">Reading mailbox</span><span style="font-size:13px">${esc(localStorage.getItem(LS_ACCOUNT))}</span></div>` : ''}
      <div class="account-info-row"><span class="account-info-label">Last check</span><span>${checking ? 'checking…' : esc(fmtAgo(last))}</span></div>
      <div class="account-info-row"><span class="account-info-label">Waiting for review</span><span>${pending.length}</span></div>
      ${unreadable ? `<div class="account-info-row"><span class="account-info-label">Skipped (couldn't read)</span><span>${unreadable}</span></div>
        <button class="config-add-btn" style="padding:6px 0 0" onclick="EmailImport.copyUnreadable()">Copy the skipped email (numbers masked)</button>` : ''}
      ${lastError ? `<p style="font-size:12px;color:var(--red);margin-top:8px;line-height:1.4">${esc(lastError)}</p>` : ''}
      <div style="display:flex;gap:8px;margin-top:12px">
        ${gm ? '' : `<button class="submit-btn expense" style="margin-top:0;flex:1" onclick="EmailImport.connect()">Connect Gmail</button>`}
        <button class="submit-btn" style="margin-top:0;flex:1;background:var(--bg3);color:var(--text)" onclick="EmailImport.checkNow()" ${gm && !checking ? '' : 'disabled'}>Check now</button>
      </div>
      ${pending.length ? `<button class="submit-btn expense" style="margin-top:8px" onclick="EmailImport.reopenPopup()">Review ${pending.length} transaction${pending.length !== 1 ? 's' : ''}</button>` : ''}
      ${gm ? `<button class="config-add-btn" style="padding:10px 0 0;color:var(--text2)" onclick="EmailImport.copyReport()">Email not showing? Copy a diagnostic report</button>` : ''}
    </div>
    <p style="font-size:12px;color:var(--text2);line-height:1.5;margin:-6px 4px 14px">Nota only reads <b>${esc(localStorage.getItem(LS_ACCOUNT) || 'the Google account you signed in with')}</b>. Bank emails that arrive in a different Gmail address are not seen until you auto-forward them here (in that Gmail: Settings → Forwarding and POP/IMAP, then Filters).</p>
    ${gm ? `<button class="config-add-btn" style="padding:0 4px 14px;color:var(--text2)" onclick="EmailImport.check({force:true, days:30})">Look back 30 days for older emails</button>` : ''}`;

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
    h += `<p style="font-size:11px;color:var(--text2);margin:4px 4px 0;line-height:1.4">Credit card bill payments are recorded as a transfer from your account to the card, so they are not counted as spending twice. Set to Ignore if you would rather skip them.</p>`;

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

  function setType(id, action) {
    config.types[id] = action;
    // Emails skipped only because their type was set to Ignore become eligible again.
    seen = seen.filter(s => !s.startsWith('i:'));
    seenSet = new Set(seen);
    localStorage.removeItem(LS_LAST);   // next check is a full look, not an incremental one
    save(); renderPage();
  }

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
    copyUnreadable, copyReport, onCheck, closePopup, skipAll, addSelected, openEdit, closeEdit, saveEdit, onRememberToggle,
    setType, openRule, closeRule, saveRule, deleteRule, openAcct, closeAcct, saveAcct, deleteAcct,
    _internals,
  };
})();

// Run after the DOM and the other scripts above are in place.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => EmailImport.init());
else EmailImport.init();
