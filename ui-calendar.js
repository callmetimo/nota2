// ── HOME CALENDAR ─────────────────────────────────────────────

const CAL_TX_HEADER_H  = 46;
const CAL_TX_ITEM_H    = 44;
const CAL_TX_EMPTY_H   = 110;
const CAL_TX_MAX_FRAC  = 0.50;

let calInited       = false;
let calOlderShown   = false;
let calSelectedCell = null;
let calCollapsedShown = false;  // State 4: collapsed months injected
let calYearPillsShown = false;  // State 5: year pills injected
let cal2026Collapsed  = false;  // whether 2026 months are collapsed into pill
let calExpandedMonths = {};     // tracks which collapsed month rows are expanded
let calExpandedYears  = {};     // tracks which year pills are expanded
let calOlderCollapsed = {};
let calFutureCollapsed = {};
let calCurrentMonthCollapsed = false;
let calExpandedYearMonths = {}; // tracks which year-month rows are expanded

function calGetMonthData(year, month) {
  const rawOpex = HIST.opex || [];
  // Drop stale rowIndex-less optimistic-cache placeholders that share a day+signature with an
  // authoritative (rowIndex-bearing) row. Every real sheet fetch always includes rowIndex, so
  // this is never a second legitimate transaction (a genuine 2nd identical transaction also
  // carries rowIndex once fetched, so it's kept). It's the leftover write from submitOpex's/
  // addSelectedRecurring's optimistic cache push (see the `optimisticRow` blocks) surviving an
  // iOS-PWA kill before the next authoritative fetch's wipe-and-replace in
  // _applyCurrentMonthRows got a chance to overwrite the stale cache blob.
  const confirmedKeys = new Set(
    rawOpex.filter(r => r.rowIndex).map(r => `${r.y}|${r.m}|${sigOfSheetRow(r)}`)
  );
  const opex = rawOpex.filter(r => r.rowIndex || !confirmedKeys.has(`${r.y}|${r.m}|${sigOfSheetRow(r)}`));
  const txByDay = {};
  
  // Add HIST.opex data
  // NOTE: r.m in data.json is 0-indexed (Jan=0), but `month` param here is 1-indexed (Jan=1)
  opex.forEach(r => {
    if (r.y !== year || r.m !== month - 1) return;
    const key = r.d;
    if (!txByDay[key]) txByDay[key] = [];
    txByDay[key].push(r);
  });
  
  // Add txHistory (local transactions) data
  // Skip synced entries for the current month — they already appear via HIST.opex
  // with rowIndex (editable). Keeping them would cause duplicates and the duplicate
  // has no rowIndex, making it appear non-editable.
  const _now = new Date();
  const isCurrentCalMonth = (year === _now.getFullYear() && month === _now.getMonth() + 1);
  const local = (txHistory || []).filter(r => !(isCurrentCalMonth && r.synced));
  // Defensive dedup against HIST.opex by content signature, independent of the `synced`
  // flag. On iOS PWA, the app can be killed mid-sync before the callback that flips
  // synced:true ever runs, even though the server already wrote the row — leaving a
  // txHistory ghost that _reconcileUnsyncedWithSheet may never get a chance to clear.
  // Count-based so N legitimately-identical transactions still all render.
  const opexSigCounts = {};
  opex.forEach(r => {
    if (r.y !== year || r.m !== month - 1) return;
    const sig = sigOfSheetRow(r);
    opexSigCounts[sig] = (opexSigCounts[sig] || 0) + 1;
  });
  const localUsedCounts = {};
  local.forEach(r => {
    if (!r.date) return;
    const d = new Date(r.date);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) return;
    const sig = sigOfTxHistory(r);
    localUsedCounts[sig] = (localUsedCounts[sig] || 0) + 1;
    if (localUsedCounts[sig] <= (opexSigCounts[sig] || 0)) {
      dupDebugLog('calGetMonthData:skipGhost', { sig, synced: r.synced, opexCount: opexSigCounts[sig] || 0, usedCount: localUsedCounts[sig] });
      return; // already a confirmed row — skip ghost
    }
    dupDebugLog('calGetMonthData:keepLocal', { sig, synced: r.synced, opexCount: opexSigCounts[sig] || 0, usedCount: localUsedCounts[sig] });
    const key = d.getDate();
    if (!txByDay[key]) txByDay[key] = [];
    txByDay[key].push(r);
  });

  // Merge paired Transfer rows (same xfr_ TxID) into single display entries
  Object.keys(txByDay).forEach(day => {
    const arr = txByDay[day];
    const xfrGroups = {};
    arr.forEach(r => {
      if ((r.cat || r.category) === 'Transfer' && r.id && String(r.id).startsWith('xfr_')) {
        if (!xfrGroups[r.id]) xfrGroups[r.id] = [];
        xfrGroups[r.id].push(r);
      }
    });
    Object.entries(xfrGroups).forEach(([txId, rows]) => {
      if (rows.length < 2) return;
      const expRow = rows.find(r => (r.exp || 0) > 0);
      const incRow = rows.find(r => (r.inc || 0) > 0);
      if (!expRow || !incRow) return;
      const merged = {
        ...expRow,
        tx: `${expRow.pm} → ${incRow.pm}`,
        pm: `${expRow.pm} → ${incRow.pm}`,
        cat: 'Transfer', category: 'Transfer',
        amt: expRow.exp || 0,
        type: 'transfer',
        transferFromPm: expRow.pm,
        transferToPm: incRow.pm,
      };
      txByDay[day] = arr.filter(r => !rows.includes(r)).concat([merged]);
    });
  });

  let total = opex
    .filter(r => r.y === year && r.m === month - 1 && r.cat !== 'Income' && r.cat !== 'Investment' && r.cat !== 'Transfer' && !isCreditCardPM(r.pm))
    .reduce((s, r) => s + (r.exp || 0), 0);

  const localIncome = (txHistory || [])
    .filter(r => {
      if (r.synced || !r.date || r.type !== 'income') return false;
      const d = new Date(r.date);
      return d.getFullYear() === year && d.getMonth() + 1 === month;
    })
    .reduce((s, r) => s + (r.amount || 0), 0);
  let totalIncome = opex
    .filter(r => r.y === year && r.m === month - 1 && r.cat === 'Income')
    .reduce((s, r) => s + (r.inc || 0), 0) + localIncome;

  const _now2 = new Date();
  const isFutureMonth = year > _now2.getFullYear() ||
    (year === _now2.getFullYear() && month > _now2.getMonth() + 1);
  if (isFutureMonth) {
    getRecurringProjections(year, month).forEach(p => {
      const day = parseInt(p.date.split('-')[2]);
      if (!txByDay[day]) txByDay[day] = [];
      txByDay[day].push(p);
      if (p.type === 'expense') total += p.amount;
      else totalIncome += p.amount;
    });
  }

  if (isCurrentCalMonth) {
    const mk = curMonthKey();
    const firedIds = new Set(
      loadRecurring().filter(r => r.lastFired === mk).map(r => `proj_${r.id}`)
    );
    // Defensive dedup against real same-day entries, independent of `lastFired`/`firedIds`.
    // txByDay at this point only holds real HIST.opex/txHistory rows (added above), so this
    // catches the case where a projection's own rule already has a matching real transaction
    // for that day — e.g. a rule created via the "new transaction + Set as Recurring" path,
    // where `lastFired` should suppress the projection but any race that leaves it stale would
    // otherwise let the projection render alongside the real entry. Count-based so a
    // legitimately-unconfirmed projection with no real counterpart still renders.
    const realSigCounts = {};
    Object.values(txByDay).flat().forEach(r => {
      const sig = r.d !== undefined ? sigOfSheetRow(r) : sigOfTxHistory(r);
      realSigCounts[sig] = (realSigCounts[sig] || 0) + 1;
    });
    const usedProjSigCounts = {};
    getRecurringProjections(year, month)
      .filter(p => {
        if (firedIds.has(p.id)) return false;
        const sig = sigOfProjection(p);
        usedProjSigCounts[sig] = (usedProjSigCounts[sig] || 0) + 1;
        if (usedProjSigCounts[sig] <= (realSigCounts[sig] || 0)) {
          dupDebugLog('calGetMonthData:skipProjection', { sig, ruleId: p.ruleId, realCount: realSigCounts[sig] || 0 });
          return false; // a real transaction already covers this occurrence
        }
        return true;
      })
      .forEach(p => {
        const day = parseInt(p.date.split('-')[2]);
        if (!txByDay[day]) txByDay[day] = [];
        txByDay[day].push(p);
        // Projections are upcoming, not confirmed — exclude from total so it matches Insights.
      });
  }

  const incPct  = totalIncome > 0 ? Math.min(Math.round((total / totalIncome) * 100), 100) : 0;
  const isOver  = totalIncome > 0 && total > totalIncome;

  return { total, totalIncome, incPct, isOver, txByDay, isFutureMonth };
}

