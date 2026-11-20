/* CC Usage: CC group persistence (CCGroups sheet tab). Page/UI code is added in later phases.
   Server is the source of truth; localStorage is only a read cache so the page can paint instantly. */
const CC_GROUPS_LS_KEY = 'notapub_ccgroups_v1';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Coerces types, drops unusable entries and enforces one-group-per-PM (first group in sort order wins).
function normalizeCCGroups(arr) {
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const date = v => (ISO_DATE_RE.test(String(v || '')) ? String(v) : null);
  const claimed = new Set();
  return (Array.isArray(arr) ? arr : [])
    .filter(g => g && g.id && String(g.name || '').trim())
    .map(g => {
      const tempLimit = num(g.tempLimit) > 0 ? num(g.tempLimit) : null;
      const anchorOk = date(g.anchorDate) && g.anchorOutstanding !== null && g.anchorOutstanding !== undefined && g.anchorOutstanding !== '';
      return {
        id: String(g.id),
        name: String(g.name).trim().slice(0, 40),
        pms: Array.isArray(g.pms) ? g.pms.map(String) : [],
        permanentLimit: Math.max(0, num(g.permanentLimit)),
        tempLimit,
        tempLimitExpiry: tempLimit ? date(g.tempLimitExpiry) : null,
        anchorDate: anchorOk ? date(g.anchorDate) : null,
        anchorOutstanding: anchorOk ? num(g.anchorOutstanding) : null,
        pendingAuth: Math.max(0, num(g.pendingAuth)),
        pendingAuthDate: date(g.pendingAuthDate),
        closedSeries: Array.isArray(g.closedSeries) ? g.closedSeries.map(String) : [],
        sortOrder: num(g.sortOrder),
        updatedAt: String(g.updatedAt || '')
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(g => {
      const seen = new Set();
      g.pms = g.pms.filter(pm => {
        const k = pm.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        if (claimed.has(k)) { console.warn('[cc-usage] PM already in another group, dropped:', pm); return false; }
        claimed.add(k);
        return true;
      });
      return g;
    });
}

function readCCGroupsCache() {
  try { return normalizeCCGroups(JSON.parse(localStorage.getItem(CC_GROUPS_LS_KEY) || '[]')); } catch (e) { return []; }
}
function writeCCGroupsCache() {
  try { localStorage.setItem(CC_GROUPS_LS_KEY, JSON.stringify(CC_GROUPS)); } catch (e) {}
}

let CC_GROUPS = readCCGroupsCache();

// Returns the fresh normalized groups, or null when the server could not be read.
async function fetchCCGroupsRaw() {
  try {
    const res = await fetchWithTimeout(apiGet('type=ccgroups'), { method: 'GET' });
    const j = await res.json();
    if (j.status !== 'ok') { console.warn('[cc-usage] load failed', j.message); return null; }
    return normalizeCCGroups(j.groups);
  } catch (e) { console.warn('[cc-usage] load error', e.message); return null; }
}

async function fetchCCGroups() {
  const fresh = await fetchCCGroupsRaw();
  if (!fresh) return false; // keep the cache
  CC_GROUPS = fresh;
  writeCCGroupsCache();
  return true;
}

// The only write path: re-read the sheet, apply fn to a copy, save the whole list.
// fn returns the new array, or null for "nothing to change" (no write, so the tab is never created needlessly).
async function mutateCCGroups(fn) {
  const fresh = await fetchCCGroupsRaw();
  if (!fresh) { showToast("Couldn't reach Google Sheets — try again", 'error'); return false; }
  const changed = fn(structuredClone(fresh));
  if (changed === null) { CC_GROUPS = fresh; writeCCGroupsCache(); return true; }
  const next = normalizeCCGroups(changed);
  try {
    const res = await fetchWithTimeout(apiGet('type=ccgroups'), {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: apiBody({ type: 'ccgroups', action: 'saveAll', groups: next })
    });
    const j = await res.json();
    if (j.status !== 'ok') { showToast('Could not save CC groups: ' + (j.message || 'error'), 'error'); return false; }
  } catch (e) { showToast('Could not save CC groups: ' + e.message, 'error'); return false; }
  CC_GROUPS = next;
  writeCCGroupsCache();
  return true;
}

// Called from saveConfigItem when a payment method is renamed. Failure only toasts; nothing else depends on it.
function ccGroupsRenamePM(oldName, newName) {
  const o = oldName.toLowerCase();
  return mutateCCGroups(groups => {
    if (!groups.some(g => g.pms.some(p => p.toLowerCase() === o))) return null;
    return groups.map(g => ({ ...g, pms: g.pms.map(p => (p.toLowerCase() === o ? newName : p)) }));
  });
}

// ── Page: selection, render ───────────────────────────────────
const CC_SEL_LS_KEY = 'notapub_ccusage_sel';
let ccUsageSelectedId = '';
try { ccUsageSelectedId = localStorage.getItem(CC_SEL_LS_KEY) || ''; } catch (e) {}
let ccgEditId = null;
let ccgSaving = false;

const ccCardPMs = () => CONFIG_ITEMS.filter(i => i.kind === 'pm' && i.creditCard && !i.archived);
const ccShortDate = iso => isoDisp(iso).split(' ').slice(0, 2).join(' ');

// The group a payment method belongs to (case-insensitive), or null.
function ccGroupForPM(name) {
  const k = String(name || '').toLowerCase();
  return CC_GROUPS.find(g => g.pms.some(p => p.toLowerCase() === k)) || null;
}

function ccSelectedGroup() {
  return CC_GROUPS.find(g => g.id === ccUsageSelectedId) || CC_GROUPS[0] || null;
}

function ccUsageSelect(id) {
  ccUsageSelectedId = id;
  ccUsageCycleOffset = 0;
  try { localStorage.setItem(CC_SEL_LS_KEY, id); } catch (e) {}
  renderCCUsage();
}

// ── Rows from Nota's data ─────────────────────────────────────
const ccLc = s => String(s || '').toLowerCase();
const ccIso = (y, m0, d) => `${y}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const ccRowIso = r => (r.date ? String(r.date).slice(0, 10) : ccIso(r.y, r.m, r.d));

// Normalised rows for the core: synced rows from HIST.opex plus not-yet-synced txHistory rows.
// Future-dated rows are left out. Amounts are IDR; `kind` carries the direction.
function collectCCRows(pmSet) {
  const today = todayISO();
  const rows = [];
  const push = (date, pm, kind, amount, r, source, idx) => {
    if (!(amount > 0) || date > today) return;
    rows.push({ date, pm, kind, amount, tx: r.tx || '', notes: r.notes || '', cat: r.cat || r.category || '', ref: { source, idx } });
  };
  // Count-based ghost matching (same idea as _reconcileUnsyncedWithSheet): an unsynced local row whose
  // twin already arrived from the sheet in the same month must not be counted twice.
  const sheetCounts = {};
  (HIST.opex || []).forEach((r, i) => {
    const k = `${r.y}-${r.m}|${sigOfSheetRow(r)}`;
    sheetCounts[k] = (sheetCounts[k] || 0) + 1;
    if (!pmSet.has(ccLc(r.pm))) return;
    if ((r.exp || 0) > 0) push(ccRowIso(r), r.pm, 'charge', r.exp, r, 'hist-opex', i);
    else if ((r.inc || 0) > 0) push(ccRowIso(r), r.pm, 'credit', r.inc, r, 'hist-opex', i);
  });
  const used = {};
  (txHistory || []).forEach((h, i) => {
    if (h.synced || !h.date) return;
    const date = String(h.date).slice(0, 10);
    if (h.type === 'transfer') {
      if (pmSet.has(ccLc(h.toPm))) push(date, h.toPm, 'credit', h.amount, h, 'local-opex', i);
      if (pmSet.has(ccLc(h.fromPm))) push(date, h.fromPm, 'charge', h.amount, h, 'local-opex', i);
      return;
    }
    const [y, m] = date.split('-');
    const key = `${+y}-${+m - 1}|${sigOfTxHistory(h)}`;
    used[key] = (used[key] || 0) + 1;
    if ((sheetCounts[key] || 0) >= used[key]) return;
    if (!pmSet.has(ccLc(h.pm))) return;
    push(date, h.pm, h.type === 'income' ? 'credit' : 'charge', h.amount, h, 'local-opex', i);
  });
  return rows;
}

// Transaction list items in the same shape as Search results, so renderTxItemHTML and tap-to-edit work unchanged.
function ccListItems(listRows) {
  const items = [], seen = new Set();
  const add = (source, idx, row) => {
    const k = `${source}:${idx}`;
    if (seen.has(k)) return;
    seen.add(k);
    items.push({ source, idx, row, type: 'opex' });
  };
  listRows.forEach(r => {
    const { source, idx } = r.ref;
    const row = source === 'hist-opex' ? HIST.opex[idx] : txHistory[idx];
    if (!row) return;
    add(source, idx, row);
    // The other leg of a Transfer may sit on a non-CC payment method; pull it in so the pair merges.
    if (source === 'hist-opex' && (row.cat || row.category) === 'Transfer' && String(row.id || '').startsWith('xfr_')) {
      HIST.opex.forEach((o, j) => { if (j !== idx && o.id === row.id) add('hist-opex', j, o); });
    }
  });
  return mergeTransferPairs(items).sort((a, b) => ccRowIso(b.row).localeCompare(ccRowIso(a.row)));
}

// Keys (`source:idx`) of list items that give limit back: payments, refunds and transfers into the group's cards.
function ccCreditKeys(items, pmSet) {
  const keys = new Set();
  items.forEach(it => {
    const r = it.row, key = `${it.source}:${it.idx}`;
    const xfr = it.source === 'hist-transfer' ? [r.transferFromPm, r.transferToPm]
      : (it.source === 'local-opex' && r.type === 'transfer' ? [r.fromPm, r.toPm] : null);
    if (xfr) { if (pmSet.has(ccLc(xfr[1])) && !pmSet.has(ccLc(xfr[0]))) keys.add(key); return; }
    if (it.source === 'hist-opex' && pmSet.has(ccLc(r.pm)) && (r.inc || 0) > 0 && !(r.exp || 0)) keys.add(key);
    else if (it.source === 'local-opex' && r.type === 'income') keys.add(key);
  });
  return keys;
}

// ── Page: render ──────────────────────────────────────────────
let ccUsageCycleOffset = 0; // 0 = current billing cycle, -1 = previous, ...
let ccWaitingHist = false;

function openCCUsagePage() {
  ccUsageCycleOffset = 0;
  renderCCUsage();
  fetchCCGroups().then(renderCCUsage);
}

function renderCCUsageIfActive() {
  const page = document.getElementById('page-ccusage');
  if (page && page.classList.contains('active')) renderCCUsage();
}

function ccUsageShiftCycle(d) {
  ccUsageCycleOffset = Math.min(0, Math.max(-36, ccUsageCycleOffset + d));
  renderCCUsage();
}

function ccRow(cls, label, value, sub) {
  return `<div class="ccu-row"><span class="ccu-dot ${cls}"></span>
    <span class="ccu-row-l">${label}${sub ? ` <span class="ccu-muted">${sub}</span>` : ''}</span><span class="ccu-row-v">${value}</span></div>`;
}

function ccBarHTML(u) {
  const segs = [['c-stmt', u.statementBalance], ['c-unb', u.unbilled], ['c-inst', u.installmentRemaining],
    ['c-pend', u.pendingAuth], ['c-rem', Math.max(0, u.remaining)]].filter(s => s[1] > 0);
  const denom = Math.max(u.activeLimit, segs.reduce((n, s) => n + s[1], 0)) || 1;
  const pct = v => (v / denom * 100).toFixed(2) + '%';
  return `<div class="ccu-bar${u.overLimit ? ' over' : ''}">${segs.map(s => `<div class="ccu-seg ${s[0]}" style="width:${pct(s[1])}"></div>`).join('')}
    ${u.overLimit ? `<div class="ccu-limit-mark" style="left:${pct(u.activeLimit)}"></div>` : ''}</div>`;
}

let ccLastSeries = [];

function ccSeriesHTML(series) {
  const live = series.filter(s => !s.closed && s.xMax < s.y);
  const closed = series.filter(s => s.closed && s.xMax < s.y);
  if (!live.length && !closed.length) return '';
  const key = s => escJsAttr(s.key);
  return `<div class="chart-card"><div class="chart-card-title">Cicilan Aktif (${live.length})</div>${live.map(s => `
    <div class="ccu-series">
      <div class="ccu-series-t">${esc(s.name)} · KE ${s.xMax}/${s.y} · ${fRp(s.amount)}/bln</div>
      <div class="ccu-muted">Sisa ${fRp(s.remaining)} · berikutnya KE ${s.nextX} ≈ ${fRp(s.nextAmount)}</div>
      ${s.stale ? `<span class="ccu-flag">Belum dicatat sejak ${esc(ccShortDate(s.lastDate))}</span>` : ''}
      ${s.ambiguous ? '<span class="ccu-flag">Nama ganda</span>' : ''}
      <div class="ccu-series-actions">
        <button class="ccu-link" onclick="ccUsageRecordNext('${key(s)}')">Record next</button>
        <button class="ccu-link" onclick="ccUsageMarkPaidOff('${key(s)}')">Mark paid off</button>
      </div>
    </div>`).join('')}
    ${closed.length ? `<details class="ccu-closed"><summary>Lunas lebih awal (${closed.length})</summary>${closed.map(s => `
      <div class="ccu-series"><div class="ccu-series-t">${esc(s.name)} · KE ${s.xMax}/${s.y}</div>
        <div class="ccu-series-actions"><button class="ccu-link" onclick="ccUsageRestoreSeries('${key(s)}')">Restore</button></div></div>`).join('')}</details>` : ''}
  </div>`;
}

// Opens the add-transaction sheet for the next installment of a series (name, card and category carried over).
function ccUsageRecordNext(key) {
  const s = ccLastSeries.find(x => x.key === key);
  if (!s) return;
  const label = `CICILAN KE ${s.nextX} DARI ${s.y}`;
  openInputOverlayPrefilled({
    tx: s.name === 'CICILAN' ? label : `${s.name} ${label}`,
    amount: s.nextAmount, cat: s.cat, pm: s.pm,
    notes: s.principal ? `[pokok:${s.principal}]` : ''
  });
}

async function ccUsageSetSeriesClosed(key, closed) {
  const g = ccSelectedGroup();
  if (!g) return;
  const ok = await mutateCCGroups(groups => groups.map(x => (x.id !== g.id ? x : {
    ...x, closedSeries: closed ? [...new Set([...x.closedSeries, key])] : x.closedSeries.filter(k => k !== key)
  })));
  if (!ok) return;
  renderCCUsage();
  showToast(closed ? 'Marked as paid off' : 'Restored', 'success');
}

function ccUsageMarkPaidOff(key) {
  const s = ccLastSeries.find(x => x.key === key);
  if (!s || !confirm(`Mark "${s.name}" as paid off? Its remaining ${fRp(s.remaining)} is released from your limit.`)) return;
  ccUsageSetSeriesClosed(key, true);
}

function ccUsageRestoreSeries(key) { ccUsageSetSeriesClosed(key, false); }

function renderCCUsage() {
  const box = document.getElementById('ccUsageContainer');
  if (!box) return;
  // Delegated, so it survives innerHTML rebuilds; bound once.
  if (!box.dataset.tapBound) { box.dataset.tapBound = '1'; attachTxTapToEdit(box); }
  const pms = ccCardPMs();
  if (!pms.length && !CC_GROUPS.length) {
    box.innerHTML = `<div class="empty-state">No credit cards yet. Mark a payment method as Credit Card in Settings.
      <div style="margin-top:12px"><button class="ccu-link" onclick="switchTabFromMore('settings')">Open Settings</button></div></div>`;
    return;
  }
  if (!CC_GROUPS.length) {
    box.innerHTML = `<div class="empty-state">Create a CC group to track your combined limit.
      <div style="margin-top:12px"><button class="ccu-link" onclick="openCCGroupOverlay(null)">+ New group</button></div></div>`;
    return;
  }
  if (!histLoaded) {
    box.innerHTML = '<div class="chart-loading">Loading…</div>';
    if (!ccWaitingHist) { ccWaitingHist = true; onHistLoaded(() => { ccWaitingHist = false; renderCCUsage(); }); }
    return;
  }

  const g = ccSelectedGroup();
  const bdByPm = {};
  pms.forEach(p => { bdByPm[ccLc(p.name)] = getCCBillingDate(p.name); });
  const pmSet = new Set(g.pms.map(ccLc));
  const rows = collectCCRows(pmSet);
  const u = CCUsageCore.computeCCUsage(g, rows, todayISO(), bdByPm);
  ccLastSeries = u.series;

  const selector = CC_GROUPS.length > 1
    ? `<div class="pill-toggle">${CC_GROUPS.map(x =>
        `<div class="pill-toggle-btn expense${x.id === g.id ? ' active' : ''}" onclick="ccUsageSelect('${escJsAttr(x.id)}')">${esc(x.name)}</div>`).join('')}</div>`
    : '';
  const neg = n => '−' + fRp(n);
  const period = u.cycles.length === 0 ? '–'
    : (u.sameCycle ? `${esc(ccShortDate(u.cycles[0].start))} – ${esc(ccShortDate(u.cycles[0].end))}`
      : u.cycles.map(c => `<div class="ccu-muted">${esc(c.pm)}: ${esc(ccShortDate(c.start))} – ${esc(ccShortDate(c.end))}</div>`).join(''));

  const limitCard = `<div class="chart-card">
      <div class="chart-card-title">${esc(g.name)} · ${u.overLimit ? 'Melebihi limit' : 'Sisa Kredit Limit'}</div>
      <div class="ccu-top"><div class="ccu-remaining${u.overLimit ? ' neg' : ''}">${u.overLimit ? neg(-u.remaining) : fRp(u.remaining)}</div>
        <div class="ccu-muted">of ${fRp(u.activeLimit)}</div></div>
      <div class="ccu-limit">Limit Gabungan${u.tempActive ? ` <span class="ccu-badge-temp">Limit sementara s/d ${esc(ccShortDate(g.tempLimitExpiry))}</span>` : ''}</div>
      ${u.tempActive ? `<div class="ccu-muted">Limit tetap ${fRp(g.permanentLimit)}</div>` : ''}
      ${u.tempExpired ? `<div class="ccu-muted">Limit sementara berakhir ${esc(isoDisp(g.tempLimitExpiry))} — kembali ke limit tetap</div>` : ''}
      ${ccBarHTML(u)}
      ${ccRow('c-stmt', 'Tagihan Baru', fRp(u.statementBalance))}
      ${ccRow('c-unb', 'Transaksi Berjalan', fRp(u.unbilled))}
      ${ccRow('c-inst', 'Sisa Tagihan Cicilan', fRp(u.installmentRemaining))}
      ${u.pendingAuth > 0 ? ccRow('c-pend', 'Otorisasi Menggantung', fRp(u.pendingAuth), g.pendingAuthDate ? `· updated ${esc(ccShortDate(g.pendingAuthDate))}` : '') : ''}
      ${u.overpayment > 0 ? ccRow('c-over', 'Kelebihan Bayar', neg(u.overpayment)) : ''}
      ${ccRow('c-rem', u.overLimit ? 'Melebihi limit' : 'Sisa Kredit Limit', u.overLimit ? neg(-u.remaining) : fRp(u.remaining))}
      ${u.missingPms.length ? `<div class="ccu-warn">Kartu tidak ditemukan: ${esc(u.missingPms.join(', '))}</div>` : ''}
    </div>
    <div class="summary-row">
      <div class="summary-card"><div class="s-label">Pemakaian periode ini</div><div class="s-value">${fRp(u.cycleSpend)}</div></div>
      <div class="summary-card"><div class="s-label">Periode</div><div class="s-value ccu-period">${period}</div></div>
    </div>`;

  // Transaction list for the chosen cycle (each card's own cycle, so mixed billing days stay correct).
  const off = ccUsageCycleOffset;
  const listRows = u.cycles.flatMap(c => CCUsageCore.cycleRowsFor(rows.filter(r => ccLc(r.pm) === ccLc(c.pm)), bdByPm, c.idx + off));
  const items = ccListItems(listRows);
  const creditSet = ccCreditKeys(items, pmSet);
  const refIdx = u.cycles.length ? u.cycles[0].idx + off : 0;
  const label = u.cycles.length ? `Siklus ${MO[refIdx % 12]} ${Math.floor(refIdx / 12)}` : '';
  const listCard = `<div class="chart-card">
      <div class="ccu-list-head"><div class="chart-card-title" style="margin:0">Transaksi Periode Ini (${items.length})</div>
        <div class="ccu-nav"><button onclick="ccUsageShiftCycle(-1)" ${off <= -36 ? 'disabled' : ''}>‹</button><span>${esc(label)}</span><button onclick="ccUsageShiftCycle(1)" ${off >= 0 ? 'disabled' : ''}>›</button></div></div>
      ${items.length ? items.map(it => renderTxItemHTML(it, '', { creditSet })).join('') : '<div class="empty-state">Belum ada transaksi di periode ini.</div>'}
    </div>`;

  box.innerHTML = `
    <div class="ccu-actions">
      <button class="ccu-link" onclick="openCCGroupOverlay(null)">+ New group</button>
      <button class="ccu-link" onclick="openCCGroupOverlay('${escJsAttr(g.id)}')">Edit group</button>
    </div>
    ${selector}
    <div class="ccu-grid"><div class="ccu-col">${limitCard}${ccSeriesHTML(u.series)}</div><div class="ccu-col">${listCard}</div></div>`;
}

// ── Group overlay ─────────────────────────────────────────────
function ccgSetDate(prefix, iso) {
  document.getElementById(prefix + 'Raw').value = iso || '';
  document.getElementById(prefix + 'Text').textContent = iso ? isoDisp(iso) : 'Select date';
}

function ccgPrefillLimit() {
  const el = document.getElementById('ccgPermLimit');
  if (el.dataset.auto !== '1') return;
  const ticked = [...document.querySelectorAll('#ccgCards input:checked')].map(c => c.value.toLowerCase());
  const max = Math.max(0, ...ccCardPMs().filter(p => ticked.includes(p.name.toLowerCase())).map(p => p.creditLimit || 0));
  el.value = max ? formatGroupedAmt(max) : '';
}

function openCCGroupOverlay(id) {
  ccgEditId = id || null;
  const g = id ? CC_GROUPS.find(x => x.id === id) : null;
  document.getElementById('ccgTitle').textContent = g ? 'Edit CC group' : 'New CC group';
  document.getElementById('ccgDeleteBtn').style.display = g ? 'block' : 'none';
  document.getElementById('ccgName').value = g ? g.name : '';
  const perm = document.getElementById('ccgPermLimit');
  perm.value = g ? formatGroupedAmt(g.permanentLimit) : '';
  perm.dataset.auto = g ? '0' : '1';
  document.getElementById('ccgTempLimit').value = g && g.tempLimit ? formatGroupedAmt(g.tempLimit) : '';
  ccgSetDate('ccgTempExpiry', g ? g.tempLimitExpiry : '');
  ccgSetDate('ccgAnchorDate', g ? g.anchorDate : '');
  document.getElementById('ccgAnchorAmt').value = g && g.anchorOutstanding !== null ? formatGroupedAmt(g.anchorOutstanding) : '';
  document.getElementById('ccgPending').value = g && g.pendingAuth ? formatGroupedAmt(g.pendingAuth) : '';

  const mine = g ? g.pms.map(p => p.toLowerCase()) : [];
  const owner = {};
  CC_GROUPS.filter(x => x.id !== ccgEditId).forEach(x => x.pms.forEach(p => { owner[p.toLowerCase()] = x.name; }));
  const rows = ccCardPMs().map(p => {
    const k = p.name.toLowerCase();
    const sub = owner[k] ? `in "${esc(owner[k])}"` : (p.billingDate > 0 ? `cetak tgl ${p.billingDate}` : 'no billing date (calendar month)');
    return `<label class="goal-source-row"><input type="checkbox" value="${esc(p.name)}" ${mine.includes(k) ? 'checked' : ''} ${owner[k] ? 'disabled' : ''} onchange="ccgPrefillLimit()">
      <span style="font-size:14px">${esc(p.name)} <span class="ccu-muted">· ${sub}</span></span></label>`;
  });
  // A linked card that is no longer a credit card stays visible so it can be unticked.
  const listed = new Set(ccCardPMs().map(p => p.name.toLowerCase()));
  mine.filter(k => !listed.has(k)).forEach(k => {
    const name = g.pms.find(p => p.toLowerCase() === k);
    rows.push(`<label class="goal-source-row"><input type="checkbox" value="${esc(name)}" checked onchange="ccgPrefillLimit()">
      <span style="font-size:14px">${esc(name)} <span class="ccu-muted">· not a credit card now</span></span></label>`);
  });
  document.getElementById('ccgCards').innerHTML = rows.join('') || '<div class="ccu-muted">No credit cards yet.</div>';

  document.getElementById('ccGroupOverlay').classList.add('open');
  adjustOverlayForVisualViewport();
}

function closeCCGroupOverlay() {
  const ov = document.getElementById('ccGroupOverlay');
  if (!ov) return;
  ov.classList.remove('open');
  ov.style.top = '';
  ov.style.height = '';
}

async function saveCCGroup() {
  if (ccgSaving) return;
  const bad = msg => showToast(msg, 'error');
  const today = todayISO();
  const name = document.getElementById('ccgName').value.trim();
  const pms = [...document.querySelectorAll('#ccgCards input:checked')].map(c => c.value);
  const permanentLimit = parseAmt('ccgPermLimit');
  const tempRaw = parseAmt('ccgTempLimit');
  const tempExpiry = document.getElementById('ccgTempExpiryRaw').value;
  const anchorDate = document.getElementById('ccgAnchorDateRaw').value;
  const anchorRaw = document.getElementById('ccgAnchorAmt').value.trim();
  const pendingAuth = parseAmt('ccgPending');
  if (!name) return bad('Group name is required');
  if (name.length > 40) return bad('Group name is too long (max 40)');
  if (!pms.length) return bad('Pick at least 1 card');
  if (!(permanentLimit > 0)) return bad('Permanent limit must be above 0');
  if (!!tempRaw !== !!tempExpiry) return bad('Temporary limit and its expiry date go together');
  if (!!anchorRaw !== !!anchorDate) return bad('Opening balance needs both a date and an amount');
  if (anchorDate && anchorDate > today) return bad('Opening balance date cannot be in the future');
  if (pendingAuth < 0) return bad('Pending holds cannot be negative');

  ccgSaving = true;
  showToast('Saving…', 'loading');
  let problem = '';
  let savedId = ccgEditId;
  const ok = await mutateCCGroups(groups => {
    const others = groups.filter(x => x.id !== ccgEditId);
    if (others.some(x => x.name.toLowerCase() === name.toLowerCase())) { problem = 'A group with that name already exists'; return null; }
    const taken = others.flatMap(x => x.pms.map(p => p.toLowerCase()));
    const clash = pms.find(p => taken.includes(p.toLowerCase()));
    if (clash) { problem = `${clash} is already in another group`; return null; }
    const old = groups.find(x => x.id === ccgEditId);
    const pendingChanged = !old || old.pendingAuth !== pendingAuth;
    const next = {
      id: old ? old.id : `ccg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name, pms, permanentLimit,
      tempLimit: tempRaw || null, tempLimitExpiry: tempRaw ? tempExpiry : null,
      anchorDate: anchorDate || null, anchorOutstanding: anchorDate ? parseAmt('ccgAnchorAmt') : null,
      pendingAuth,
      pendingAuthDate: !pendingAuth ? null : (pendingChanged ? today : old.pendingAuthDate),
      closedSeries: old ? old.closedSeries : [],
      sortOrder: old ? old.sortOrder : Math.max(-1, ...groups.map(x => x.sortOrder)) + 1,
      updatedAt: new Date().toISOString()
    };
    savedId = next.id;
    return old ? groups.map(x => (x.id === old.id ? next : x)) : [...groups, next];
  });
  ccgSaving = false;
  if (!ok) return; // mutateCCGroups already toasted
  if (problem) { showToast(problem, 'error'); return; }
  ccUsageSelect(savedId);
  closeCCGroupOverlay();
  const expired = tempRaw && tempExpiry < today;
  showToast(expired ? 'Saved ✓ (temporary limit already expired, so it is not applied)' : 'Saved ✓', 'success');
}

async function deleteCCGroup() {
  const g = CC_GROUPS.find(x => x.id === ccgEditId);
  if (!g || !confirm(`Delete group "${g.name}"? Transactions are not affected.`)) return;
  showToast('Saving…', 'loading');
  const ok = await mutateCCGroups(groups => groups.filter(x => x.id !== g.id));
  if (!ok) return;
  closeCCGroupOverlay();
  renderCCUsage();
  showToast('Group deleted', 'success');
}
