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
        dueDay: Number.isInteger(+g.dueDay) && +g.dueDay >= 1 && +g.dueDay <= 31 ? +g.dueDay : 0,
        interestRate: num(g.interestRate) > 0 && num(g.interestRate) <= 20 ? num(g.interestRate) : 0,
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

// ── Module state, all in one place (CC_GROUPS above is the groups: the server is the source, localStorage a cache)
const CC_SEL_LS_KEY = 'notapub_ccusage_sel';
let ccUsageSelectedId = '';   // selected group id, remembered per device
try { ccUsageSelectedId = localStorage.getItem(CC_SEL_LS_KEY) || ''; } catch (e) {}
let ccUsageCycleOffset = 0;   // 0 = current billing cycle, -1 = previous, ...
let ccSelCat = '';            // category picked on the donut ('' = all transactions, CCUsageCore.INST_KEY = installments)
let ccWaitingHist = false;    // a render is already waiting for the history load
let ccgEditId = null;         // group open in the overlay (null = a new one)
let ccgSaving = false;        // a group save or delete is in flight
let ccGroupsSeq = 0;          // bumped by every write, so a slow read that started before a save cannot overwrite it

// Returns the fresh normalized groups, or null when the server could not be read.
async function fetchCCGroupsRaw(timeoutMs) {
  try {
    const res = await fetchWithTimeout(apiGet('type=ccgroups'), { method: 'GET' }, timeoutMs);
    const j = await res.json();
    if (j.status !== 'ok') { console.warn('[cc-usage] load failed', j.message); return null; }
    return normalizeCCGroups(j.groups);
  } catch (e) { console.warn('[cc-usage] load error', e.message); return null; }
}

async function fetchCCGroups() {
  const seq = ccGroupsSeq;
  const fresh = await fetchCCGroupsRaw();
  if (!fresh || seq !== ccGroupsSeq) return false; // keep the cache (failed read, or a save happened meanwhile)
  CC_GROUPS = fresh;
  writeCCGroupsCache();
  return true;
}

// The only write path: re-read the sheet, apply fn to a copy, save the whole list.
// fn returns the new array, or null for "nothing to change" (no write, so the tab is never created needlessly).
// It takes two to three sheet calls, so it gets a longer timeout than the default (a timeout can mean the write landed).
async function mutateCCGroups(fn) {
  ccGroupsSeq++;
  const fresh = await fetchCCGroupsRaw(15000);
  if (!fresh) { showToast("Couldn't reach Google Sheets — try again", 'error'); return false; }
  const changed = fn(JSON.parse(JSON.stringify(fresh)));
  if (changed === null) { CC_GROUPS = fresh; writeCCGroupsCache(); return true; }
  const next = normalizeCCGroups(changed);
  try {
    const res = await fetchWithTimeout(apiGet('type=ccgroups'), {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: apiBody({ type: 'ccgroups', action: 'saveAll', groups: next })
    }, 15000);
    const j = await res.json();
    if (j.status !== 'ok') { showToast('Could not save CC groups: ' + (j.message || 'error'), 'error'); return false; }
  } catch (e) { showToast('Could not save CC groups: ' + e.message, 'error'); return false; }
  CC_GROUPS = next;
  writeCCGroupsCache();
  return true;
}

// Called from saveConfigItem when a payment method is renamed. Failure only toasts; nothing else depends on it.
// Earlier transactions keep the old name, so after a rename CC Usage only counts rows from the new name on.
async function ccGroupsRenamePM(oldName, newName) {
  const o = oldName.toLowerCase();
  let renamed = false;
  const ok = await mutateCCGroups(groups => {
    if (!groups.some(g => g.pms.some(p => p.toLowerCase() === o))) return null;
    renamed = true;
    return groups.map(g => ({ ...g, pms: g.pms.map(p => (p.toLowerCase() === o ? newName : p)) }));
  });
  if (ok && renamed) showToast(`Renamed in CC Usage. Earlier transactions still say "${oldName}" and are not counted any more.`, '', 7000);
  return ok;
}

