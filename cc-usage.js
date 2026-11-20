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

function ccSelectedGroup() {
  return CC_GROUPS.find(g => g.id === ccUsageSelectedId) || CC_GROUPS[0] || null;
}

function ccUsageSelect(id) {
  ccUsageSelectedId = id;
  try { localStorage.setItem(CC_SEL_LS_KEY, id); } catch (e) {}
  renderCCUsage();
}

function renderCCUsage() {
  const box = document.getElementById('ccUsageContainer');
  if (!box) return;
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
  const g = ccSelectedGroup();
  const today = todayISO();
  const tempActive = g.tempLimit > 0 && g.tempLimitExpiry && today <= g.tempLimitExpiry;
  const tempExpired = g.tempLimit > 0 && g.tempLimitExpiry && today > g.tempLimitExpiry;
  const known = new Set(pms.map(p => p.name.toLowerCase()));
  const missing = g.pms.filter(p => !known.has(p.toLowerCase()));
  const selector = CC_GROUPS.length > 1
    ? `<div class="pill-toggle">${CC_GROUPS.map(x =>
        `<div class="pill-toggle-btn expense${x.id === g.id ? ' active' : ''}" onclick="ccUsageSelect('${escJsAttr(x.id)}')">${esc(x.name)}</div>`).join('')}</div>`
    : '';
  box.innerHTML = `
    <div class="ccu-actions">
      <button class="ccu-link" onclick="openCCGroupOverlay(null)">+ New group</button>
      <button class="ccu-link" onclick="openCCGroupOverlay('${escJsAttr(g.id)}')">Edit group</button>
    </div>
    ${selector}
    <div class="chart-card">
      <div class="chart-card-title">${esc(g.name)}</div>
      <div class="ccu-muted">Limit Gabungan</div>
      <div class="ccu-limit">${fRp(tempActive ? g.tempLimit : g.permanentLimit)}
        ${tempActive ? `<span class="ccu-badge-temp">Limit sementara s/d ${esc(ccShortDate(g.tempLimitExpiry))}</span>` : ''}</div>
      ${tempActive ? `<div class="ccu-muted">Limit tetap ${fRp(g.permanentLimit)}</div>` : ''}
      ${tempExpired ? `<div class="ccu-muted">Limit sementara berakhir ${esc(isoDisp(g.tempLimitExpiry))} — kembali ke limit tetap</div>` : ''}
      <div class="ccu-card-list">${g.pms.map(p => `<span class="ccu-chip">${esc(p)}</span>`).join('') || '<span class="ccu-muted">No cards</span>'}</div>
      ${missing.length ? `<div class="ccu-warn">Kartu tidak ditemukan: ${esc(missing.join(', '))}</div>` : ''}
    </div>`;
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
