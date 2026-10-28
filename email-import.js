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

  // Which emails to read is the user's setting: a list of "email types" (config.sources), each a
  // sender + optional subject / keyword and a reader. A new user starts with none and adds them by
  // picking an email (openPick) or scanning the mailbox (openScan). reader 'bank' = the templates in
  // email-parser.js; 'receipt' = the generic amount/merchant reader.
  const READERS = ['bank', 'receipt'];
  const KIND_IDS = ['expense', 'income', 'invest', 'transfer'];
  // Only used to migrate people who already had Email Import before the list became editable (a new
  // user starts with an empty list). One type per kind of bank email; sender + a word inside the
  // email tell them apart, and the last BCA one (no keyword) catches the rest. Order matters.
  function defaultSources() {
    const mk = (id, name, senders, keyword) => ({ id, name, senders, subject: '', keyword: keyword || '', reader: 'bank',
      action: 'ask', kind: '', txMode: 'email', txFixed: '', cat: '', pm: '', amountLabel: '' });
    return [
      mk('bca-qris', 'BCA - QRIS', 'bca@bca.co.id', 'QRIS'),
      mk('bca-flazz', 'BCA - Flazz', 'bca@bca.co.id', 'Flazz'),
      mk('bca-ccpay', 'BCA - CC payment', 'bca@bca.co.id', 'Paylater, Kartu Kredit'),
      mk('bca-other', 'BCA - other bank transaction', 'bca@bca.co.id', ''),
      mk('bca-ccnotice', 'BCA - CC notice', 'kartukreditbca@bca.co.id', ''),
      mk('cimb-bifast', 'CIMB - BI Fast', 'BIFAST.NOREPLY@cimbniaga.co.id', ''),
      mk('mandiri-bifast', 'Mandiri - BI Fast', 'mcm@bankmandiri.co.id', ''),
    ];
  }
  const tokens = s => String(s || '').split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
  const plainText = body => /<\s*(html|body|table|div|br|td|p)\b/i.test(body) ? EmailParser.htmlToText(body) : String(body || '');

  // Gmail search for the user's email types: (from:(a OR b) subject:("x")) OR (...). Sender and
  // subject narrow each other when both are given. The keyword (text inside the email) is checked
  // after fetching. Types set to Ignore are still searched so their emails are recognised and
  // skipped, not handed to a broader type.
  function buildQuery(sources) {
    const all = sources || config.sources;
    if (!all.some(s => s.action !== 'ignore')) return '';
    const parts = all.map(s => {
      const f = tokens(s.senders), j = tokens(s.subject);
      const bits = [];
      if (f.length) bits.push(`from:(${f.join(' OR ')})`);
      if (j.length) bits.push(`subject:(${j.map(x => `"${x.replace(/"/g, '')}"`).join(' OR ')})`);
      return bits.length ? `(${bits.join(' ')})` : '';
    }).filter(Boolean);
    return parts.length ? `(${parts.join(' OR ')})` : '';
  }

  // First source whose sender and subject both match this message (Gmail's own search is looser).
  // First type (in list order) whose sender, subject and keyword all match. `text` is the email
  // body as plain text. Ignored types still match, so they swallow their emails.
  function sourceFor(from, subject, text, sources) {
    const j = String(subject || '').toLowerCase(), b = String(text || '').toLowerCase();
    const addr = String(from || '').toLowerCase().replace(/^.*</, '').replace(/>.*$/, '').trim();
    // A full address must match exactly (bca@bca.co.id is not kartukreditbca@bca.co.id); "@domain"
    // matches the domain; a bare word matches anywhere in the sender.
    const senderOk = t => { t = t.toLowerCase(); return t.includes('@') ? (t.startsWith('@') ? addr.endsWith(t) : addr === t) : String(from || '').toLowerCase().includes(t); };
    return (sources || config.sources).find(s =>
      (tokens(s.senders).length || tokens(s.subject).length || tokens(s.keyword).length)
      && (!tokens(s.senders).length || tokens(s.senders).some(senderOk))
      && (!tokens(s.subject).length || tokens(s.subject).some(t => j.includes(t.toLowerCase())))
      && (!tokens(s.keyword).length || tokens(s.keyword).some(t => b.includes(t.toLowerCase())))) || null;
  }

  // Reads one email with a source's reader. Returns the parsed object or null (unreadable).
  function readWith(src, body, fallbackDate, subject, from) {
    if (src.reader === 'receipt') {
      const p = EmailParser.parseGeneric(body, fallbackDate, { subject, from, name: src.name, amountLabel: src.amountLabel });
      if (p) p.direction = src.kind === 'income' ? 'income' : 'expense';
      return p;
    }
    return EmailParser.parse(body, fallbackDate, subject);
  }

  let config = { types: {}, accounts: [], rules: [], sources: [] };
  let seen = [];                 // newest last
  let seenSet = new Set();
  let dirty = false;
  let pending = [];              // items waiting for the user in the popup
  let checking = false;
  let serverLoaded = false;
  let pushTimer = null;
  let lastError = '';
  let editIdx = -1;              // popup item being edited
  let editKind = 'expense';      // type chosen in the edit sheet
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
    const out = { types: {}, accounts: [], rules: [], sources: [] };
    if (c.types && typeof c.types === 'object') {
      Object.keys(c.types).forEach(k => { if (c.types[k] === 'ask' || c.types[k] === 'ignore') out.types[k] = c.types[k]; });
    }
    const cleanSource = s => ({
      id: String(s.id), name: String(s.name || 'Email type').slice(0, 60),
      senders: String(s.senders || ''), subject: String(s.subject || ''), keyword: String(s.keyword || ''),
      reader: READERS.includes(s.reader) ? s.reader : 'receipt', action: s.action === 'ignore' ? 'ignore' : 'ask',
      kind: KIND_IDS.includes(s.kind) ? s.kind : '', txMode: s.txMode === 'fixed' ? 'fixed' : 'email',
      txFixed: String(s.txFixed || ''), cat: String(s.cat || ''), pm: String(s.pm || ''),
      amountLabel: String(s.amountLabel || ''),
    });
    const list = Array.isArray(c.sources) ? c.sources.filter(s => s && s.id) : null;
    const hadAnything = (c.rules && c.rules.length) || (c.accounts && c.accounts.length) || Object.keys(out.types).length;
    if (list && list.some(s => ['bca-journal', 'bca-card', 'mandiri-cm'].includes(s.id) || (Array.isArray(s.kinds) && s.kinds.length))) {
      // v4.59 shape (4 bank types with the kinds nested inside): split into one type per kind,
      // carrying over each Ask/Ignore choice. Types the user added themselves are kept.
      const old = id => list.find(s => s.id === id) || {};
      const t = out.types;
      const ign = (...flags) => flags.some(f => f === 'ignore');
      const act = { 'bca-qris': ign(old('bca-journal').action, t.qris), 'bca-flazz': ign(old('bca-journal').action, t.flazz),
        'bca-ccpay': ign(old('bca-journal').action, t.ccbill),
        'bca-other': ign(old('bca-journal').action) || (t.other === 'ignore' && t.transfer === 'ignore'),
        'bca-ccnotice': ign(old('bca-card').action) || (t.cc === 'ignore' && t.ccrefund === 'ignore'),
        'cimb-bifast': ign(old('cimb-bifast').action, t.bifast), 'mandiri-bifast': ign(old('mandiri-cm').action, t.bifast) };
      out.sources = defaultSources().map(d => ({ ...d, action: act[d.id] ? 'ignore' : 'ask' }))
        .concat(list.filter(s => !s.builtin).map(cleanSource));
    } else if (list) {
      out.sources = list.map(cleanSource);
    } else if (hadAnything) {
      // Used Email Import before the list was editable: start from the bank types they had.
      out.sources = defaultSources().map(d => ({ ...d, action: 'ask' }));
    }   // else: a new user starts with an empty list
    if (Array.isArray(c.accounts)) {
      out.accounts = c.accounts.filter(a => a && a.key && a.pm).map(a => ({ key: String(a.key), pm: String(a.pm) }));
    }
    if (Array.isArray(c.rules)) {
      out.rules = c.rules.filter(r => r && r.pattern).map(r => ({
        mode: ['contains', 'equals', 'starts'].includes(r.mode) ? r.mode : 'contains',
        pattern: String(r.pattern), tx: String(r.tx || ''), cat: String(r.cat || ''),
        type: ['expense', 'income', 'invest', 'transfer'].includes(r.type) ? r.type : '',
        toPm: String(r.toPm || ''), pm: String(r.pm || ''),
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
  // `it.kind` is what gets recorded (expense | income | invest | transfer). It starts as the
  // parsed direction and the user (or a merchant rule) can change it; `it.direction` stays as
  // parsed so duplicate detection keeps working.
  function isTransfer(it) { return it.kind === 'transfer'; }
  const KINDS = ['expense', 'income', 'invest', 'transfer'];

  function isComplete(it) {
    if (isTransfer(it)) return !!(it.pm && it.toPm && it.pm !== it.toPm && it.amount > 0 && it.date);
    if (it.kind === 'invest') return !!(it.tx && it.pm && it.amount > 0 && it.lot > 0 && it.date);
    return !!(it.tx && it.cat && it.pm && it.amount > 0 && it.date);
  }

  function buildItem(parsed, gmailId, src) {
    const rule = parsed.direction === 'transfer' ? null : config.rules.find(r => ruleMatches(r, parsed.merchant));
    const pmValid = pm => pm && (typeof allPMs === 'undefined' || allPMs.includes(pm));
    const catValid = c => c && (typeof allCategories === 'undefined' || allCategories.includes(c));
    const pm = findAccountPm(parsed.sourceKey);
    // Defaults from the email type apply to everything except a card bill payment (always a transfer).
    const srcDef = src && parsed.direction !== 'transfer' ? src : null;
    const cat = rule ? rule.cat : (srcDef ? srcDef.cat : '');
    const notes = [parsed.notes, parsed.ccy !== 'IDR' && parsed.nativeAmount ? `${parsed.ccy} ${parsed.nativeAmount}` : '']
      .filter(Boolean).join(' · ');
    const it = {
      gmailId, ref: parsed.ref || '', typeId: parsed.typeId, typeLabel: parsed.typeLabel,
      direction: parsed.direction, date: parsed.date, amount: parsed.amount || 0,
      merchant: parsed.merchant, sourceKey: parsed.sourceKey || '',
      defaultTx: parsed.defaultTx || parsed.merchant || parsed.typeLabel,
      tx: (rule && rule.tx) || (srcDef && srcDef.txMode === 'fixed' && srcDef.txFixed) || parsed.defaultTx || parsed.merchant || parsed.typeLabel,
      cat: catValid(cat) ? cat : '',
      pm: pmValid(rule && rule.pm) ? rule.pm : (pmValid(pm) ? pm : (srcDef && pmValid(srcDef.pm) ? srcDef.pm : '')), notes,
      ambiguous: !!parsed.ambiguous, sourceId: src ? src.id : '',
      foreign: parsed.ccy !== 'IDR' ? `${parsed.ccy} ${parsed.nativeAmount}` : '',
      targetKey: parsed.targetKey || '',
      toPm: pmValid(findAccountPm(parsed.targetKey)) ? findAccountPm(parsed.targetKey) : '',
      kind: (rule && KINDS.includes(rule.type)) ? rule.type
        : (srcDef && KINDS.includes(srcDef.kind) ? srcDef.kind : parsed.direction),
      action: parsed.direction === 'income' ? 'Sell' : 'Buy', lot: 1,
      checked: false,
    };
    if (!it.toPm && rule && rule.toPm && pmValid(rule.toPm)) it.toPm = rule.toPm;
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
      const q = `${buildQuery()} newer_than:${days}d`;
      lines.push(`Nota ${typeof APP_VERSION !== 'undefined' ? APP_VERSION : '?'} · parser v${EmailParser.VERSION}`);
      lines.push(`Gmail account Nota reads: ${profile.emailAddress}`);
      lines.push(`Query: ${q}`);
      lines.push(`Email types: ${config.sources.map(s => `${s.name}[${s.reader},${s.action}] from=${s.senders || '-'} subject=${s.subject || '-'} keyword=${s.keyword || '-'}`).join(' ; ')}`);
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
      const base = buildQuery();
      if (!base) { lastError = ''; checking = false; localStorage.setItem(LS_LAST, String(Date.now())); renderPage(); return; }
      const list = await gmailFetch('/messages?maxResults=100&q=' + encodeURIComponent(`${base} newer_than:${days}d`));
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
          const from = headerOf(msg, 'from'), subject = headerOf(msg, 'subject');
          const src = sourceFor(from, subject, plainText(body));
          if (!src) { markSeen('i:' + id); continue; }   // Gmail's search matched loosely; not one of the user's types
          // Ignored by the user's own setting: remembered separately (`i:`) so that switching the type
          // back to "Ask me" brings these emails back (setSourceAction() clears every `i:` entry).
          if (src.action === 'ignore') { markSeen('i:' + id); continue; }
          const day = localISO(Number(msg.internalDate) || Date.now());
          let parsed = readWith(src, body, day, subject, from);
          if (!parsed && src.reader === 'receipt' && pdfParts(msg).length) {
            const withPdf = await bodyWithPdf(msg, body);
            if (withPdf.body !== body) parsed = readWith(src, withPdf.body, day, subject, from);
          }
          if (!parsed) { markSeen(unrKey(id)); unreadable++; rememberUnreadable(msg, body); continue; }
          if (parsed.status === 'failed') { markSeen('g:' + id, parsed.ref && 'r:' + parsed.ref); continue; }
          if (parsed.ref && seenSet.has('r:' + parsed.ref)) { markSeen('g:' + id); continue; }
          found.push(buildItem(parsed, id, src));
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
    // Same day + amount in two emails (e.g. a card ride: the bank notice and the Gojek receipt).
    const dupCount = {};
    pending.forEach(it => { const k = `${it.date}|${it.amount}`; dupCount[k] = (dupCount[k] || 0) + 1; });
    document.getElementById('emailImportList').innerHTML = pending.map((it, i) => {
      const ok = isComplete(it);
      const income = it.kind === 'income';
      const xfer = isTransfer(it);
      const inv = it.kind === 'invest';
      const orange = t => `<span style="color:#ff9500">${esc(t)}</span>`;
      let meta;
      if (inv) {
        meta = `${esc(it.action)} · ${it.pm ? esc(it.pm) : orange('Pick account')} · ${esc(isoDisp(it.date))}`;
      } else if (xfer) {
        const from = it.pm ? esc(it.pm) : orange('Pick "from"');
        const to = it.toPm ? esc(it.toPm) : orange('Pick card');
        meta = `${from} → ${to} · ${esc(isoDisp(it.date))}`;
      } else {
        const missing = !it.cat ? 'Pick category' : (!it.pm ? 'Pick payment method' : (!(it.amount > 0) ? 'Enter amount' : ''));
        meta = `${missing ? orange(missing) : esc(it.cat)} · ${esc(it.pm || '—')} · ${esc(isoDisp(it.date))}`;
      }
      if (it.ambiguous) meta += ' · ' + orange('Check amount');
      if (it.amount > 0 && dupCount[`${it.date}|${it.amount}`] > 1) meta += ' · ' + orange('Possible duplicate');
      const amt = it.amount > 0 ? ((xfer || inv) ? '' : (income ? '+' : '-')) + fRp(it.amount) : (it.foreign ? esc(it.foreign) : '—');
      return `<div class="recurring-prompt-item" ${ok ? '' : 'style="border-left:2px solid #ff9500;padding-left:8px"'}>
        <input class="recurring-prompt-check" type="checkbox" data-eidx="${i}" ${it.checked && ok ? 'checked' : ''} ${ok ? '' : 'disabled'} onchange="EmailImport.onCheck(${i}, this.checked)">
        <div class="recurring-prompt-info" onclick="EmailImport.openEdit(${i})" style="cursor:pointer">
          <div class="recurring-prompt-tx">${xfer ? '🔁 Transfer · ' : (inv ? '📈 Invest · ' : '')}${esc(it.tx)}</div>
          <div class="recurring-prompt-meta">${meta}</div>
        </div>
        <div class="recurring-prompt-amt" style="color:${xfer ? '#a78bfa' : (inv ? 'var(--blue)' : (income ? 'var(--green)' : 'var(--text)'))}">${amt}</div>
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
      : it.kind === 'invest'
        ? addAndSyncInvest(it)
        : _addAndSyncRecurringRule({
          _date: it.date, tx: it.tx, amount: it.amount, cat: it.cat, pm: it.pm, notes: it.notes,
          type: it.kind === 'income' ? 'income' : 'expense',
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

  // Same local-first path as submitInvest() (index.html). The email gives only a total, so
  // price per unit = total / lot; totalIdr is the exact email amount.
  function addAndSyncInvest(it) {
    const lot = it.lot > 0 ? it.lot : 1;
    const r = { id: Date.now() + Math.random(), date: it.date, stock: it.tx, account: it.pm, action: it.action,
      lot, price: it.amount / lot, totalIdr: it.amount, type: 'invest', synced: false };
    investHistory.unshift(r);
    queue.push({ ...r });
    saveLocal(); updateStatus();
    buildAccountBalances();
    renderAccountBalanceCards();
    return syncInvest(r).then(ok => {
      if (!ok) return;
      queue = queue.filter(q => q.id !== r.id);
      investHistory = investHistory.map(h => h.id === r.id ? { ...h, synced: true } : h);
      saveLocal(); updateStatus();
      localStorage.removeItem(curMonthCacheKey());
      return fetchLiveInvest().then(() => buildAccountBalances()).catch(() => {});
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

  // Same model as the main input form: an exact (case-insensitive) match of the transaction name in
  // history gives the category / payment method most used with it.
  function historyDefaults(name) {
    const low = String(name || '').toLowerCase().trim();
    const H = typeof HIST !== 'undefined' ? HIST : {};
    const first = map => { const k = low && Object.keys(map || {}).find(x => x.toLowerCase() === low); return k && map[k].length ? map[k][0] : ''; };
    return { cat: first(H.txCat), pm: first(H.txPm) };
  }

  // onlyBlank: opening the sheet fills empty fields only; typing a name that matches history
  // replaces them, like the main form.
  function autoFillFromHistory(onlyBlank, includeMerchant) {
    if (editKind === 'transfer' || editKind === 'invest') return;
    const it = pending[editIdx];
    const names = [document.getElementById('emailEditTx').value];
    if (includeMerchant && it) names.push(it.merchant);
    const catEl = document.getElementById('emailEditCat'), pmEl = document.getElementById('emailEditPm');
    for (const n of names) {
      const h = historyDefaults(n);
      if (!h.cat && !h.pm) continue;
      if (h.cat && allCategories.includes(h.cat) && (!onlyBlank || !catEl.value)) catEl.value = h.cat;
      if (h.pm && allPMs.includes(h.pm) && (!onlyBlank || !pmEl.value)) pmEl.value = h.pm;
      break;
    }
  }
  function onEditTxInput() { autoFillFromHistory(false, false); }

  function openEdit(i) {
    const it = pending[i];
    if (!it) return;
    editIdx = i;
    document.getElementById('emailEditSubtitle').textContent =
      `From email: ${it.merchant || it.typeLabel} · ${it.typeLabel} · ${isoDisp(it.date)}`;
    editKind = it.kind;
    document.getElementById('emailEditToPm').innerHTML = optionsHtml(allPMs, it.toPm, 'Pick the card / account');
    document.getElementById('emailEditTx').value = it.tx;
    document.getElementById('emailEditCat').innerHTML = optionsHtml(allCategories, it.cat, 'Pick a category');
    document.getElementById('emailEditPm').innerHTML = optionsHtml(allPMs, it.pm, 'Pick a payment method');
    document.getElementById('emailEditAmount').value = it.amount > 0 ? String(it.amount) : '';
    document.getElementById('emailEditAmount').placeholder = it.foreign ? `${it.foreign} → enter Rp` : '0';
    document.getElementById('emailEditDate').value = it.date || '';
    document.getElementById('emailEditAction').value = it.action;
    document.getElementById('emailEditLot').value = it.lot > 0 ? String(it.lot) : '1';
    document.getElementById('emailEditRemember').checked = true;
    document.getElementById('emailEditPattern').value = suggestPattern(it.merchant);
    applyEditKind();
    autoFillFromHistory(true, true);
    document.getElementById('emailEditModal').classList.add('open');
  }

  // Shows the fields that belong to the chosen type. Values already typed are kept.
  function setEditKind(k) {
    if (!KINDS.includes(k) || k === editKind) return;
    // Sell for money-in emails, Buy otherwise — only a default, the user can change it.
    if (k === 'invest') document.getElementById('emailEditAction').value = pending[editIdx]?.direction === 'income' ? 'Sell' : 'Buy';
    editKind = k;
    applyEditKind();
    autoFillFromHistory(true, true);
  }

  function applyEditKind() {
    const it = pending[editIdx];
    const k = editKind, xfer = k === 'transfer', inv = k === 'invest';
    document.querySelectorAll('#emailEditKind [data-kind]').forEach(el => el.classList.toggle('selected', el.dataset.kind === k));
    document.getElementById('emailEditTxWrap').style.display = xfer ? 'none' : '';
    document.getElementById('emailEditTxLabel').textContent = inv ? 'Asset' : 'Transaction';
    document.getElementById('emailEditCatWrap').style.display = (xfer || inv) ? 'none' : '';
    document.getElementById('emailEditToWrap').style.display = xfer ? '' : 'none';
    document.getElementById('emailEditInvestWrap').style.display = inv ? 'grid' : 'none';
    document.getElementById('emailEditPmLabel').textContent = xfer ? 'From' : (inv ? 'Account' : 'Payment Method');
    document.querySelector('#emailEditModal .modal-title').textContent = xfer ? 'Edit transfer' : 'Edit before adding';
    document.getElementById('emailEditAmount').previousElementSibling.textContent = inv ? 'Total (Rp)' : 'Amount (Rp)';
    document.getElementById('emailEditRememberHint').textContent = xfer
      ? (it.targetKey ? `Links ${it.sourceKey || 'the paying account'} → From and ${it.targetKey} → To.` : 'Also remembers the type and the To account for this merchant.')
      : (k === 'invest' ? '' : 'Remembers the name, category and payment method for this merchant.') + (it.sourceKey ? ` Also links ${it.sourceKey} to the payment method.` : '');
    onRememberToggle();
  }

  function onRememberToggle() {
    const on = document.getElementById('emailEditRemember').checked;
    const it = pending[editIdx];
    // A card bill payment has no merchant to match: "remember" only saves the account/card links.
    document.getElementById('emailEditPatternWrap').style.display = on && it && it.direction !== 'transfer' ? 'block' : 'none';
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
    const kind = editKind;
    const remember = document.getElementById('emailEditRemember').checked;
    const pattern = document.getElementById('emailEditPattern').value.trim();
    // Only carry the name into the rule if the user actually changed it — otherwise a broad
    // match text like "WARUNG" would rename every merchant containing it.
    const ruleBase = tx => ({ mode: 'contains', pattern, tx: tx === it.defaultTx ? '' : tx, type: kind === it.direction ? '' : kind, pm });
    const amount = parseAmountInput(document.getElementById('emailEditAmount').value);
    const date = document.getElementById('emailEditDate').value;
    const pm = document.getElementById('emailEditPm').value;
    if (kind === 'transfer') {
      const to = document.getElementById('emailEditToPm').value;
      if (!pm) { showToast('Pick the paying account', 'error'); return; }
      if (!to) { showToast('Pick the card / account being paid', 'error'); return; }
      if (pm === to) { showToast('From and To must be different', 'error'); return; }
      if (!(amount > 0)) { showToast('Enter an amount', 'error'); return; }
      if (!date) { showToast('Pick a date', 'error'); return; }
      Object.assign(it, { kind, pm, toPm: to, amount, date, checked: true, ambiguous: false });
      if (remember) {
        rememberAccount(it.sourceKey, pm);
        rememberAccount(it.targetKey, to);
        if (it.direction !== 'transfer' && pattern) upsertRule({ ...ruleBase(''), cat: '', toPm: to });
        save();
        reapplyToPending(it);
      }
      closeEdit(); renderPopup(); renderPage();
      return;
    }
    const tx = document.getElementById('emailEditTx').value.trim();
    const cat = document.getElementById('emailEditCat').value;
    const inv = kind === 'invest';
    const lot = Number(String(document.getElementById('emailEditLot').value).replace(',', '.')) || 0;
    if (!tx) { showToast(inv ? 'Enter the asset' : 'Enter a transaction name', 'error'); return; }
    if (!inv && !cat) { showToast('Pick a category', 'error'); return; }
    if (!pm) { showToast(inv ? 'Pick an account' : 'Pick a payment method', 'error'); return; }
    if (inv && !(lot > 0)) { showToast('Enter lot / units', 'error'); return; }
    if (!(amount > 0)) { showToast('Enter an amount', 'error'); return; }
    if (!date) { showToast('Pick a date', 'error'); return; }
    Object.assign(it, { kind, tx, pm, amount, date, checked: true, ambiguous: false });
    if (inv) Object.assign(it, { lot, action: document.getElementById('emailEditAction').value });
    else it.cat = cat;
    if (remember) {
      if (pattern) upsertRule({ ...ruleBase(tx), cat: inv ? '' : cat });
      rememberAccount(it.sourceKey, pm);
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
      if (o.direction === 'transfer') {   // card bill payment: no merchant rules
        if (!o.toPm) {
          const to = findAccountPm(o.targetKey);
          if (to && allPMs.includes(to)) o.toPm = to;
        }
        if (isComplete(o)) o.checked = true;
        return;
      }
      if (!isComplete(o)) {
        const rule = config.rules.find(r => ruleMatches(r, o.merchant));
        if (rule) {
          if (KINDS.includes(rule.type)) o.kind = rule.type;
          if (rule.tx) o.tx = rule.tx;
          if (!o.cat && rule.cat && allCategories.includes(rule.cat)) o.cat = rule.cat;
          if (!o.toPm && rule.toPm && allPMs.includes(rule.toPm)) o.toPm = rule.toPm;
          if (!o.pm && rule.pm && allPMs.includes(rule.pm)) o.pm = rule.pm;
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
  const KIND_LABEL = { expense: 'Expense', income: 'Income', invest: 'Invest', transfer: 'Transfer' };
  function ruleSummary(r) {
    const t = KIND_LABEL[r.type];
    const pm = r.pm ? ' · ' + r.pm : '';
    if (r.type === 'transfer') return `${t}${r.pm ? ' from ' + r.pm : ''} → ${r.toPm || 'no account'}`;
    if (r.type === 'invest') return t + pm;
    return (t ? t + ' · ' : '') + (r.cat || 'no category') + pm;
  }

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
      <p style="font-size:12px;color:var(--text2);line-height:1.5;margin-top:8px">When you open Nota, it looks in your Gmail for new emails from the senders listed under Email types below (bank notices, receipts) and shows them in a popup. Nothing is recorded until you confirm. Emails are read on this device only (read-only access).</p>
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
    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin:18px 0 8px"><span class="form-label" style="margin:0">Email types</span><button class="config-add-btn" onclick="EmailImport.openPick()">+ Add</button></div>`;
    h += config.sources.length ? config.sources.map((s, i) => {
      const where = [tokens(s.senders).length ? 'from ' + tokens(s.senders).join(', ') : '', tokens(s.subject).length ? 'subject: ' + tokens(s.subject).join(', ') : '',
        tokens(s.keyword).length ? 'contains: ' + tokens(s.keyword).join(', ') : ''].filter(Boolean).join(' · ');
      const what = s.reader === 'bank' ? '' : ' · ' + (KIND_LABEL[s.kind] || 'Expense') + (s.cat ? ' · ' + s.cat : '');
      return `<div class="config-row" onclick="EmailImport.openSource(${i})">
        <div style="min-width:0"><div class="config-row-name">${esc(s.name)}</div>
        <div class="config-row-meta" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(where || 'no sender set')}${esc(what)}</div></div>
        <div class="pill-toggle" style="display:flex;gap:4px;flex-shrink:0;white-space:nowrap" onclick="event.stopPropagation()">
          <span class="smart-pill ${s.action === 'ask' ? 'selected' : ''}" onclick="EmailImport.setSourceAction(${i},'ask')">Ask me</span>
          <span class="smart-pill ${s.action === 'ignore' ? 'selected' : ''}" onclick="EmailImport.setSourceAction(${i},'ignore')">Ignore</span>
        </div></div>`;
    }).join('') : `<p style="font-size:12px;color:var(--text2);padding:4px 4px 0;line-height:1.5">No email types yet, so nothing is read. Tap <b>+ Add</b> and pick an email you received (for example a bank notice or a receipt): Nota fills in the sender and reads it for you.</p>`;
    h += gm ? `<button class="config-add-btn" style="padding:8px 4px 0;color:var(--accent)" onclick="EmailImport.openScan()">Scan my mailbox for email types</button>` : '';
    h += `<p style="font-size:11px;color:var(--text2);margin:4px 4px 0;line-height:1.4">Tap a type to change it. The first type that matches an email is used, so put specific types above general ones. Credit card bill payments are recorded as a transfer from your account to the card, so they are not counted as spending twice.</p>`;

    // Accounts
    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 8px"><span class="form-label" style="margin:0">Account &amp; card → payment method</span><button class="config-add-btn" onclick="EmailImport.openAcct(-1)">+ Add</button></div>`;
    h += config.accounts.length ? config.accounts.map((a, i) => `<div class="config-row" onclick="EmailImport.openAcct(${i})">
      <div><div class="config-row-name">${esc(a.key)}</div></div><span class="config-row-meta">${esc(a.pm)} ›</span></div>`).join('')
      : `<p style="font-size:12px;color:var(--text3);padding:4px 4px 0">None yet. They are added when you confirm a transaction with "Remember" on.</p>`;

    // Rules
    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin:20px 0 8px"><span class="form-label" style="margin:0">Merchant rules</span><button class="config-add-btn" onclick="EmailImport.openRule(-1)">+ Add</button></div>`;
    h += config.rules.length ? config.rules.map((r, i) => `<div class="config-row" onclick="EmailImport.openRule(${i})">
      <div><div class="config-row-name">${esc(r.pattern)}</div><div class="config-row-meta">${esc(MODE_LABEL[r.mode])}${r.tx ? ' → ' + esc(r.tx) : ''} · ${esc(ruleSummary(r))}</div></div><span class="config-row-meta">›</span></div>`).join('')
      : `<p style="font-size:12px;color:var(--text3);padding:4px 4px 0">None yet. Fix a transaction in the popup with "Remember" on and it appears here.</p>`;
    h += `<div style="height:24px"></div>`;
    el.innerHTML = h;
  }

  // ── email types (sources): list actions + editor ──────────
  let editSrcIdx = -1;
  let draftSrc = null;
  let previewMsgs = [];          // fetched sample emails for the open editor (memory only, never saved)

  // A changed type may make emails readable that were set aside before: re-offer them.
  function reconsiderEmails() {
    seen = seen.filter(s => !s.startsWith('i:') && !s.startsWith('u'));
    seenSet = new Set(seen);
    localStorage.removeItem(LS_LAST);
  }

  function setSourceAction(i, action) {
    if (!config.sources[i]) return;
    config.sources[i].action = action;
    reconsiderEmails();
    save(); renderPage();
  }

  function newSource(preset) {
    return { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: '', senders: '', subject: '', keyword: '',
      reader: 'receipt', action: 'ask', kind: 'expense', txMode: 'email', txFixed: '', cat: '', pm: '', amountLabel: '', ...(preset || {}) };
  }

  function openSource(i, preset) {
    editSrcIdx = i;
    draftSrc = i >= 0 ? JSON.parse(JSON.stringify(config.sources[i])) : newSource(preset);
    previewMsgs = [];
    const $ = id => document.getElementById(id);
    $('emailSrcTitle').textContent = i >= 0 ? 'Edit email type' : 'New email type';
    $('emailSrcName').value = draftSrc.name;
    $('emailSrcSenders').value = draftSrc.senders;
    $('emailSrcSubject').value = draftSrc.subject;
    $('emailSrcKeyword').value = draftSrc.keyword;
    $('emailSrcReader').value = draftSrc.reader;
    $('emailSrcTxMode').value = draftSrc.txMode;
    $('emailSrcTxFixed').value = draftSrc.txFixed;
    $('emailSrcCat').innerHTML = optionsHtml(allCategories, draftSrc.cat, 'No default');
    $('emailSrcPm').innerHTML = optionsHtml(allPMs, draftSrc.pm, 'No default');
    $('emailSrcDeleteBtn').style.display = i >= 0 ? '' : 'none';
    $('emailSrcPreview').innerHTML = '';
    onSourceReaderChange();
    $('emailSrcKind').value = draftSrc.kind;
    $('emailSrcModal').classList.add('open');
    if (i < 0 && preset && Auth.hasGmailScope()) previewSource();   // came from a picked email: show what Nota reads
  }

  function onSourceReaderChange() {
    const $ = id => document.getElementById(id);
    const bank = $('emailSrcReader').value === 'bank';
    const keep = $('emailSrcKind').value;
    $('emailSrcKind').innerHTML = (bank ? '<option value="">As in the email</option>' : '')
      + '<option value="expense">Expense</option><option value="income">Income</option><option value="invest">Invest</option><option value="transfer">Transfer</option>';
    $('emailSrcKind').value = (!bank && !keep) ? 'expense' : keep;
    $('emailSrcTxFixed').style.display = $('emailSrcTxMode').value === 'fixed' ? '' : 'none';
  }

  function readDraft() {
    const $ = id => document.getElementById(id);
    Object.assign(draftSrc, {
      name: $('emailSrcName').value.trim(), senders: $('emailSrcSenders').value.trim(), subject: $('emailSrcSubject').value.trim(), keyword: $('emailSrcKeyword').value.trim(),
      reader: $('emailSrcReader').value, kind: $('emailSrcKind').value, txMode: $('emailSrcTxMode').value,
      txFixed: $('emailSrcTxFixed').value.trim(), cat: $('emailSrcCat').value, pm: $('emailSrcPm').value,
    });
    return draftSrc;
  }

  function closeSource() { document.getElementById('emailSrcModal').classList.remove('open'); editSrcIdx = -1; draftSrc = null; previewMsgs = []; }

  function saveSource() {
    const s = readDraft();
    if (!s.name) { showToast('Give this email type a name', 'error'); return; }
    if (!tokens(s.senders).length && !tokens(s.subject).length) { showToast('Enter a sender or a subject to look for', 'error'); return; }
    if (s.txMode === 'fixed' && !s.txFixed) { showToast('Enter the transaction name', 'error'); return; }
    if (editSrcIdx >= 0) config.sources[editSrcIdx] = s; else insertSource(s);
    reconsiderEmails();
    save(); closeSource(); renderPage();
    check({ force: true });
  }

  function deleteSource() {
    if (editSrcIdx >= 0) config.sources.splice(editSrcIdx, 1);
    reconsiderEmails();
    save(); closeSource(); renderPage();
  }

  // Looks at the last 30 days of mail that match the (unsaved) type and shows what Nota would read,
  // so the user can check before saving. Several amounts and no clear total → offer a choice;
  // picking one teaches this type which label is the total.
  async function previewSource() {
    const s = readDraft();
    const out = document.getElementById('emailSrcPreview');
    if (!tokens(s.senders).length && !tokens(s.subject).length) { showToast('Enter a sender or a subject first', 'error'); return; }
    if (!Auth.hasGmailScope()) { showToast('Connect Gmail first (top of this page)', 'error'); return; }
    out.innerHTML = '<p style="font-size:12px;color:var(--text2)">Searching your mailbox…</p>';
    try {
      const q = `${buildQuery([{ ...s, action: 'ask' }])} newer_than:30d`;
      const list = await gmailFetch('/messages?maxResults=8&q=' + encodeURIComponent(q));
      const ids = (list.messages || []).map(m => m.id);
      previewMsgs = [];
      for (const id of ids) {
        const msg = await gmailFetch(`/messages/${id}?format=full`);
        let body = messageBody(msg);
        if (s.reader === 'receipt') body = (await bodyWithPdf(msg, body)).body;
        if (tokens(s.keyword).length && !tokens(s.keyword).some(k => plainText(body).toLowerCase().includes(k.toLowerCase()))) continue;
        previewMsgs.push({ id, body, from: headerOf(msg, 'from'), subject: headerOf(msg, 'subject'),
          date: localISO(Number(msg.internalDate) || Date.now()) });
      }
      renderPreview();
    } catch (e) {
      out.innerHTML = `<p style="font-size:12px;color:#ff6b6b">Could not search: ${esc(e.message)}</p>`;
    }
  }

  function renderPreview() {
    const out = document.getElementById('emailSrcPreview');
    const s = draftSrc;
    if (!s) return;
    if (!previewMsgs.length) { out.innerHTML = '<p style="font-size:12px;color:var(--text2)">No matching emails in the last 30 days. Check the sender spelling, or that the mail reaches this Gmail account.</p>'; return; }
    const cards = previewMsgs.map(m => {
      const p = s.reader === 'bank' ? EmailParser.parse(m.body, m.date, m.subject) : readWith(s, m.body, m.date, m.subject, m.from);
      if (p && p.status === 'failed') return `<div class="account-info-card" style="margin:0 0 8px;border-left:2px solid var(--text3)"><div style="font-size:13px;font-weight:600">${esc(maskDigits(m.subject) || 'Email')}</div><div style="font-size:11px;color:var(--text2);margin-top:2px">Not paid yet, so it is skipped</div></div>`;
      if (!p) return `<div class="account-info-card" style="margin:0 0 8px;border-left:2px solid #ff9500"><div style="font-size:13px;font-weight:600">${esc(maskDigits(m.subject) || 'Email')}</div><div style="font-size:11px;color:#ff9500;margin-top:2px">Could not find an amount in this email</div></div>`;
      const chips = (s.reader === 'receipt' && p.ambiguous)
        ? `<div style="font-size:11px;color:#ff9500;margin-top:6px">Several amounts found. Which one is the total?</div><div>${p.candidates.slice(0, 6).map(c =>
          `<span class="smart-pill" style="margin:4px 4px 0 0" onclick="EmailImport.pickAmountLabel(${JSON.stringify(c.label).replace(/"/g, '&quot;')})">${esc(fRp(c.value))}${c.label ? ' · ' + esc(c.label) : ''}</span>`).join('')}</div>` : '';
      return `<div class="account-info-card" style="margin:0 0 8px"><div style="display:flex;justify-content:space-between;gap:10px">
        <div style="min-width:0"><div style="font-size:13px;font-weight:600">${esc(p.defaultTx || p.merchant || p.typeLabel)}</div><div style="font-size:11px;color:var(--text2)">${esc(isoDisp(p.date))}${p.amountLabel ? ' · ' + esc(p.amountLabel) : ''}</div></div>
        <div style="font-size:13px;font-weight:600;white-space:nowrap">${p.amount > 0 ? fRp(p.amount) : '—'}</div></div>${chips}</div>`;
    }).join('');
    out.innerHTML = `<div style="font-size:12px;font-weight:600;color:var(--green);margin:4px 0 8px">${previewMsgs.length} email${previewMsgs.length !== 1 ? 's' : ''} found (last 30 days)</div>${cards}${s.amountLabel ? `<p style="font-size:11px;color:var(--text2)">Total is read from "${esc(s.amountLabel)}".</p>` : ''}`;
  }

  function pickAmountLabel(label) {
    if (!draftSrc) return;
    draftSrc.amountLabel = label;
    renderPreview();
  }

  // ── PDF attachments ───────────────────────────────────────
  // Some receipts carry the amount only in an attached PDF. The text is read on this device with
  // pdf.js (loaded from cdnjs only the first time a PDF is needed; scanned or password-protected
  // PDFs have no readable text and are simply skipped).
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  const PDFJS_SRI = 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e';
  const PDFJS_WORKER_SRI = 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2';
  const PDF_MAX_BYTES = 2000000;
  const PDF_MAX_PAGES = 4;
  let pdfjsPromise = null;

  function b64ToBytes(data) {
    const bin = atob(String(data || '').replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = PDFJS + 'pdf.min.js'; sc.integrity = PDFJS_SRI; sc.crossOrigin = 'anonymous';
      sc.onerror = () => reject(new Error('Could not load the PDF reader'));
      sc.onload = async () => {
        try {
          // The worker must be same-origin: fetch it, check its hash, and run it from a blob.
          const buf = await (await fetch(PDFJS + 'pdf.worker.min.js')).arrayBuffer();
          const sum = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-384', buf))));
          if ('sha384-' + sum !== PDFJS_WORKER_SRI) throw new Error('PDF reader failed its integrity check');
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
          resolve(window.pdfjsLib);
        } catch (e) { reject(e); }
      };
      document.head.appendChild(sc);
    }).catch(e => { pdfjsPromise = null; throw e; });
    return pdfjsPromise;
  }

  function pdfParts(msg) {
    const out = [];
    (function walk(part) {
      if (!part) return;
      const att = part.body && part.body.attachmentId;
      if (att && (/\.pdf$/i.test(part.filename || '') || /^application\/pdf/i.test(part.mimeType || '')) && (part.body.size || 0) <= PDF_MAX_BYTES) {
        out.push({ id: att, name: part.filename || 'attachment.pdf' });
      }
      (part.parts || []).forEach(walk);
    })(msg.payload);
    return out;
  }

  // Text of the first PDF attached to a message ('' when there is none or it cannot be read).
  async function pdfTextOf(msg) {
    const part = pdfParts(msg)[0];
    if (!part) return { text: '', name: '' };
    try {
      const att = await gmailFetch('/messages/' + msg.id + '/attachments/' + part.id);
      const lib = await loadPdfJs();
      const doc = await lib.getDocument({ data: b64ToBytes(att.data) }).promise;
      const pages = [];
      for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        pages.push(EmailParser.pdfItemsToText(tc.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width }))));
      }
      doc.destroy();
      return { text: pages.join('\n'), name: part.name };
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      console.warn('[email-import] pdf not read', e && e.message);
      return { text: '', name: part.name };
    }
  }

  // Body text plus, when the email text has no amount but a PDF is attached, that PDF's text.
  async function bodyWithPdf(msg, body) {
    if (EmailParser.receiptScore(body, '', '', '').amount > 0) return { body, names: '' };
    const pdf = await pdfTextOf(msg);
    return pdf.text ? { body: body + '\n' + pdf.text, names: pdf.name } : { body, names: pdf.name };
  }

  // ── adding email types the easy way: pick an email, or scan the mailbox ──
  // A message is turned into a ready-to-edit type: sender from the real From header, a keyword that
  // tells this kind of email apart ("Transaction Type" value), and the bank reader when one of the
  // built-in templates understands it (so reference numbers / card numbers keep working).
  function addrOf(from) { return ((String(from || '').match(/<([^>]+)>/) || [])[1] || String(from || '')).trim(); }
  function brandOf(from) { const n = EmailParser.senderName(from) || addrOf(from); return n.length <= 4 ? n.toUpperCase() : n; }

  function suggestSource(m) {
    const keyword = EmailParser.guessKeyword(m.body);
    const bank = !!EmailParser.parse(m.body, m.date, m.subject);
    // Bank emails are told apart by a word inside; receipts by the stable start of the subject
    // (the same sender can send a paid receipt and an unpaid confirmation).
    const subject = (bank && keyword) ? '' : EmailParser.subjectPattern(m.subject);
    const brand = brandOf(m.from);
    const label = keyword || subject;
    const first = brand.split(/\s+/)[0].toLowerCase();
    const name = label ? (label.toLowerCase().includes(first) ? label : `${brand} - ${label}`) : `${brand} - receipts`;
    return { name: name.slice(0, 60), senders: addrOf(m.from), subject, keyword, reader: bank ? 'bank' : 'receipt', kind: bank ? '' : 'expense' };
  }

  // Specific types (with a keyword) go above a general type for the same sender, which must stay last.
  function insertSource(src) {
    const sameSender = s => tokens(s.senders).some(t => tokens(src.senders).some(u => u.toLowerCase() === t.toLowerCase()));
    if (tokens(src.keyword).length) {
      const at = config.sources.findIndex(s => sameSender(s) && !tokens(s.keyword).length);
      if (at >= 0) { config.sources.splice(at, 0, src); return; }
    }
    config.sources.push(src);
  }

  let pickRows = [];
  // Words a receipt or payment notice contains. Folders are ignored on purpose (receipts also land in