// ── Page: selection, render ───────────────────────────────────
const ccCardPMs = () => CONFIG_ITEMS.filter(i => i.kind === 'pm' && i.creditCard && !i.archived);
const ccShortDate = iso => isoDisp(iso).split(' ').slice(0, 2).join(' ');

// The group a payment method belongs to (case-insensitive), or null.
function ccGroupForPM(name) {
  const k = String(name || '').toLowerCase();
  return CC_GROUPS.find(g => g.pms.some(p => p.toLowerCase() === k)) || null;
}

// Billing day for every card the group lists that still exists (archived or un-flagged ones too, so their
// rows stay in the cycle maths). A name that exists nowhere is left out and reported as missing.
function ccBdByPm(g) {
  const out = {};
  g.pms.forEach(name => {
    const item = CONFIG_ITEMS.find(i => i.kind === 'pm' && ccLc(i.name) === ccLc(name));
    if (item) out[ccLc(name)] = Number(item.billingDate) || 0;
  });
  return out;
}

function ccSelectedGroup() {
  return CC_GROUPS.find(g => g.id === ccUsageSelectedId) || CC_GROUPS[0] || null;
}

function ccUsageSelect(id) {
  ccUsageSelectedId = id;
  ccUsageCycleOffset = 0;
  ccSelCat = '';
  try { localStorage.setItem(CC_SEL_LS_KEY, id); } catch (e) {}
  renderCCUsage();
}