// Overflow day-cells (leading/trailing days from an adjacent month, shown grayed-out at the
// edges of a month grid) belong to a different month than the grid's own "home" month, so
// their data must come from calGetMonthData(dy, dm) for THEIR real date, not the home month's
// txByDay — otherwise they render with correct date labels but empty/wrong transactions,
// while the same date shown in its own proper month's grid renders correctly.
function calMakeTxByDayResolver(homeYear, homeMonth, homeTxByDay) {
  const cache = { [`${homeYear}-${homeMonth}`]: homeTxByDay };
  return (dy, dm) => {
    const key = `${dy}-${dm}`;
    if (!cache[key]) cache[key] = calGetMonthData(dy, dm).txByDay;
    return cache[key];
  };
}

function calFormatAmount(n) {
  if (!n) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return Math.round(n / 1000) + 'K';
  return String(n);
}

function calMonthName(y, m) {
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', {month:'long', year:'numeric'});
}

function calBuildMonthHTML(year, month, today, collapseBtn = '') {
  const { total, totalIncome, incPct, isOver, txByDay, isFutureMonth } = calGetMonthData(year, month);
  const mName   = calMonthName(year, month);
  const totalFmt = (isFutureMonth && total ? '~' : '') + (total ? fRpS(total) : 'Rp 0');
  const incFmt   = totalIncome ? (isFutureMonth ? '~' : '') + fRpS(totalIncome) : '';
  const fillPct  = incPct + '%';
  const overCls  = isOver ? ' over' : '';

  const progressHTML = totalIncome > 0
    ? `<div class="cal-progress-wrap">
        <div class="cal-progress-bar"><div class="cal-progress-fill${overCls}" style="width:${fillPct}"></div></div>
        <div class="cal-progress-right">
          <div class="cal-progress-amount">${totalFmt}</div>
          <div class="cal-progress-avg">income ${incFmt}</div>
        </div>
      </div>`
    : `<div class="cal-progress-wrap">
        <div class="cal-progress-bar"><div class="cal-progress-fill" style="width:0%"></div></div>
        <div class="cal-progress-right">
          <div class="cal-progress-amount">${totalFmt}</div>
          <div class="cal-progress-avg" style="visibility:hidden">—</div>
        </div>
      </div>`;

  const firstDay  = new Date(year, month - 1, 1).getDay();
  const daysInMon = new Date(year, month, 0).getDate();
  const offset    = (firstDay + 6) % 7;
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;
  const daysInPrev = new Date(prevYear, prevMonth, 0).getDate();
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear  = month === 12 ? year + 1 : year;

  let cells = [];
  for (let i = offset - 1; i >= 0; i--) cells.push({ day: daysInPrev - i, cur: false, next: false });
  for (let d = 1; d <= daysInMon; d++) cells.push({ day: d, cur: true, next: false });
  const remainder = cells.length % 7;
  if (remainder > 0) {
    for (let d = 1; d <= 7 - remainder; d++) cells.push({ day: d, cur: false, next: true });
  }

  const getTxByDayFor = calMakeTxByDayResolver(year, month, txByDay);

  const todayY = today.getFullYear();
  const todayM = today.getMonth() + 1;
  const todayD = today.getDate();

  let weeksHTML = '';
  for (let w = 0; w < cells.length / 7; w++) {
    let weekCells = '';
    for (let d = 0; d < 7; d++) {
      const cell = cells[w * 7 + d];
      if (!cell) continue;

      const isCur    = cell.cur;
      const isToday  = isCur && year === todayY && month === todayM && cell.day === todayD;
      const isFuture = isCur && (year > todayY || (year === todayY && month > todayM) ||
                       (year === todayY && month === todayM && cell.day > todayD));
      const cellY    = isCur ? year : (cell.next ? nextYear : prevYear);
      const cellM    = isCur ? month : (cell.next ? nextMonth : prevMonth);
      const txs      = getTxByDayFor(cellY, cellM)[cell.day] || [];
      const dayTotal = txs.filter(r => (r.category || r.cat) !== 'Income' && (r.category || r.cat) !== 'Transfer' && !isCreditCardPM(r.pm || '')).reduce((s, r) => s + (r.amount || r.exp || 0), 0);
      const hasData  = txs.length > 0;
      const allProjected = hasData && txs.every(r => r.projected);
      const hasFuture = hasData && txs.some(r => r.future && isFuture);
      const futureTxCount = txs.filter(r => r.future && isFuture).length;

      let cls = 'cal-day';
      if (!isCur)                        cls += ' other-month';
      else if (isFuture && allProjected) cls += ' future projected-day';
      else if (isFuture && hasFuture)    cls += ' future';
      else if (hasData)                  cls += ' has-data';
      if (isToday)   cls += ' today';
      if (d >= 5)    cls += ' weekend';

      const txJson = hasData
        ? JSON.stringify(txs.map(r => ({
            tx: r.tx || r.payee || r.mk || '',
            cat: r.category || r.cat || '',
            pm: r.pm || '',
            amt: r.amount || r.exp || r.inc || 0,
            type: (r.category || r.cat) === 'Income' ? 'income' : ((r.category || r.cat) === 'Investment' ? 'invest' : ((r.category || r.cat) === 'Transfer' ? 'transfer' : '')),
            rowIndex: r.rowIndex || null,
            sheetId: r.rowIndex ? (r.id || null) : null,
            notes: r.notes || '',
            inc: r.inc || 0,
            projected: r.projected || false,
            ruleId: r.ruleId || null,
            future: r.future || false,
            synced: r.synced
          }))).replace(/'/g, '&#39;')
        : '[]';
      const dateStr  = `${cellY}-${String(cellM).padStart(2,'0')}-${String(cell.day).padStart(2,'0')}`;
      const projPrefix = allProjected ? '~' : '';
      const totalStr = dayTotal ? projPrefix + fRp(dayTotal) : '';
      const clickAttr = `onclick="calSelectDay(this,'${dateStr}','${totalStr}')"` ;

      const totalLabel = isToday && !hasData ? 'Today'
                       : (dayTotal ? calFormatAmount(dayTotal) : '');

      weekCells += `<div class="${cls}" ${clickAttr} data-date="${dateStr}" data-total="${totalStr}" data-txns='${txJson}'>
        <div class="cal-day-num">${cell.day}</div>
        ${totalLabel ? `<div class="cal-day-total">${totalLabel}</div>` : ''}
      </div>`;
    }
    weeksHTML += `<div class="cal-week-row">${weekCells}</div>`;
  }

  return `
    <div class="cal-month-label">
      <div class="cal-month-name">${mName}</div>
      ${progressHTML}
      ${collapseBtn}
    </div>
    <div class="cal-week-section">
      <div class="cal-wday-row">
        <div class="cal-wday">Mon</div><div class="cal-wday">Tue</div><div class="cal-wday">Wed</div>
        <div class="cal-wday">Thu</div><div class="cal-wday">Fri</div><div class="cal-wday">Sat</div><div class="cal-wday">Sun</div>
      </div>
      ${weeksHTML}
    </div>`;
}

function calGetRemainingWeeksHTML(year, month, today) {
  const { txByDay } = calGetMonthData(year, month);
  const getTxByDayFor = calMakeTxByDayResolver(year, month, txByDay);
  const todayDow = (today.getDay() + 6) % 7;
  const nextMon = new Date(today);
  nextMon.setDate(today.getDate() - todayDow + 7);

  let weeksHTML = '';
  const cur = new Date(nextMon);
  while (true) {
    const wy = cur.getFullYear(), wm = cur.getMonth() + 1;
    if (wy > year || (wy === year && wm > month)) break;
    let cells = '';
    for (let i = 0; i < 7; i++) {
      const d = new Date(cur);
      d.setDate(cur.getDate() + i);
      const dy = d.getFullYear(), dm = d.getMonth() + 1, dd = d.getDate();
      const isCur = (dy === year && dm === month);
      const isFuture = d > today;
      const txs = getTxByDayFor(dy, dm)[dd] || [];
      const dayTotal = txs.filter(r => (r.category || r.cat) !== 'Income' && (r.category || r.cat) !== 'Transfer' && !isCreditCardPM(r.pm || '')).reduce((s, r) => s + (r.amount || r.exp || 0), 0);
      const hasData = txs.length > 0;

      let cls = 'cal-day' + (isCur ? (isFuture && hasData ? ' future' : (hasData ? ' has-data' : '')) : ' other-month');
      if (i >= 5) cls += ' weekend';

      const txJson = hasData
        ? JSON.stringify(txs.map(r => ({
            tx: r.tx || r.payee || r.mk || '',
            cat: r.category || r.cat || '',
            pm: r.pm || '',
            amt: r.amount || r.exp || r.inc || 0,
            type: (r.category || r.cat) === 'Income' ? 'income' : ((r.category || r.cat) === 'Investment' ? 'invest' : ((r.category || r.cat) === 'Transfer' ? 'transfer' : '')),
            rowIndex: r.rowIndex || null,
            sheetId: r.rowIndex ? (r.id || null) : null,
            notes: r.notes || '',
            inc: r.inc || 0,
            projected: r.projected || false,
            ruleId: r.ruleId || null,
            future: r.future || false,
            synced: r.synced
          }))).replace(/'/g,'&#39;')
        : '[]';
      const dateStr = `${dy}-${String(dm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
      const totalStr = dayTotal ? fRp(dayTotal) : '';
      const clickAttr = `onclick="calSelectDay(this,'${dateStr}','${totalStr}')"` ;
      const totalLabel = dayTotal ? calFormatAmount(dayTotal) : '';

      cells += `<div class="${cls}" ${clickAttr} data-date="${dateStr}" data-total="${totalStr}" data-txns='${txJson}'><div class="cal-day-num">${dd}</div>${totalLabel ? `<div class="cal-day-total">${totalLabel}</div>` : ''}</div>`;
    }
    weeksHTML += `<div class="cal-week-row">${cells}</div>`;
    cur.setDate(cur.getDate() + 7);
  }
  return weeksHTML;
}

function calGetCurrentWeekHTML(year, month, today) {
  const { txByDay } = calGetMonthData(year, month);
  const getTxByDayFor = calMakeTxByDayResolver(year, month, txByDay);
  const todayD = today.getDate();
  const todayDow = (today.getDay() + 6) % 7; 
  const monDate = new Date(today);
  monDate.setDate(today.getDate() - todayDow);

  let cells = '';
  for (let i = 0; i < 7; i++) {
    const d = new Date(monDate);
    d.setDate(monDate.getDate() + i);
    const dy = d.getFullYear(), dm = d.getMonth() + 1, dd = d.getDate();
    const isCur    = (dy === year && dm === month);
    const isToday  = (dy === today.getFullYear() && dm === today.getMonth() + 1 && dd === todayD);
    const isFuture = d > today;
    const txs      = getTxByDayFor(dy, dm)[dd] || [];
    const dayTotal = txs.filter(r => (r.category || r.cat) !== 'Income' && !isCreditCardPM(r.pm || '')).reduce((s, r) => s + (r.amount || r.exp || 0), 0);
    const hasData  = txs.length > 0;

    let cls = 'cal-day';
    if (!isCur)     cls += ' other-month';
    else if (isFuture)  cls += ' future';
    else if (hasData)   cls += ' has-data';
    if (isToday)    cls += ' today';
    if (i >= 5)     cls += ' weekend';

    const txJson = hasData
      ? JSON.stringify(txs.map(r => ({
          tx: r.tx || r.payee || r.mk || '',
          cat: r.category || r.cat || '',
          pm: r.pm || '',
          amt: r.amount || r.exp || r.inc || 0,
          type: (r.category || r.cat) === 'Income' ? 'income' : ((r.category || r.cat) === 'Investment' ? 'invest' : ''),
          rowIndex: r.rowIndex || null,
          sheetId: r.rowIndex ? (r.id || null) : null,
          notes: r.notes || '',
          inc: r.inc || 0,
          projected: r.projected || false,
          ruleId: r.ruleId || null,
          synced: r.synced
        }))).replace(/'/g,'&#39;')
      : '[]';
    const dateStr  = `${dy}-${String(dm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    const totalStr = dayTotal ? fRp(dayTotal) : '';
    const clickAttr = `onclick="calSelectDay(this,'${dateStr}','${totalStr}')"` ;
    const totalLabel = isToday && !hasData ? 'Today' : (dayTotal ? calFormatAmount(dayTotal) : '');

    cells += `<div class="${cls}" ${clickAttr} data-date="${dateStr}" data-total="${totalStr}" data-txns='${txJson}'>
      <div class="cal-day-num">${dd}</div>
      ${totalLabel ? `<div class="cal-day-total">${totalLabel}</div>` : ''}
    </div>`;
  }
  return `<div class="cal-week-row" id="calCurWeekRow">${cells}</div>`;
}

function initCalendarSkeleton() {
  const today = new Date();
  const year  = today.getFullYear();
  const month = today.getMonth() + 1;
  const mName = `${MO[month-1]} ${year}`;

  // Build full month grid (skeleton — no data, just day numbers)
  const firstDow = (new Date(year, month - 1, 1).getDay() + 6) % 7; // Mon=0
  const daysInMonth = new Date(year, month, 0).getDate();
  const daysInPrev  = new Date(year, month - 1, 0).getDate();
  const todayD = today.getDate();

  let cells = [];
  for (let i = firstDow - 1; i >= 0; i--) cells.push({ day: daysInPrev - i, cur: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, cur: true });
  const rem = cells.length % 7;
  if (rem > 0) for (let i = 0; i < 7 - rem; i++) cells.push({ day: 0, cur: false, pad: true });

  let weeksHTML = '';
  for (let w = 0; w < cells.length / 7; w++) {
    let row = '';
    for (let d = 0; d < 7; d++) {
      const cell = cells[w * 7 + d];
      if (!cell) continue;
      const wkd = d >= 5 ? ' weekend' : '';
      if (cell.pad) { row += `<div class="cal-day other-month${wkd}"></div>`; continue; }
      if (!cell.cur) { row += `<div class="cal-day other-month${wkd}"><div class="cal-day-num">${cell.day}</div></div>`; continue; }
      const isToday = cell.day === todayD;
      const cls = 'cal-day skeleton' + (isToday ? ' today' : '') + wkd;
      const label = isToday ? '<div class="cal-day-total">Today</div>' : '';
      row += `<div class="${cls}"><div class="cal-day-num">${cell.day}</div>${label}</div>`;
    }
    weeksHTML += `<div class="cal-week-row">${row}</div>`;
  }

  document.getElementById('calCurrentMonth').innerHTML = `
    <div class="cal-month-label">
      <div class="cal-month-name">${mName}</div>
      <div class="cal-progress-wrap">
        <div class="cal-progress-bar"><div class="cal-progress-skeleton"></div></div>
        <div class="cal-progress-right">
          <div class="cal-label-skeleton"></div>
        </div>
      </div>
    </div>
    <div class="cal-week-section">
      <div class="cal-wday-row">
        <div class="cal-wday">Mon</div><div class="cal-wday">Tue</div><div class="cal-wday">Wed</div>
        <div class="cal-wday">Thu</div><div class="cal-wday">Fri</div><div class="cal-wday">Sat</div><div class="cal-wday">Sun</div>
      </div>
      ${weeksHTML}
    </div>`;

  // Show current month header at top (initCalendar will refine once data is ready)
  const cs = document.getElementById('calScroll');
  if (cs) cs.scrollTop = 0;
}

function initCalendar() {
  if (calInited) return;
  calInited = true;

  // Pre-set all state flags so scroll triggers never fire
  calOlderShown     = true;
  calCollapsedShown = true;
  calYearPillsShown = true;

  const today  = new Date();
  const year   = today.getFullYear();
  const month  = today.getMonth() + 1;
  const { total, totalIncome, incPct, isOver } = calGetMonthData(year, month);

  const totalFmt = total       ? fRpS(total)       : 'Rp 0';
  const incFmt   = totalIncome ? fRpS(totalIncome) : '';
  const fillPct  = incPct + '%';
  const overCls  = isOver ? ' over' : '';

  const progressHTML = totalIncome > 0
    ? `<div class="cal-progress-wrap">
        <div class="cal-progress-bar"><div class="cal-progress-fill${overCls}" style="width:${fillPct}"></div></div>
        <div class="cal-progress-right">
          <div class="cal-progress-amount">${totalFmt}</div>
          <div class="cal-progress-avg">income ${incFmt}</div>
        </div>
      </div>`
    : `<div class="cal-progress-wrap">
        <div class="cal-progress-bar"><div class="cal-progress-fill" style="width:0%"></div></div>
        <div class="cal-progress-right">
          <div class="cal-progress-amount">${totalFmt}</div>
        </div>
      </div>`;

  const curWeekHTML = calGetCurrentWeekHTML(year, month, today);
  document.getElementById('calCurrentMonth').innerHTML = `
    <div class="cal-month-label">
      <div class="cal-month-name">${calMonthName(year, month)}</div>
      ${progressHTML}
      <button class="cal-month-collapse-btn open" onclick="calToggleCurrentMonth()">›</button>
    </div>
    <div class="cal-week-section" id="calHiddenWeeks" style="display:none">
      <div class="cal-wday-row">
        <div class="cal-wday">Mon</div><div class="cal-wday">Tue</div><div class="cal-wday">Wed</div>
        <div class="cal-wday">Thu</div><div class="cal-wday">Fri</div><div class="cal-wday">Sat</div><div class="cal-wday">Sun</div>
      </div>
      <div id="calHiddenWeekRows"></div>
    </div>
    <div class="cal-week-section" id="calCurWeekSection">
      <div class="cal-wday-row" id="calCurWdayRow">
        <div class="cal-wday">Mon</div><div class="cal-wday">Tue</div><div class="cal-wday">Wed</div>
        <div class="cal-wday">Thu</div><div class="cal-wday">Fri</div><div class="cal-wday">Sat</div><div class="cal-wday">Sun</div>
      </div>
      ${curWeekHTML}
      ${calGetRemainingWeeksHTML(year, month, today)}
    </div>`;

  const cs = document.getElementById('calScroll');

  // Hide unused containers
  document.getElementById('calScrollHint').style.display = 'none';
  document.getElementById('calYearPills').style.display  = 'none';
  document.getElementById('calOlderMonths').innerHTML    = '';

  // Build all prior months (Jan → curMonth−1) as collapsed rows
  const priorMonths = [];
  for (let m = 1; m < month; m++) priorMonths.push({ y: year, m });
  const colEl = document.getElementById('calCollapsedMonths');
  if (priorMonths.length > 0) {
    colEl.style.display = 'block';
    calRenderCollapsedMonths(priorMonths, colEl, 'state4');
  }

  // Show all weeks of current month immediately
  calBuildCurrentMonthHiddenWeeks();

  // Populate future months (all collapsed)
  calPopulateFutureMonths();

  cs.addEventListener('scroll', calOnScroll);
  calSetPanelH(0);

  const todayStr = `${year}-${String(month).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

  // Always select today and scroll to its row
  setTimeout(() => {
    const todayCells = document.querySelectorAll('#page-home .cal-day.today');
    if (todayCells.length > 0) {
      const tc = todayCells[0];
      const txns = JSON.parse(tc.dataset.txns || '[]');
      if (txns.length > 0) {
        calSelectDay(tc, todayStr, fRp(txns.reduce((s,t)=>s+(t.amt||0),0)));
      } else {
        document.getElementById('calTxDate').textContent =
          today.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
        document.getElementById('calTxTotal').textContent = 'No transactions today';
      }
      const curMonthEl = document.getElementById('calCurrentMonth');
      if (curMonthEl && cs) {
        // Use getBoundingClientRect so the position is relative to #calScroll,
        // not <body> (offsetTop would overshoot since .cal-scroll is position:static).
        cs.style.scrollSnapType = 'none';
        const rect = curMonthEl.getBoundingClientRect();
        const csRect = cs.getBoundingClientRect();
        cs.scrollTo({ top: cs.scrollTop + (rect.top - csRect.top), behavior: 'instant' });
        requestAnimationFrame(() => { cs.style.scrollSnapType = ''; });
      }
    }
  }, 20);
}

function calOnScroll() { /* all months pre-rendered on init */ }

// #calOlderMonths is unused in the new calendar layout — all prior months live in #calCollapsedMonths.
function calRefreshOlderMonths() { /* no-op */ }

function calRefreshOlderMonths_UNUSED() {
  const olderEl = document.getElementById('calOlderMonths');
  if (!olderEl || !calOlderShown) return;
  const today = new Date();
  const year  = today.getFullYear();
  const month = today.getMonth() + 1;
  let olderHTML = '';
  for (let i = 2; i >= 1; i--) {
    let oy = year, om = month - i;
    if (om <= 0) { om += 12; oy -= 1; }
    const olderKey = `${oy}-${om}`;
    const olderBtn = `<button class="cal-month-collapse-btn open" onclick="calToggleOlderMonth('${olderKey}')">›</button>`;
    olderHTML += `<div class="cal-month-divider"></div><div class="cal-older-month" data-key="${olderKey}">${calBuildMonthHTML(oy, om, today, olderBtn)}</div>`;
  }
  olderEl.innerHTML = olderHTML;
  // Re-apply any collapsed states the user toggled
  for (let i = 2; i >= 1; i--) {
    let oy = year, om = month - i;
    if (om <= 0) { om += 12; oy -= 1; }
    const key = `${oy}-${om}`;
    if (calOlderCollapsed[key]) {
      const container = olderEl.querySelector(`.cal-older-month[data-key="${key}"]`);
      if (container) {
        container.querySelectorAll('.cal-week-section').forEach(s => s.style.display = 'none');
        const btn = container.querySelector('.cal-month-collapse-btn');
        if (btn) btn.classList.remove('open');
      }
    }
  }
}

// Builds and injects the hidden past-weeks rows for the current month.
// Called both from calRevealOlder() (first time) and initCalendar() on re-render
// (when calOlderShown is already true, so calRevealOlder would no-op).
function calBuildCurrentMonthHiddenWeeks() {
  const today  = new Date();
  const year   = today.getFullYear();
  const month  = today.getMonth() + 1;
  const todayDow = (today.getDay() + 6) % 7;
  const monOfCurWeek = new Date(today);
  monOfCurWeek.setDate(today.getDate() - todayDow);

  let hiddenRowsHTML = '';

  if (monOfCurWeek.getFullYear() === year && monOfCurWeek.getMonth() + 1 === month) {
    const { txByDay } = calGetMonthData(year, month);
    const getTxByDayFor = calMakeTxByDayResolver(year, month, txByDay);
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear  = month === 1 ? year - 1 : year;
    const firstDay = new Date(year, month - 1, 1).getDay();
    const offset   = (firstDay + 6) % 7;
    const daysInPrev = new Date(year, month - 1, 0).getDate();

    let cells = [];
    for (let i = offset - 1; i >= 0; i--) cells.push({day: daysInPrev - i, cur: false});
    for (let d = 1; d < monOfCurWeek.getDate(); d++) cells.push({day: d, cur: true});

    const rem = cells.length % 7;
    if (rem > 0) { for (let i = 0; i < 7 - rem; i++) cells.push({day:0,cur:false,pad:true}); }

    for (let w = 0; w < cells.length / 7; w++) {
      let weekCells = '';
      for (let d = 0; d < 7; d++) {
        const cell = cells[w*7+d];
        if (!cell) continue;
        if (cell.pad) { weekCells += `<div class="cal-day other-month"></div>`; continue; }
        const isCur  = cell.cur;
        const cellY  = isCur ? year : prevYear;
        const cellM  = isCur ? month : prevMonth;
        const txs    = getTxByDayFor(cellY, cellM)[cell.day] || [];
        const total  = txs.filter(r=>(r.category||r.cat)!=='Income').reduce((s,r)=>s+(r.amount||r.exp||0),0);
        const hasData = txs.length > 0;
        let cls = 'cal-day' + (isCur ? (hasData ? ' has-data' : '') : ' other-month') + (d >= 5 ? ' weekend' : '');
        const txJson = hasData ? JSON.stringify(txs.map(r=>({tx:r.tx||r.payee||r.mk||'',cat:r.category||r.cat||'',pm:r.pm||'',amt:r.amount||r.exp||r.inc||0,type:(r.category||r.cat)==='Income'?'income':((r.category||r.cat)==='Investment'?'invest':''),rowIndex:r.rowIndex||null,sheetId:r.rowIndex?(r.id||null):null,notes:r.notes||'',inc:r.inc||0,projected:r.projected||false,ruleId:r.ruleId||null}))).replace(/'/g,'&#39;') : '[]';
        const dateStr = `${cellY}-${String(cellM).padStart(2,'0')}-${String(cell.day).padStart(2,'0')}`;
        const totalStr = total ? fRp(total) : '';
        const clickAttr = `onclick="calSelectDay(this,'${dateStr}','${totalStr}')"` ;
        weekCells += `<div class="${cls}" ${clickAttr} data-date="${dateStr}" data-total="${totalStr}" data-txns='${txJson}'>
          <div class="cal-day-num">${cell.day || ''}</div>
          ${total ? `<div class="cal-day-total">${calFormatAmount(total)}</div>` : ''}
        </div>`;
      }
      hiddenRowsHTML += `<div class="cal-week-row">${weekCells}</div>`;
    }
  }

  const hwRows = document.getElementById('calHiddenWeekRows');
  if (hwRows) hwRows.innerHTML = hiddenRowsHTML;
  const hw = document.getElementById('calHiddenWeeks');
  if (hw) hw.style.display = 'block';
  const cwr = document.getElementById('calCurWdayRow');
  if (cwr) cwr.style.display = 'none';
}

function calRevealOlder() {
  if (calOlderShown) return;
  calOlderShown = true;

  calBuildCurrentMonthHiddenWeeks();

  const today  = new Date();
  const year   = today.getFullYear();
  const month  = today.getMonth() + 1;

  let olderHTML = '';
  for (let i = 2; i >= 1; i--) {
    let oy = year, om = month - i;
    if (om <= 0) { om += 12; oy -= 1; }
    const olderKey = `${oy}-${om}`;
    const olderBtn = `<button class="cal-month-collapse-btn open" onclick="calToggleOlderMonth('${olderKey}')">›</button>`;
    olderHTML += `<div class="cal-month-divider"></div><div class="cal-older-month" data-key="${olderKey}">${calBuildMonthHTML(oy, om, today, olderBtn)}</div>`;
  }
  document.getElementById('calOlderMonths').innerHTML = olderHTML;
  document.getElementById('calScrollHint').style.display = 'none';
  // Collapse all older months except the most recent one (i=1)
  for (let i = 2; i >= 1; i--) {
    let oy = year, om = month - i;
    if (om <= 0) { om += 12; oy -= 1; }
    if (i > 1) calToggleOlderMonth(`${oy}-${om}`);
  }

  setTimeout(() => {
    const curSec = document.getElementById('calCurWeekSection');
    if (curSec) curSec.scrollIntoView({block:'end'});
  }, 10);
}

// ── SNAP SENTINELS: inject page-height snap points into collapsed sections ────
function calInjectSnapSentinels(containerEl) {
  const cs = document.getElementById('calScroll');
  if (!cs || !containerEl) return;
  const pageH = cs.clientHeight;

  containerEl.querySelectorAll('.cal-snap-sentinel').forEach(s => s.remove());

  const csTop = cs.getBoundingClientRect().top;
  function scrollPos(el) {
    return el.getBoundingClientRect().top - csTop + cs.scrollTop;
  }

  const els = Array.from(
    containerEl.querySelectorAll(
      '.cal-month-label, .cal-year-pill-header, .cal-wday-row, .cal-week-row'
    )
  ).filter(el => el.offsetParent !== null && el.offsetHeight > 0);

  if (!els.length) return;

  let lastSnapPos = scrollPos(els[0]);

  els.forEach(el => {
    const pos = scrollPos(el);
    const isAnchor = el.classList.contains('cal-month-label') ||
                     el.classList.contains('cal-year-pill-header');
    if (isAnchor) {
      lastSnapPos = pos;
    } else if (pos + el.offsetHeight - lastSnapPos > pageH * 0.8) {
      const s = document.createElement('div');
      s.className = 'cal-snap-sentinel';
      s.style.cssText = 'height:0;pointer-events:none;scroll-snap-align:start';
      el.parentNode.insertBefore(s, el);
      lastSnapPos = pos;
    }
  });
}

// ── STATE 4: Collapsed month rows above Apr/May ───────────────
function calRevealCollapsed() {
  if (calCollapsedShown) return;
  calCollapsedShown = true;

  const today = new Date();
  const curYear = today.getFullYear();
  const curMonth = today.getMonth() + 1;
  // calOlderMonths shows: (curMonth-2) and (curMonth-1)
  // Collapsed = Jan through (curMonth-3) of current year, if any
  const oldestFullMonth = curMonth - 2;
  const collapsed = [];
  for (let m = 1; m < oldestFullMonth; m++) {
    collapsed.push({y: curYear, m});
  }

  const el = document.getElementById('calCollapsedMonths');
  if (collapsed.length > 0) {
    el.style.display = 'block';
    calRenderCollapsedMonths(collapsed, el, 'state4');
  }

  // State 5 always follows State 4 — inject year pills above
  calRevealYearPills();
}

function calRenderCollapsedMonths(months, container, ctx) {
  container.innerHTML = months.map(({y, m}) => {
    const key = `${y}-${m}`;
    const isExpanded = ctx === 'state4' ? !!calExpandedMonths[key] : !!calExpandedYearMonths[key];
    return calCollapsedMonthRowHTML(y, m, isExpanded, ctx);
  }).join('');
  requestAnimationFrame(() => {
    calInjectSnapSentinels(container);
    const cs = document.getElementById('calScroll');
    if (cs) {
      cs.style.scrollSnapType = 'none';
      requestAnimationFrame(() => { cs.style.scrollSnapType = ''; });
    }
  });
}

function calCollapsedMonthRowHTML(y, m, isExpanded, ctx) {
  const key = `${y}-${m}`;
  const fn = ctx === 'state4'
    ? `calToggleCollapsedMonth('${key}','${ctx}')`
    : `calToggleYearMonth('${key}',event)`;

  if (isExpanded) {
    const today = new Date();
    const collapseBtn = `<button class="cal-month-collapse-btn open" onclick="${fn}">›</button>`;
    return `<div class="cal-month-expanded-grid">${calBuildMonthHTML(y, m, today, collapseBtn)}</div>`;
  }

  const { total, totalIncome, incPct, isOver } = calGetMonthData(y, m);
  const mName = calMonthName(y, m);
  const totalFmt = total       ? fRpS(total)       : 'Rp 0';
  const incFmt   = totalIncome ? fRpS(totalIncome) : '';
  const fillPct  = incPct + '%';
  const overCls  = isOver ? ' over' : '';
  const progressHTML = totalIncome > 0
    ? `<div class="cal-progress-wrap"><div class="cal-progress-bar"><div class="cal-progress-fill${overCls}" style="width:${fillPct}"></div></div><div class="cal-progress-right"><div class="cal-progress-amount">${totalFmt}</div><div class="cal-progress-avg">income ${incFmt}</div></div></div>`
    : `<div class="cal-progress-wrap"><div class="cal-progress-bar"><div class="cal-progress-fill" style="width:0%"></div></div><div class="cal-progress-right"><div class="cal-progress-amount">${totalFmt}</div></div></div>`;

  return `<div class="cal-month-label clickable" onclick="${fn}" data-key="${key}">
    <div class="cal-month-name">${mName}</div>
    ${progressHTML}
    <span class="cal-month-collapse-btn">›</span>
  </div>`;

}

function calToggleCurrentMonth() {
  calCurrentMonthCollapsed = !calCurrentMonthCollapsed;
  const el = document.getElementById('calCurrentMonth');
  const sections = el.querySelectorAll('.cal-week-section');
  const btn = el.querySelector('.cal-month-collapse-btn');
  sections.forEach(s => s.style.display = calCurrentMonthCollapsed ? 'none' : '');
  if (btn) btn.classList.toggle('open', !calCurrentMonthCollapsed);
}

function calToggleOlderMonth(key) {
  calOlderCollapsed[key] = !calOlderCollapsed[key];
  const container = document.querySelector(`#calOlderMonths .cal-older-month[data-key="${key}"]`);
  if (!container) return;
  const sections = container.querySelectorAll('.cal-week-section');
  const btn = container.querySelector('.cal-month-collapse-btn');
  const isCollapsed = calOlderCollapsed[key];
  sections.forEach(s => s.style.display = isCollapsed ? 'none' : '');
  if (btn) btn.classList.toggle('open', !isCollapsed);
}

function calToggleFutureMonth(key) {
  calFutureCollapsed[key] = !calFutureCollapsed[key];
  const container = document.querySelector(`#calFutureMonths .cal-future-month[data-key="${key}"]`);
  if (!container) return;
  const sections = container.querySelectorAll('.cal-week-section');
  const btn = container.querySelector('.cal-month-collapse-btn');
  const isCollapsed = calFutureCollapsed[key];
  sections.forEach(s => s.style.display = isCollapsed ? 'none' : '');
  if (btn) btn.classList.toggle('open', !isCollapsed);
}

function calToggleCollapsedMonth(key, ctx) {
  calExpandedMonths[key] = !calExpandedMonths[key];
  const el = document.getElementById('calCollapsedMonths');
  const today = new Date();
  const curYear = today.getFullYear();
  const curMonth = today.getMonth() + 1;
  const collapsed = [];
  for (let m = 1; m < curMonth; m++) collapsed.push({y: curYear, m});
  calRenderCollapsedMonths(collapsed, el, ctx);
}

// ── STATE 5: Year pills above collapsed months ────────────────
function calRevealYearPills() {
  if (calYearPillsShown) return;
  calYearPillsShown = true;

  const curYear = new Date().getFullYear();
  const opex = (HIST.opex || []);
  // Years BEFORE current year only — current year gets its own special pill
  const yearSet = new Set(opex.map(r => r.y));
  yearSet.delete(curYear);
  const pastYears = [...yearSet].sort((a, b) => a - b);

  const el = document.getElementById('calYearPills');
  el.style.display = 'block';
  calRenderYearPills(pastYears, curYear, el);
}

function calGetYearsForPills() {
  const curYear = new Date().getFullYear();
  const opex = (HIST.opex || []);
  const yearSet = new Set(opex.map(r => r.y));
  yearSet.delete(curYear);
  return [...yearSet].sort((a, b) => a - b);
}

function calRenderYearPills(pastYears, curYear, container) {
  const today = new Date();
  const curMonth = today.getMonth() + 1;
  const opex = (HIST.opex || []);

  // Build current year (2026) pill — always first, special behavior
  const curYearTotal = opex
    .filter(r => r.y === curYear && r.cat !== 'Income' && r.cat !== 'Investment' && r.cat !== 'Transfer')
    .reduce((s, r) => s + (r.exp || 0), 0);
  const curYearFmt = curYearTotal ? fRpS(curYearTotal) : 'Rp 0';
  const curExpCls = cal2026Collapsed ? '' : ' expanded';
  const curChevron = '›';
  const curPillHTML = `<div class="cal-year-pill${curExpCls}" data-year="${curYear}" onclick="calToggle2026()">
    <div class="cal-year-pill-header">
      <div class="cal-year-pill-label">${curYear} <span style="font-size:9px;color:#666;font-weight:400;margin-left:4px">current</span></div>
      <div style="display:flex;align-items:center;gap:4px">
        <div class="cal-year-pill-meta">
          <div class="cal-year-pill-total">${curYearFmt}</div>
          <div class="cal-year-pill-sublabel">total opex</div>
        </div>
        <div class="cal-year-pill-chevron">${curChevron}</div>
      </div>
    </div>
  </div>`;

  // Build past year pills (2025, 2024, …)
  const pastPillsHTML = pastYears.map(y => {
    const isExpanded = !!calExpandedYears[y];
    const yearTotal = opex
      .filter(r => r.y === y && r.cat !== 'Income' && r.cat !== 'Investment' && r.cat !== 'Transfer')
      .reduce((s, r) => s + (r.exp || 0), 0);
    const yearTotalFmt = yearTotal ? fRpS(yearTotal) : 'Rp 0';
    const expCls = isExpanded ? ' expanded' : '';
    const chevron = '›';

    let monthsHTML = '';
    if (isExpanded) {
      monthsHTML = `<div class="cal-year-pill-months">` +
        Array.from({length: 12}, (_, i) => i + 1).map(m => {
          const key = `${y}-${m}`;
          const isMonthExp = !!calExpandedYearMonths[key];
          return calCollapsedMonthRowHTML(y, m, isMonthExp, 'year');
        }).join('') +
      `</div>`;
    }

    return `<div class="cal-year-pill${expCls}" data-year="${y}" onclick="calToggleYearPill(${y}, event)">
      <div class="cal-year-pill-header">
        <div class="cal-year-pill-label">${y}</div>
        <div style="display:flex;align-items:center;gap:4px">
          <div class="cal-year-pill-meta">
            <div class="cal-year-pill-total">${yearTotalFmt}</div>
            <div class="cal-year-pill-sublabel">total opex</div>
          </div>
          <div class="cal-year-pill-chevron">${chevron}</div>
        </div>
      </div>
      ${monthsHTML}
    </div>`;
  }).join('');

  container.innerHTML = pastPillsHTML + curPillHTML;
  requestAnimationFrame(() => {
    calInjectSnapSentinels(container);
    const cs = document.getElementById('calScroll');
    if (cs) {
      cs.style.scrollSnapType = 'none';
      requestAnimationFrame(() => { cs.style.scrollSnapType = ''; });
    }
  });
}

// Tap 2026 pill: toggle collapse/expand of all 2026 content below
function calToggle2026() {
  cal2026Collapsed = !cal2026Collapsed;
  // Show/hide the 2026 months (calCollapsedMonths + calOlderMonths + calCurrentMonth)
  const hide = cal2026Collapsed;
  const colEl = document.getElementById('calCollapsedMonths');
  const oldEl = document.getElementById('calOlderMonths');
  const curEl = document.getElementById('calCurrentMonth');
  const futEl = document.getElementById('calFutureMonths');
  if (colEl) colEl.style.display = hide ? 'none' : (colEl.innerHTML ? 'block' : 'none');
  if (oldEl) oldEl.style.display = hide ? 'none' : 'block';
  if (curEl) curEl.style.display = hide ? 'none' : 'block';
  if (futEl) futEl.style.display = hide ? 'none' : 'block';
  // Re-render year pills to update chevron state
  const pastYears = calGetYearsForPills();
  calRenderYearPills(pastYears, new Date().getFullYear(), document.getElementById('calYearPills'));
}

function calToggleYearPill(year, e) {
  if (e && e.target && (e.target.closest('.cal-year-month-row') || e.target.closest('.cal-month-label') || e.target.closest('.cal-month-expanded-grid'))) return;
  calExpandedYears[year] = !calExpandedYears[year];
  const pastYears = calGetYearsForPills();
  calRenderYearPills(pastYears, new Date().getFullYear(), document.getElementById('calYearPills'));
}

function calToggleYearMonth(key, e) {
  if (e) e.stopPropagation();
  calExpandedYearMonths[key] = !calExpandedYearMonths[key];
  const pastYears = calGetYearsForPills();
  calRenderYearPills(pastYears, new Date().getFullYear(), document.getElementById('calYearPills'));
}

function calSetPanelH(txCount) {
  // No-op: transaction panel is now a static flex segment (46% of page-home).
  // Dynamic height sizing removed as part of two-segment static layout redesign.
}

function calSelectDay(cell, dateStr, totalStr) {
  if (calSelectedCell) calSelectedCell.classList.remove('selected');
  calSelectedCell = cell;
  cell.classList.add('selected');

  const [y, m, d] = dateStr.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const isToday = dateStr === new Date().toISOString().slice(0,10);
  const dateLabel = dateObj.toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric'})
    + (isToday ? ' — Today' : '');

  document.getElementById('calTxDate').textContent  = dateLabel;

  const txns = JSON.parse(cell.dataset.txns || '[]').reverse();
  calCurrentTxns    = txns;
  calCurrentDateStr = dateStr;
  const today2 = new Date();
  const isCurrentMonth = (y === today2.getFullYear() && m === today2.getMonth() + 1);
  // Grace window: also editable if this day falls within the last 7 days, even when
  // it's in the previous month (e.g. editing a late-June expense on July 2).
  const daysSinceDay = Math.floor((new Date(today2.getFullYear(), today2.getMonth(), today2.getDate()) - dateObj) / 86400000);
  const isEditableDay = isCurrentMonth || (daysSinceDay >= 0 && daysSinceDay <= 7);

  const allProjected = txns.length > 0 && txns.every(t => t.projected);
  const isTrulyFuture = dateStr > todayISO();
  const hasFutureTxn = txns.some(t => t.future && isTrulyFuture);
  const futureCount = txns.filter(t => t.future && isTrulyFuture).length;
  if (txns.length === 0) {
    document.getElementById('calTxTotal').textContent = 'No transactions';
    document.getElementById('calTxList').innerHTML = `
      <div class="cal-tx-empty">
        <div class="cal-tx-empty-icon">📭</div>
        <div class="cal-tx-empty-text">No transactions this day.<br>Tap + to add one.</div>
      </div>`;
    calSetPanelH(0);
  } else {
    let totalLabel = totalStr + ' total';
    if (allProjected) totalLabel = totalStr + ' projected';
    else if (hasFutureTxn && futureCount === txns.length) totalLabel = futureCount + ' future';
    else if (hasFutureTxn) totalLabel = totalStr + ' total · ' + futureCount + ' future';
    document.getElementById('calTxTotal').textContent = totalLabel;
    document.getElementById('calTxList').innerHTML = txns.map((tx, idx) => {
      const isTrulyFuture = tx.future && dateStr > todayISO();
      const isTransfer = tx.cat === 'Transfer' || tx.type === 'transfer';
      const canEdit = isEditableDay && !tx.projected && !isTransfer;
      const canTransferEdit = isEditableDay && isTransfer && tx.sheetId;
      // A projected recurring entry is due-and-syncable once its date has arrived (not still upcoming)
      const canSyncProjected = tx.projected && tx.ruleId && dateStr <= todayISO();
      const tapAttrs = canEdit ? `data-idx="${idx}"` : (canSyncProjected ? `data-ruleid="${tx.ruleId}"` : (canTransferEdit ? `data-idx="${idx}" data-xfrid="${esc(tx.sheetId)}"` : ''));
      return `<div class="cal-tx-item${canEdit ? ' editable' : ''}${canSyncProjected ? ' projected-tappable' : ''}${canTransferEdit ? ' transfer-deletable' : ''}" ${tapAttrs}>
        <div class="cal-tx-dot ${tx.type||''}${tx.synced===false?' unsynced':''}"></div>
        <div class="cal-tx-info">
          <div class="cal-tx-tx">${esc(tx.tx)}${tx.projected ? '<span class="proj-badge">Projected</span>' : ''}${isTrulyFuture ? '<span class="future-badge">Future</span>' : ''}</div>
          <div class="cal-tx-meta">${isTransfer ? 'Transfer' : esc(tx.cat) + ' - ' + esc(tx.pm)}${canSyncProjected ? ' · Tap for options' : ''}${canTransferEdit ? ' · Tap to edit' : ''}</div>
        </div>
        <div class="cal-tx-amt ${tx.type||''}">${fRp(tx.amt)}</div>
        ${canEdit || canSyncProjected || canTransferEdit ? '<div class="cal-tx-edit-chevron">›</div>' : ''}
      </div>`;
    }).join('');
    calSetPanelH(txns.length);
  }

  const row = cell.closest('.cal-week-row');
  if (row) {
    // Wait for panel transition to complete (260ms) before checking visibility
    setTimeout(() => {
      const cs = document.getElementById('calScroll');
      const panel = document.getElementById('calTxPanel');
      const panelH = panel ? panel.offsetHeight : 0;
      // Visible area in calScroll is clientHeight (panel is sibling, not inside calScroll)
      // Row position relative to calScroll scroll container
      const rowTop = row.offsetTop;
      const rowBot = rowTop + row.offsetHeight;
      const visTop = cs.scrollTop;
      const visBot = visTop + cs.clientHeight;

      // If row bottom is hidden (below visible area), scroll so row is fully visible
      // Add small padding (8px) so row doesn't sit right at the edge
      if (rowBot > visBot) {
        cs.scrollTo({ top: rowBot - cs.clientHeight + 8, behavior: 'smooth' });
      } else if (rowTop < visTop) {
        cs.scrollTo({ top: rowTop - 8, behavior: 'smooth' });
      }
    }, 280); // after panel transition (260ms) + buffer
  }
}

// initCalendar()/calBuildMonthHTML() rebuild all day cells' `data-txns` from fresh data, but
// calSelectDay() only reads that attribute once, at tap time — an already-open day panel is
// left showing a stale snapshot until the user re-taps the day. Call this after any calendar
// rebuild so a panel left open across an add/sync/fetch reflects current data (e.g. a newly
// added transaction, or a recurring projection that should now be suppressed).
function calRefreshOpenDayPanel() {
  if (!calCurrentDateStr) return;
  const cell = document.querySelector(`[data-date="${calCurrentDateStr}"]`);
  if (!cell) return;
  calSelectDay(cell, calCurrentDateStr, cell.dataset.total || '');
}

function calPopulateFutureMonths() {
  const today = new Date();
  const curYear = today.getFullYear();
  const curMonth = today.getMonth() + 1;
  let html = '';
  for (let m = curMonth + 1; m <= 12; m++) {
    const futureKey = `${curYear}-${m}`;
    const futureBtn = `<button class="cal-month-collapse-btn open" onclick="calToggleFutureMonth('${futureKey}')">›</button>`;
    html += `<div class="cal-month-divider"></div><div class="cal-future-month" data-key="${futureKey}">${calBuildMonthHTML(curYear, m, today, futureBtn)}</div>`;
  }
  document.getElementById('calFutureMonths').innerHTML = html;
  // Explicitly collapse all future months (avoid double-toggle on re-render)
  for (let m = curMonth + 1; m <= 12; m++) {
    const key = `${curYear}-${m}`;
    calFutureCollapsed[key] = true;
    const container = document.querySelector(`#calFutureMonths .cal-future-month[data-key="${key}"]`);
    if (container) {
      container.querySelectorAll('.cal-week-section').forEach(s => s.style.display = 'none');
      const btn = container.querySelector('.cal-month-collapse-btn');
      if (btn) btn.classList.remove('open');
    }
  }
}

function calReinit() {
  calInited = false;
  calOlderShown = false;
  calCollapsedShown = false;
  calYearPillsShown = false;
  cal2026Collapsed = false;
  calExpandedMonths = {};
  calExpandedYears = {};
  calExpandedYearMonths = {};
  calOlderCollapsed = {};
  calFutureCollapsed = {};
  calCurrentMonthCollapsed = false;
  calSelectedCell = null;
  document.getElementById('calOlderMonths').innerHTML = '';
  document.getElementById('calCurrentMonth').innerHTML = '';
  document.getElementById('calCurrentMonth').style.display = 'block';
  document.getElementById('calCollapsedMonths').innerHTML = '';
  document.getElementById('calCollapsedMonths').style.display = 'block';
  document.getElementById('calYearPills').innerHTML = '';
  document.getElementById('calYearPills').style.display = 'none';
  document.getElementById('calScrollHint').style.display = 'none';
  document.getElementById('calFutureMonths').innerHTML = '';
  initCalendar();
}