// Promotions / Updates / Social); the score in EmailParser.receiptScore does the real filtering.
  const RECEIPT_QUERY = 'newer_than:30d (total OR receipt OR struk OR invoice OR pembayaran OR payment OR order OR pesanan OR purchase OR transaction OR booking)';
  function pickModal(title, body, foot) {
    document.getElementById('emailPickTitle').textContent = title;
    document.getElementById('emailPickBody').innerHTML = body;
    document.getElementById('emailPickFoot').innerHTML = foot;
    document.getElementById('emailPickModal').classList.add('open');
  }
  function closePick() { document.getElementById('emailPickModal').classList.remove('open'); }
  const GHOST = 'background:var(--bg3);border-color:var(--border);color:var(--text)';
  const manualBtn = `<button class="btn-delete" style="${GHOST}" onclick="EmailImport.closePick();EmailImport.openSource(-1)">Enter it manually</button>`;
  const cancelBtn = `<button class="btn-save" onclick="EmailImport.closePick()">Cancel</button>`;

  async function listMoneyEmails(max) {
    const list = await gmailFetch(`/messages?maxResults=${max}&q=` + encodeURIComponent(RECEIPT_QUERY));
    return (list.messages || []).map(m => m.id);
  }

  async function openPick() {
    if (!Auth.hasGmailScope()) {
      pickModal('Add an email type', `<p style="font-size:13px;color:var(--text2);line-height:1.5">Connect Gmail (switch at the top of this page) and Nota can show your recent emails to pick from. Or enter the sender yourself.</p>`, manualBtn + cancelBtn);
      return;
    }
    pickModal('Pick an email', `<p style="font-size:12px;color:var(--text2)">Looking through the last 30 days…</p>`, manualBtn + cancelBtn);
    try {
      const ids = await listMoneyEmails(40);
      pickRows = [];
      const q = ids.slice();
      const worker = async () => {
        while (q.length) {
          const id = q.shift();
          try {
            const msg = await gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
            pickRows.push({ id, from: headerOf(msg, 'from'), subject: headerOf(msg, 'subject'), t: Number(msg.internalDate) || 0 });
          } catch (e) { if (e.status === 401 || e.status === 403) throw e; }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      pickRows.sort((a, b) => b.t - a.t);
      const body = pickRows.length
        ? `<p style="font-size:12px;color:var(--text2);margin-bottom:8px">Tap an email that is the kind you want Nota to record.</p>` + pickRows.map((r, i) => {
          const cov = sourceFor(r.from, r.subject, '');
          return `<div class="config-row" onclick="EmailImport.pickEmail(${i})">
            <div style="min-width:0"><div class="config-row-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(brandOf(r.from))} · ${esc(maskDigits(r.subject) || '(no subject)')}</div>
            <div class="config-row-meta">${esc(addrOf(r.from))} · ${esc(isoDisp(localISO(r.t)))}${cov && !tokens(cov.keyword).length ? ' · already covered' : ''}</div></div><span class="config-row-meta">›</span></div>`;
        }).join('')
        : `<p style="font-size:13px;color:var(--text2);line-height:1.5">No emails with an amount (Rp / IDR) in the last 30 days in <b>${esc(localStorage.getItem(LS_ACCOUNT) || 'this mailbox')}</b>. If your bank emails go to another Gmail, forward them here first.</p>`;
      pickModal('Pick an email', body, manualBtn + cancelBtn);
    } catch (e) {
      pickModal('Pick an email', `<p style="font-size:13px;color:#ff6b6b">Could not read Gmail: ${esc(e.message)}</p>`, manualBtn + cancelBtn);
    }
  }

  async function pickEmail(i) {
    const r = pickRows[i];
    if (!r) return;
    showToast('Reading the email…', 'loading', 0);
    try {
      const msg = await gmailFetch(`/messages/${r.id}?format=full`);
      const m = { body: messageBody(msg), from: headerOf(msg, 'from'), subject: headerOf(msg, 'subject'), date: localISO(Number(msg.internalDate) || Date.now()) };
      closePick();
      openSource(-1, suggestSource(m));
      showToast('Check the details, then Save', 'success');
    } catch (e) { showToast('Could not read that email', 'error'); }
  }

  // Looks through the last 30 days of emails that carry an amount and proposes one type per
  // sender + kind, skipping what an existing type already covers.
  let scanGroups = [];
  let scanAll = false;       // show every find, not just the strongest 8
  const SCAN_TOP = 8;
  async function openScan() {
    if (!Auth.hasGmailScope()) { showToast('Connect Gmail first', 'error'); return; }
    pickModal('Scan my mailbox', `<p style="font-size:12px;color:var(--text2)">Reading your last 30 days of emails that contain an amount. This stays on your device.</p>`, cancelBtn);
    try {
      const ids = await listMoneyEmails(60);
      const groups = new Map();
      const q = ids.slice();
      const worker = async () => {
        while (q.length) {
          const id = q.shift();
          let msg;
          try { msg = await gmailFetch(`/messages/${id}?format=full`); } catch (e) { if (e.status === 401 || e.status === 403) throw e; continue; }
          const m = { body: messageBody(msg), from: headerOf(msg, 'from'), subject: headerOf(msg, 'subject'), date: localISO(Number(msg.internalDate) || Date.now()) };
          if (sourceFor(m.from, m.subject, plainText(m.body))) continue;   // already covered
          const pdf = await bodyWithPdf(msg, m.body);
          m.body = pdf.body;
          // Only what looks like a paid receipt / payment notice (score 4+); unpaid bookings never count.
          const sc = EmailParser.receiptScore(m.body, m.subject, m.from, pdf.names);
          if (sc.unpaid || !(sc.amount > 0)) continue;
          const sug = suggestSource(m);
          if (sug.reader === 'bank') sc.score += 3;   // a built-in bank template recognised it
          if (sc.score < 4) continue;
          const key = `${sug.senders.toLowerCase()}|${sug.keyword.toLowerCase()}|${sug.subject.toLowerCase()}`;
          const g = groups.get(key) || { sug, count: 0, scoreSum: 0, sample: sc.amount, on: true };
          g.count++; g.scoreSum += sc.score;
          groups.set(key, g);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      scanGroups = [...groups.values()].sort((a, b) => (b.scoreSum / b.count) - (a.scoreSum / a.count) || b.count - a.count);
      scanAll = false;
      if (!scanGroups.length) {
        pickModal('Scan my mailbox', `<p style="font-size:13px;color:var(--text2);line-height:1.5">Nothing new found. Emails with an amount are either already covered by one of your types, or none arrived in the last 30 days.</p>`, manualBtn + cancelBtn);
        return;
      }
      renderScan();
    } catch (e) {
      pickModal('Scan my mailbox', `<p style="font-size:13px;color:#ff6b6b">Could not read Gmail: ${esc(e.message)}</p>`, cancelBtn);
    }
  }

  function renderScan() {
    const n = scanGroups.filter(g => g.on).length;
    const shown = scanAll ? scanGroups : scanGroups.slice(0, SCAN_TOP);
    const more = scanGroups.length - shown.length;
    pickModal('Found in your mailbox', `<p style="font-size:12px;color:var(--text2);margin-bottom:8px">Receipts and payment notices, best matches first. Untick any you do not want; you can change each one later.</p>` + shown.map((g, i) => `<label class="config-row" style="cursor:pointer">
        <div style="min-width:0"><div class="config-row-name">${esc(g.sug.name)}</div>
        <div class="config-row-meta">${g.count} email${g.count !== 1 ? 's' : ''} · from ${esc(g.sug.senders)} · e.g. ${esc(fRp(g.sample))}</div></div>
        <input type="checkbox" ${g.on ? 'checked' : ''} onchange="EmailImport.toggleScan(${scanGroups.indexOf(g)}, this.checked)"></label>`).join('') + (more > 0 ? `<button class="config-add-btn" style="padding:8px 0 0;color:var(--text2)" onclick="EmailImport.showMoreScan()">Show ${more} more</button>` : ''),
      `<button class="btn-delete" style="${GHOST}" onclick="EmailImport.closePick()">Cancel</button><button class="btn-save" ${n ? '' : 'disabled style="opacity:.4"'} onclick="EmailImport.addScanned()">Add ${n} type${n !== 1 ? 's' : ''}</button>`);
  }
  function showMoreScan() { scanAll = true; renderScan(); }
  function toggleScan(i, on) { if (scanGroups[i]) scanGroups[i].on = !!on; renderScan(); }

  function addScanned() {
    const chosen = scanGroups.filter(g => g.on);   // includes any not currently shown only if ticked (all start ticked)
    chosen.forEach(g => insertSource(newSource(g.sug)));
    scanGroups = [];
    reconsiderEmails();
    save(); closePick(); renderPage();
    showToast(`${chosen.length} email type${chosen.length !== 1 ? 's' : ''} added`, 'success');
    check({ force: true });
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
    const r = i >= 0 ? config.rules[i] : { mode: 'contains', pattern: '', tx: '', cat: '', type: '', toPm: '', pm: '' };
    document.getElementById('emailRuleTitle').textContent = i >= 0 ? 'Edit rule' : 'New rule';
    document.getElementById('emailRuleMode').value = r.mode;
    document.getElementById('emailRulePattern').value = r.pattern;
    document.getElementById('emailRuleType').value = KINDS.includes(r.type) ? r.type : '';
    document.getElementById('emailRuleTx').value = r.tx;
    document.getElementById('emailRuleCat').innerHTML = optionsHtml(allCategories, r.cat, 'Pick a category');
    document.getElementById('emailRuleToPm').innerHTML = optionsHtml(allPMs, r.toPm || '', 'Pick the card / account');
    document.getElementById('emailRulePm').innerHTML = optionsHtml(allPMs, r.pm || '', 'No default');
    document.getElementById('emailRuleDeleteBtn').style.display = i >= 0 ? '' : 'none';
    onRuleTypeChange();
    document.getElementById('emailRuleModal').classList.add('open');
  }
  function onRuleTypeChange() {
    const t = document.getElementById('emailRuleType').value;
    document.getElementById('emailRuleCatWrap').style.display = (t === 'invest' || t === 'transfer') ? 'none' : '';
    document.getElementById('emailRuleToWrap').style.display = t === 'transfer' ? '' : 'none';
    document.getElementById('emailRulePmLabel').textContent = t === 'transfer' ? 'From' : (t === 'invest' ? 'Account' : 'Payment method');
    document.getElementById('emailRuleTxLabel').innerHTML = t === 'invest'
      ? 'Then asset <span style="font-weight:400;text-transform:none">(optional)</span>'
      : 'Then transaction name <span style="font-weight:400;text-transform:none">(optional)</span>';
    document.getElementById('emailRuleTx').closest('.form-group').style.display = t === 'transfer' ? 'none' : '';
  }
  function closeRule() { document.getElementById('emailRuleModal').classList.remove('open'); editRuleIdx = -1; }
  function saveRule() {
    const pattern = document.getElementById('emailRulePattern').value.trim();
    const cat = document.getElementById('emailRuleCat').value;
    if (!pattern) { showToast('Enter the merchant text to match', 'error'); return; }
    const type = document.getElementById('emailRuleType').value;
    const toPm = document.getElementById('emailRuleToPm').value;
    if (type === 'transfer') {
      if (!toPm) { showToast('Pick the card / account the money goes to', 'error'); return; }
    } else if (type !== 'invest' && !cat) { showToast('Pick a category', 'error'); return; }
    const rule = { mode: document.getElementById('emailRuleMode').value, pattern, type,
      tx: type === 'transfer' ? '' : document.getElementById('emailRuleTx').value.trim(),
      cat: (type === 'invest' || type === 'transfer') ? '' : cat, toPm: type === 'transfer' ? toPm : '', pm: document.getElementById('emailRulePm').value };
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
    buildQuery, sourceFor, readWith, defaultSources, normalizeConfig, suggestSource, insertSource, newSource,
  };

  return {
    init, check, onToggle, connect, checkNow, reopenPopup, onPageOpen, renderPage,
    copyUnreadable, copyReport, onCheck, closePopup, skipAll, addSelected, openEdit, closeEdit, saveEdit, onRememberToggle,
    setEditKind, onRuleTypeChange, openSource, closeSource, saveSource, deleteSource, previewSource,
    setSourceAction, onSourceReaderChange, openPick, closePick, onEditTxInput, pickEmail, openScan, toggleScan, showMoreScan, addScanned, pickAmountLabel, openRule, closeRule, saveRule, deleteRule, openAcct, closeAcct, saveAcct, deleteAcct,
    _internals,
  };
})();

// Run after the DOM and the other scripts above are in place.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => EmailImport.init());
else EmailImport.init();