// ── Rows from Nota's data ─────────────────────────────────────
const ccLc = s => String(s || '').toLowerCase();
const ccIso = (y, m0, d) => `${y}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const ccRowIso = r => (r.date ? String(r.date).slice(0, 10) : ccIso(r.y, r.m, r.d));

// The group's rows for the core, read from Nota's data (see CCUsageCore.normalizeRows).
function collectCCRows(pmSet) {
  return CCUsageCore.normalizeRows({ histOpex: HIST.opex || [], txHistory: txHistory || [], pmSet, today: todayISO() });
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
function openCCUsagePage() {
  ccUsageCycleOffset = 0;
  ccSelCat = '';
  renderCCUsage();
  fetchCCGroups().then(renderCCUsage);
}

function renderCCUsageIfActive() {
  const page = document.getElementById('page-ccusage');
  if (page && page.classList.contains('active')) renderCCUsage();
}

function ccUsageShiftCycle(d) {
  ccUsageCycleOffset = Math.min(0, Math.max(-36, ccUsageCycleOffset + d));
  ccSelCat = '';
  renderCCUsage();
}

function ccRow(cls, label, value, sub) {
  return `<div class="ccu-row"><span class="ccu-dot ${cls}"></span>
    <span class="ccu-row-l">${label}${sub ? ` <span class="ccu-muted">${sub}</span>` : ''}</span><span class="ccu-row-v">${value}</span></div>`;
}

function ccBarHTML(u) {
  const segs = [['c-stmt', u.statementBalance], ['c-unb', u.unbilled], ['c-int', u.interest.amount], ['c-inst', u.installmentRemaining],
    ['c-pend', u.pendingAuth], ['c-rem', Math.max(0, u.remaining)]].filter(s => s[1] > 0);
  const denom = Math.max(u.activeLimit, segs.reduce((n, s) => n + s[1], 0)) || 1;
  const pct = v => (v / denom * 100).toFixed(2) + '%';
  return `<div class="ccu-bar${u.overLimit ? ' over' : ''}">${segs.map(s => `<div class="ccu-seg ${s[0]}" style="width:${pct(s[1])}"></div>`).join('')}
    ${u.overLimit ? `<div class="ccu-limit-mark" style="left:${pct(u.activeLimit)}"></div>` : ''}</div>`;
}

// Tapping the picked slice again goes back to all transactions.
function ccSelectCat(key) { ccSelCat = ccSelCat === key ? '' : key; renderCCUsage(); }

const ccRowCycle = (r, bdByPm) => CCUsageCore.cycleIdx(+r.date.slice(0, 4), +r.date.slice(5, 7) - 1, +r.date.slice(8, 10),
  CCUsageCore.bdEff(bdByPm[ccLc(r.pm)] || 0));

// Detail view of the Installments slice: what was paid in the shown cycle per installment, and (current cycle only)
// what remains. Shown instead of the transaction list while that slice is picked.
function ccInstallmentsHTML(u, off, bdByPm, anchorDate) {
  const idxByPm = {};
  u.cycles.forEach(c => { idxByPm[ccLc(c.pm)] = c.idx + off; });
  const views = u.series.map(s => {
    const inCycle = s.entries.filter(e => ccRowCycle(e.row, bdByPm) === idxByPm[ccLc(e.row.pm)]
      && !(off === 0 && anchorDate && e.row.date <= anchorDate));
    return { s, paid: inCycle.reduce((n, e) => n + e.row.amount, 0), last: inCycle.length ? inCycle[inCycle.length - 1] : null };
  }).filter(v => v.paid > 0 || (off === 0 && !v.s.closed && v.s.remaining > 0));
  if (!views.length) return { html: '', paid: 0, count: 0 };
  views.sort((a, b) => (off === 0 ? b.s.remaining - a.s.remaining : 0) || b.paid - a.paid);
  const paid = views.reduce((n, v) => n + v.paid, 0);
  const rowsHtml = views.map(v => {
    const s = v.s, x = v.last ? v.last.x : s.xMax, amt = v.last ? v.last.row.amount : s.amount;
    const finished = off === 0 && s.xMax >= s.y;
    const remaining = off === 0 ? `<span class="ccu-rem">Remaining ${fRp(s.remaining)}${s.xMax < s.y ? ` · next #${s.nextX}` : ''}</span>` : '';
    return `<div class="ccu-irow">
      <div class="ccu-irow-t">${esc(s.name)} · #${x}/${s.y} · ${fRp(amt)}/mo${finished ? '<span class="ccu-done">done</span>' : ''}</div>
      ${s.note ? `<div class="ccu-note">${esc(s.note)}</div>` : ''}
      <div class="ccu-two"><span class="ccu-paid">${v.paid ? `Paid ${fRp(v.paid)}` : 'Paid –'}</span>${remaining}</div>
      ${off === 0 && s.stale ? `<span class="ccu-flag">Not recorded since ${esc(ccShortDate(s.lastDate))}</span>` : ''}
    </div>`;
  }).join('');
  // Only when nothing netted off the spending (an overpayment would make the two figures differ).
  const recon = off === 0 && u.unbilled === u.cycleSpend
    ? `<div class="ccu-muted ccu-recon">Standalone ${fRp(u.cycleSpend - paid)} + installments ${fRp(paid)} = Current Spending ${fRp(u.unbilled)}</div>` : '';
  return { html: `<div class="ccu-strip-body ccu-inst-detail">${rowsHtml}${recon}</div>`, paid, count: views.length };
}

function ccEmptyStateHTML(message, buttonLabel, onclick) {
  return `<div class="empty-state">${message}
      <div style="margin-top:12px"><button class="ccu-link" onclick="${onclick}">${buttonLabel}</button></div></div>`;
}

function ccSelectorHTML(g) {
  if (CC_GROUPS.length < 2) return '';
  return `<div class="pill-toggle">${CC_GROUPS.map(x =>
    `<div class="ccu-pill${x.id === g.id ? ' active' : ''}" onclick="ccUsageSelect('${escJsAttr(x.id)}')">${esc(x.name)}</div>`).join('')}</div>`;
}

// Top card: the split headline, the bar and the two bucket rows (+ pending holds / overpayment when there are any).
function ccLimitCardHTML(g, u) {
  const neg = n => '−' + fRp(n);
  const range = c => `${esc(ccShortDate(c.start))} – ${esc(ccShortDate(c.end))}`;
  const periodNote = u.cycles.length && u.sameCycle ? ` · this billing period ${range(u.cycles[0])}` : '';
  const periodLines = u.cycles.length && !u.sameCycle
    ? u.cycles.map(c => `<div class="ccu-muted">${esc(c.pm)}: ${range(c)}</div>`).join('') : '';
  return `<div class="chart-card">
      <div class="chart-card-title">${esc(g.name)}</div>
      <div class="ccu-split">
        <div class="ccu-half"><div class="ccu-muted">${u.overLimit ? 'Over limit' : 'Remaining limit'}</div>
          <div class="ccu-big ${u.overLimit ? 'neg' : 'pos'}">${u.overLimit ? neg(-u.remaining) : fRp(u.remaining)}</div><div class="ccu-ul ${u.overLimit ? 'neg' : 'pos'}"></div></div>
        <div class="ccu-half"><div class="ccu-muted">Total to Pay</div>
          <div class="ccu-big pay">${fRp(u.statementBalance + u.unbilled + u.interest.amount)}</div><div class="ccu-ul pay"></div></div>
      </div>
      <div class="ccu-muted ccu-period-note">of ${fRp(u.activeLimit)} combined limit${periodNote}</div>
      ${periodLines}
      ${u.tempActive ? `<div class="ccu-limit"><span class="ccu-badge-temp">Temporary limit until ${esc(ccShortDate(g.tempLimitExpiry))}</span><span class="ccu-muted">Permanent limit ${fRp(g.permanentLimit)}</span></div>` : ''}
      ${u.tempExpired ? `<div class="ccu-muted">Temporary limit ended ${esc(isoDisp(g.tempLimitExpiry))}: back to the permanent limit</div>` : ''}
      ${ccBarHTML(u)}
      ${ccRow('c-stmt', 'Unpaid Statement', fRp(u.statementBalance))}
      ${u.interest.state === 'pending' && u.statementBalance > 0 ? `<div class="ccu-hint">Pay this in full by ${esc(ccShortDate(u.interest.due))} to avoid interest</div>` : ''}
      ${ccRow('c-unb', 'Current Spending', fRp(u.unbilled))}
      ${u.interest.state === 'lost' ? ccRow('c-int', 'Estimated Interest', fRp(u.interest.amount), `· to ${esc(ccShortDate(todayISO()))}`) + `<div class="ccu-hint muted">Statement not paid in full by ${esc(ccShortDate(u.interest.due))}. An estimate, the bank's figure will differ a little. Record the bank's interest row to replace it.</div>` : ''}
      ${ccRow('c-inst', 'Remaining Installments', fRp(u.installmentRemaining))}
      ${u.pendingAuth > 0 ? ccRow('c-pend', 'Pending Holds', fRp(u.pendingAuth), g.pendingAuthDate ? `· updated ${esc(ccShortDate(g.pendingAuthDate))}` : '') : ''}
      ${u.overpayment > 0 ? ccRow('c-over', 'Overpayment', neg(u.overpayment)) : ''}
      ${u.missingPms.length ? `<div class="ccu-warn">Cards not found: ${esc(u.missingPms.join(', '))}</div>` : ''}
    </div>`;
}

const ccCatLabel = key => (key === CCUsageCore.INST_KEY ? 'Installments' : key);
const ccCatColor = key => (key === CCUsageCore.INST_KEY ? '#a78bfa' : (CAT_COLORS[key] || CAT_COLORS.Other || '#888780'));

// Donut: one circle per slice (tap to pick), the others dim while one is picked, the centre shows the total or the pick.
function ccDonutHTML(slices, sel) {
  const total = slices.reduce((n, s) => n + s.amount, 0), r = 46, circ = 2 * Math.PI * r;
  let off = 0;
  const arcs = slices.map(s => {
    const d = s.amount / total * circ;
    const c = `<circle cx="56" cy="56" r="${r}" fill="none" stroke="${ccCatColor(s.key)}" stroke-width="16" stroke-dasharray="${d} ${circ - d}" stroke-dashoffset="${-off}" opacity="${sel && sel !== s.key ? 0.3 : 1}" style="cursor:pointer" onclick="ccSelectCat('${escJsAttr(s.key)}')"/>`;
    off += d;
    return c;
  }).join('');
  const picked = sel ? slices.find(s => s.key === sel) : null;
  const name = picked ? ccCatLabel(picked.key) : 'Spending';
  const amt = fRpS(picked ? picked.amount : total);
  const fs = Math.min(11, +(70 / (amt.length * 0.58)).toFixed(1));
  return `<svg viewBox="0 0 112 112" class="ccu-donut" role="img" aria-label="Spending by category">
    <circle cx="56" cy="56" r="${r}" fill="none" stroke="var(--bg3)" stroke-width="16"/>
    <g transform="rotate(-90 56 56)">${arcs}</g>
    <text x="56" y="52" text-anchor="middle" font-size="8" fill="var(--text2)">${esc(name.length > 14 ? name.slice(0, 13) + '…' : name)}</text>
    <text x="56" y="65" text-anchor="middle" font-size="${fs}" font-weight="700" fill="var(--text)">${amt}</text>
  </svg>`;
}

function ccLegendHTML(slices, sel) {
  const total = slices.reduce((n, s) => n + s.amount, 0);
  return slices.map(s => {
    const p = s.amount / total * 100;
    return `<div class="legend-row${sel === s.key ? ' active' : ''}" onclick="ccSelectCat('${escJsAttr(s.key)}')">
      <div class="legend-dot" style="background:${ccCatColor(s.key)}"></div>
      <div class="legend-name">${esc(ccCatLabel(s.key))}</div>
      <div class="legend-pct">${p < 1 ? '<1' : Math.round(p)}%</div></div>`;
  }).join('');
}

// Two cards for the chosen cycle (each card's own cycle, so mixed billing days stay correct):
// `cat` = the donut by category with the cycle navigation, `list` = the transactions it picks. Nothing picked =
// every transaction of the cycle, a category = that category's charges, Installments = the per-installment detail.
// On a phone the two sit under each other as one card (CSS); on the wide layout they go in different columns.
function ccCycleCardsHTML(g, u, rows, bdByPm, pmSet) {
  const off = ccUsageCycleOffset;
  const instRows = new Set(u.series.flatMap(s => s.entries.map(e => e.row)));
  const instKeys = new Set([...instRows].map(r => `${r.ref.source}:${r.ref.idx}`));
  const cycleRows = u.cycles.flatMap(c => CCUsageCore.cycleRowsFor(rows.filter(r => ccLc(r.pm) === ccLc(c.pm)), bdByPm, c.idx + off));
  const slices = CCUsageCore.categoryTotals(cycleRows, r => instRows.has(r));
  if (ccSelCat && !slices.some(s => s.key === ccSelCat)) ccSelCat = '';
  const items = ccListItems(cycleRows);
  const creditSet = ccCreditKeys(items, pmSet);
  const keyOf = it => `${it.source}:${it.idx}`;
  const catOf = it => (it.row.cat || it.row.category || '') || 'Uncategorized';
  const showInst = ccSelCat === CCUsageCore.INST_KEY;
  const inst = showInst ? ccInstallmentsHTML(u, off, bdByPm, g.anchorDate) : null;
  const shown = !ccSelCat ? items
    : showInst ? []
    : items.filter(it => !creditSet.has(keyOf(it)) && !instKeys.has(keyOf(it)) && catOf(it) === ccSelCat);
  const count = showInst ? inst.count : shown.length;
  const title = ccSelCat ? ccCatLabel(ccSelCat) : 'Transactions';
  const chip = ccSelCat ? `<span class="ccu-fchip" onclick="ccSelectCat('${escJsAttr(ccSelCat)}')">${esc(ccCatLabel(ccSelCat))} ✕</span>` : '';
  const refIdx = u.cycles.length ? u.cycles[0].idx + off : 0;
  const label = u.cycles.length ? `Cycle ${MO[refIdx % 12]} ${Math.floor(refIdx / 12)}` : '';
  const body = showInst ? (inst.html || '<div class="empty-state">No installments in this period.</div>')
    : shown.length ? shown.map(it => renderTxItemHTML(it, '', { creditSet, hidePm: true })).join('')
    : '<div class="empty-state">No transactions in this period.</div>';
  const cat = `<div class="chart-card ccu-cat-card">
      <div class="ccu-list-head" style="margin-bottom:${slices.length ? 12 : 0}px"><div class="chart-card-title" style="margin:0">By category</div>
        <div class="ccu-nav"><button onclick="ccUsageShiftCycle(-1)" ${off <= -36 ? 'disabled' : ''}>‹</button><span>${esc(label)}</span><button onclick="ccUsageShiftCycle(1)" ${off >= 0 ? 'disabled' : ''}>›</button></div></div>
      ${slices.length ? `<div class="ccu-donut-wrap">${ccDonutHTML(slices, ccSelCat)}<div class="ccu-legend">${ccLegendHTML(slices, ccSelCat)}</div></div>` : '<div class="ccu-muted" style="margin-top:8px">No spending in this period.</div>'}
    </div>`;
  const list = `<div class="chart-card ccu-list-card">
      <div class="ccu-list-head ccu-sub"><div class="ccu-sub-title">${esc(title)} (${count})</div>${chip}</div>
      ${body}
    </div>`;
  return { cat, list };
}

function renderCCUsage() {
  const box = document.getElementById('ccUsageContainer');
  if (!box) return;
  // Delegated, so it survives innerHTML rebuilds; bound once.
  if (!box.dataset.tapBound) { box.dataset.tapBound = '1'; attachTxTapToEdit(box); }
  if (!ccCardPMs().length && !CC_GROUPS.length) {
    box.innerHTML = ccEmptyStateHTML('No credit cards yet. Mark a payment method as Credit Card in Settings.', 'Open Settings', "switchTabFromMore('settings')");
    return;
  }
  if (!CC_GROUPS.length) {
    box.innerHTML = ccEmptyStateHTML('Create a CC group to track your combined limit.', '+ New group', 'openCCGroupOverlay(null)');
    return;
  }
  if (!histLoaded) {
    box.innerHTML = '<div class="chart-loading">Loading…</div>';
    if (!ccWaitingHist) { ccWaitingHist = true; onHistLoaded(() => { ccWaitingHist = false; renderCCUsage(); }); }
    return;
  }

  const g = ccSelectedGroup();
  const bdByPm = ccBdByPm(g);
  const pmSet = new Set(g.pms.map(ccLc));
  const rows = collectCCRows(pmSet);
  const u = CCUsageCore.computeCCUsage(g, rows, todayISO(), bdByPm);
  const cards = ccCycleCardsHTML(g, u, rows, bdByPm, pmSet);

  box.innerHTML = `
    <div class="ccu-actions">
      <button class="ccu-link" onclick="openCCGroupOverlay(null)">+ New group</button>
      <button class="ccu-link" onclick="openCCGroupOverlay('${escJsAttr(g.id)}')">Edit group</button>
    </div>
    ${ccSelectorHTML(g)}
    ${histLoadFailed ? '<div class="ccu-warn" style="margin:0 0 10px">The full history could not be loaded, so these numbers use cached data and may be incomplete.</div>' : ''}
    <div class="ccu-grid"><div class="ccu-col">${ccLimitCardHTML(g, u)}${cards.cat}</div><div class="ccu-col">${cards.list}</div></div>`;
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
  // BCA's usual terms are the default; clearing both turns the interest estimate off.
  document.getElementById('ccgDueDay').value = g && g.dueDay ? g.dueDay : (g && g.interestRate ? '' : 10);
  document.getElementById('ccgRate').value = g && g.interestRate ? g.interestRate : (g && g.dueDay ? '' : 1.75);

  const mine = g ? g.pms.map(p => p.toLowerCase()) : [];
  const owner = {};
  CC_GROUPS.filter(x => x.id !== ccgEditId).forEach(x => x.pms.forEach(p => { owner[p.toLowerCase()] = x.name; }));
  const rows = ccCardPMs().map(p => {
    const k = p.name.toLowerCase();
    const sub = owner[k] ? `in "${esc(owner[k])}"` : (p.billingDate > 0 ? `statement day ${p.billingDate}` : 'no billing date (calendar month)');
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
  const editId = ccgEditId; // the overlay can be closed and reopened for another group while the save is in flight
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
  const dueRaw = document.getElementById('ccgDueDay').value.trim(), rateRaw = document.getElementById('ccgRate').value.trim().replace(',', '.');
  const dueDay = dueRaw ? Number(dueRaw) : 0, interestRate = rateRaw ? Number(rateRaw) : 0;
  if (!name) return bad('Group name is required');
  if (name.length > 40) return bad('Group name is too long (max 40)');
  if (!pms.length) return bad('Pick at least 1 card');
  if (!(permanentLimit > 0)) return bad('Permanent limit must be above 0');
  if (!!tempRaw !== !!tempExpiry) return bad('Temporary limit and its expiry date go together');
  if (!!anchorRaw !== !!anchorDate) return bad('Opening balance needs both a date and an amount');
  if (anchorDate && anchorDate > today) return bad('Opening balance date cannot be in the future');
  if (pendingAuth < 0) return bad('Pending holds cannot be negative');
  if (!!dueRaw !== !!rateRaw) return bad('Payment due day and interest rate go together (clear both to turn the estimate off)');
  if (dueRaw && !(Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31)) return bad('Payment due day must be 1 to 31');
  if (rateRaw && !(interestRate > 0 && interestRate <= 20)) return bad('Interest rate must be above 0 and at most 20 % per month');
  const anchorAmount = anchorDate ? parseAmt('ccgAnchorAmt') : null;

  ccgSaving = true;
  showToast('Saving…', 'loading');
  let problem = '';
  let savedId = editId;
  let ok = false;
  try {
    ok = await mutateCCGroups(groups => {
      const others = groups.filter(x => x.id !== editId);
      if (others.some(x => x.name.toLowerCase() === name.toLowerCase())) { problem = 'A group with that name already exists'; return null; }
      const taken = others.flatMap(x => x.pms.map(p => p.toLowerCase()));
      const clash = pms.find(p => taken.includes(p.toLowerCase()));
      if (clash) { problem = `${clash} is already in another group`; return null; }
      const old = groups.find(x => x.id === editId);
      const pendingChanged = !old || old.pendingAuth !== pendingAuth;
      const next = {
        id: old ? old.id : `ccg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name, pms, permanentLimit,
        tempLimit: tempRaw || null, tempLimitExpiry: tempRaw ? tempExpiry : null,
        anchorDate: anchorDate || null, anchorOutstanding: anchorAmount,
        pendingAuth, dueDay, interestRate,
        pendingAuthDate: !pendingAuth ? null : (pendingChanged ? today : old.pendingAuthDate),
        closedSeries: old ? old.closedSeries : [],
        sortOrder: old ? old.sortOrder : Math.max(-1, ...groups.map(x => x.sortOrder)) + 1,
        updatedAt: new Date().toISOString()
      };
      savedId = next.id;
      return old ? groups.map(x => (x.id === old.id ? next : x)) : [...groups, next];
    });
  } finally {
    ccgSaving = false; // a throw inside the callback must not leave Save dead until reload
  }
  if (!ok) return; // mutateCCGroups already toasted
  if (problem) { showToast(problem, 'error'); return; }
  ccUsageSelect(savedId);
  if (ccgEditId === editId) closeCCGroupOverlay();
  const expired = tempRaw && tempExpiry < today;
  showToast(expired ? 'Saved ✓ (temporary limit already expired, so it is not applied)' : 'Saved ✓', 'success');
}

async function deleteCCGroup() {
  if (ccgSaving) return;
  const id = ccgEditId;
  const g = CC_GROUPS.find(x => x.id === id);
  if (!g || !confirm(`Delete group "${g.name}"? Transactions are not affected.`)) return;
  ccgSaving = true;
  showToast('Saving…', 'loading');
  let ok = false;
  try {
    ok = await mutateCCGroups(groups => groups.filter(x => x.id !== id));
  } finally {
    ccgSaving = false;
  }
  if (!ok) return;
  if (ccgEditId === id) closeCCGroupOverlay();
  renderCCUsage();
  showToast('Group deleted', 'success');
}
