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

// ── INIT ──────────────────────────────────────────────────────
updateHeaderHeight();
window.addEventListener('resize',updateHeaderHeight);
initDatePicker('inputDateRaw','inputDateDisplay','inputDateText');
initDatePicker('inputDateRawI','inputDateDisplayI','inputDateTextI');
initDatePicker('xfrDateRaw','xfrDateDisplay','xfrDateText');

// ── INIT v3.5: Render from cache instantly, fetch in background ──
window.addEventListener('DOMContentLoaded', async () => {
  const isHome = () => document.getElementById('page-home').classList.contains('active');

  // Arms the splash/sign-in overlay to hide itself as soon as Auth.ready resolves —
  // safe to call this early since it just chains onto that promise internally.
  Auth.markAppReady();

  // Fire-and-forget: repopulates allCategories/allPMs/allStocks/allAccounts/CAT_COLORS/
  // ACCOUNT_CCY/STOCK_TYPE from the user's Config sheet once it resolves. Any picker/lookup
  // that runs before this resolves just sees the hardcoded defaults for a moment.
  fetchConfig();
  fetchAccountBalances();
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
      if (projItem) { _touchFired = Date.now(); openProjectedActionModal(projItem.dataset.ruleid); return; }
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
      if (projItem) { openProjectedActionModal(projItem.dataset.ruleid); return; }
      const xfrItem = e.target.closest('.cal-tx-item[data-xfrid]');
      if (xfrItem) { openEditTransferOverlay(calCurrentTxns[parseInt(xfrItem.dataset.idx)]); return; }
      const item = e.target.closest('.cal-tx-item[data-idx]');
      if (!item) return;
      openEditOverlay(parseInt(item.dataset.idx));
    });
  })();

  // Step 1: Show skeleton instantly
  if (isHome()) initCalendarSkeleton();

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
  // Populate year dropdowns for recurring end-date selects
  _initRecurringEndYears();
  // Sync recurring rules with Google Sheets first, then run due-check/retry on merged data
  // (avoids racing a stale pre-fetch push against the server merge — see checkRecurringOnLoad)
  fetchRecurring().then(() => {
    checkRecurringOnLoad();
    retryPendingRecurring();
  });
  // Request persistent storage so iOS doesn't silently evict PWA localStorage
  navigator.storage?.persist?.();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !_suppressVisRefresh && !isSyncing) fetchCurrentMonth(true);
  });

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

async function retryPendingQueue() {
  if (!queue.length) return;
  const pending = [...queue];
  let synced = 0;
  for (const r of pending) {
    const isInvest = r.type === 'invest' || r.action === 'invest';
    // Belt-and-suspenders on top of the Apps Script clientId idempotency cache (6h TTL):
    // an earlier fetchCurrentMonth/fetchCurrentMonthFresh in this same boot already
    // populated HIST.opex, so check in-memory first — no extra network call — before
    // blindly re-POSTing an item whose original request may have succeeded server-side
    // despite a client-side timeout (see syncOpex/fetchWithTimeout).
    if (!isInvest && r.date) {
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
    const ok = isInvest ? await syncInvest(r) : await syncOpex(r);
    if (ok) {
      queue = queue.filter(q => q.id !== r.id);
      txHistory = txHistory.map(h => h.id === r.id ? {...h, synced:true} : h);
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

// ── GOALS ─────────────────────────────────────────────────────
let GOALS = [];
let goalsEditId = null; // sheet rowNum of the goal being edited, or null for new

let _goalsFetchSeq = 0;
async function fetchGoals() {
  const seq = ++_goalsFetchSeq;
  const container = document.getElementById('goalsListContainer');
  if (container) container.innerHTML = '<div class="chart-loading">Loading…</div>';
  try {
    const res = await fetch(apiGet('type=goals'), { method: 'GET' });
    const j = await res.json();
    if (seq !== _goalsFetchSeq) return; // a newer fetchGoals() call superseded this one
    if (j.status === 'ok' && Array.isArray(j.goals)) GOALS = j.goals;
  } catch(e) { /* silently fall through to empty render */ }
  if (seq !== _goalsFetchSeq) return;
  renderGoals();
}

function onGoalCcyChange(ccy) {
  const prefixEl = document.getElementById('goalCcyPrefix');
  if (!prefixEl) return;
  if (ccy === 'IDR') prefixEl.textContent = 'Rp';
  else if (ccy === 'USD') prefixEl.textContent = '$';
  else if (ccy === 'SGD') prefixEl.textContent = 'S$';
  else if (ccy === 'EUR') prefixEl.textContent = '€';
  else prefixEl.textContent = ccy;
}

function fGoalAmt(n, ccy) {
  ccy = (ccy || 'IDR').toUpperCase();
  if (ccy === 'IDR') {
    return fRpS(n);
  }
  let symbol = ccy + ' ';
  if (ccy === 'USD') symbol = '$';
  else if (ccy === 'SGD') symbol = 'S$';
  else if (ccy === 'EUR') symbol = '€';
  
  if (!n) return symbol + '0';
  
  if (n >= 1000000000) return symbol + (n / 1000000000).toFixed(1) + 'B';
  if (n >= 1000000) return symbol + (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return symbol + (n / 1000).toFixed(0) + 'K';
  
  return symbol + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function getAssetValue(stock) {
  const allInvest = getAllInvestRows();
  const { buyLots, sellLots, buyTotalIdr } = computeInvestNetLots(allInvest);
  
  const manualUSD = parsePrice(stockPrices['USDIDR']);
  const manualCHF = parsePrice(stockPrices['CHFIDR']);
  const usdRate = manualUSD > 0 ? manualUSD : (fxRates.USD || 16500);
  const chfRate = manualCHF > 0 ? manualCHF : (fxRates.CHF || 19000);

  const navStar = parsePrice(stockPrices['StarStable']);
  const priceQQQ  = parsePrice(stockPrices['QQQ']);
  const priceJNJ  = parsePrice(stockPrices['JNJ']);
  const priceVYM  = parsePrice(stockPrices['VYM']);
  const priceAAPL = parsePrice(stockPrices['AAPL']);

  const netLot = (buyLots[stock] || 0) - (sellLots[stock] || 0);

  if (netLot <= 0) {
    const sItem = CONFIG_ITEMS.find(i => i.kind === 'stock' && i.name && i.name.toLowerCase() === stock.toLowerCase() && !i.archived);
    if (sItem) {
      let rawBal = sItem.balance;
      if (rawBal == null && rawAccountBalances[sItem.name]) {
        rawBal = rawAccountBalances[sItem.name].amount;
      }
      const balNum = parseConfigBalance(rawBal);
      if (balNum !== null && balNum > 0) {
        return balNum;
      }
    }
    return 0;
  }

  const stockConfig = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === stock.toLowerCase());
  let type = getAssetTypeForItem(stock, stockConfig?.assetType || STOCK_TYPE[stock], false);
  const buyRatio = buyLots[stock] > 0 ? netLot / buyLots[stock] : 0;
  const costBasis = buyTotalIdr[stock] * buyRatio;

  let currentValue = 0;
  if (stock === 'Star Stable Income Fund') currentValue = navStar > 0 ? netLot * navStar : 0;
  else if (stock.startsWith('USDIDR')) currentValue = netLot * usdRate;
  else if (stock === 'CHFIDR') currentValue = netLot * chfRate;
  else if (stock === 'QQQ')  currentValue = priceQQQ  > 0 ? netLot * priceQQQ  * usdRate : 0;
  else if (stock === 'JNJ')  currentValue = priceJNJ  > 0 ? netLot * priceJNJ  * usdRate : 0;
  else if (stock === 'VYM')  currentValue = priceVYM  > 0 ? netLot * priceVYM  * usdRate : 0;
  else if (stock === 'AAPL') currentValue = priceAAPL > 0 ? netLot * priceAAPL * usdRate : 0;
  else if (parsePrice(stockPrices[stock]) > 0) {
    currentValue = netLot * parsePrice(stockPrices[stock]) * (type === 'US Stock' ? usdRate : 1);
  } else {
    currentValue = costBasis;
  }
  return currentValue;
}

function getGoalAssetList() {
  const allInvest = getAllInvestRows();
  const stocks = new Set();
  allInvest.forEach(r => { if (r.stock) stocks.add(r.stock); });
  CONFIG_ITEMS.filter(i => i.kind === 'stock' && !i.archived).forEach(i => { if (i.name) stocks.add(i.name); });
  return Array.from(stocks).sort((a, b) => a.localeCompare(b));
}

function getGoalCurrentValue(goal) {
  let totalIdr = 0;
  (goal.sources || []).forEach(source => {
    if (source === 'Cash') { totalIdr += computeCashBalance(); return; }
    if (accountBalances[source]) {
      totalIdr += accountBalances[source].amount || 0;
      return;
    }
    totalIdr += getAssetValue(source);
  });

  const ccy = (goal.ccy || 'IDR').toUpperCase();
  if (ccy === 'IDR') return totalIdr;

  const manualUSD = parsePrice(stockPrices['USDIDR']);
  const manualCHF = parsePrice(stockPrices['CHFIDR']);
  const usdRate = manualUSD > 0 ? manualUSD : (fxRates.USD || 16500);
  const chfRate = manualCHF > 0 ? manualCHF : (fxRates.CHF || 19000);

  if (ccy === 'USD') return totalIdr / usdRate;
  if (ccy === 'CHF') return totalIdr / chfRate;
  if (fxRates[ccy]) return totalIdr / fxRates[ccy];

  return totalIdr;
}

function renderGoals() {
  const container = document.getElementById('goalsListContainer');
  if (!container) return;
  if (!GOALS.length) {
    container.innerHTML = '<div style="text-align:center;padding:60px 20px;color:var(--text2);font-size:14px;line-height:1.6">No goals yet.<br>Tap <strong style="color:var(--accent)">+</strong> to add your first goal.</div>';
    return;
  }
  const active = GOALS.filter(g => !g.completed);
  const done   = GOALS.filter(g =>  g.completed);
  let html = '';
  const renderCard = g => {
    const current = getGoalCurrentValue(g);
    const pct = Math.min(100, g.targetAmount > 0 ? (current / g.targetAmount * 100) : 0);
    const opacity = g.completed ? '0.45' : '1';
    return `<div class="goal-card" style="opacity:${opacity}" onclick="openGoalsOverlay('edit','${g.id}')">
      <div class="goal-card-header">
        <div class="goal-card-name">${g.name}</div>
        ${g.completed ? '<span style="font-size:10px;color:var(--green);font-weight:600;background:var(--green-dim);padding:2px 8px;border-radius:20px">Done</span>' : ''}
      </div>
      <div style="font-size:11px;color:var(--text2);margin-top:2px">${g.startDate} – ${g.endDate||'…'}</div>
      <div class="goal-progress-wrap"><div class="goal-progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:12px">
        <span style="color:var(--text2)">${fGoalAmt(current, g.ccy)} of ${fGoalAmt(g.targetAmount, g.ccy)}</span>
        <span style="color:var(--accent);font-weight:600">${pct.toFixed(0)}%</span>
      </div>
    </div>`;
  };
  active.forEach(g => { html += renderCard(g); });
  if (done.length) {
    html += `<div class="section-header" style="margin-top:8px"><span class="section-title">Completed</span></div>`;
    done.forEach(g => { html += renderCard(g); });
  }
  container.innerHTML = html;
}

function openGoalsOverlay(mode, goalId) {
  goalsEditId = mode === 'edit' ? goalId : null;
  const goal = goalsEditId ? GOALS.find(g => g.id === goalsEditId) : null;
  document.getElementById('goalsOverlayTitle').textContent = mode === 'new' ? 'New Goal' : 'Edit Goal';
  document.getElementById('goalDeleteBtn').style.display = mode === 'edit' ? 'block' : 'none';
  const completeBtn = document.getElementById('goalMarkCompleteBtn');
  completeBtn.style.display = mode === 'edit' ? 'block' : 'none';

  document.getElementById('goalName').value = goal ? goal.name : '';
  const startDate = goal ? goal.startDate : todayISO();
  document.getElementById('goalStartDateRaw').value = startDate;
  document.getElementById('goalStartDateText').textContent = isoDisp(startDate);
  const endDate = goal ? (goal.endDate || '') : '';
  document.getElementById('goalEndDateRaw').value = endDate;
  document.getElementById('goalEndDateText').textContent = endDate ? isoDisp(endDate) : 'Select date';
  document.getElementById('goalTargetAmount').value = goal ? formatGroupedAmt(goal.targetAmount) : '';
  
  const ccy = goal ? (goal.ccy || 'IDR') : 'IDR';
  document.getElementById('goalCcy').value = ccy;
  onGoalCcyChange(ccy);

  const selectedSources = goal ? (goal.sources || []) : [];
  const assets = getGoalAssetList();
  document.getElementById('goalSourceFundList').innerHTML = assets.map(asset =>
    `<label class="goal-source-row">
      <input type="checkbox" value="${asset}" ${selectedSources.includes(asset) ? 'checked' : ''}>
      <span style="font-size:14px">${asset}</span>
    </label>`
  ).join('');

  if (goal) {
    completeBtn.textContent = goal.completed ? 'Mark Incomplete' : 'Mark Complete';
    completeBtn.className = 'goal-complete-btn' + (goal.completed ? ' done' : '');
  }
  const ov = document.getElementById('goalsOverlay');
  ov.classList.add('open');
  adjustOverlayForVisualViewport();
}

function closeGoalsOverlay() {
  const ov = document.getElementById('goalsOverlay');
  if (ov) {
    ov.classList.remove('open');
    ov.style.top = '';
    ov.style.height = '';
  }
  goalsEditId = null;
}

async function saveGoal() {
  const name = document.getElementById('goalName').value.trim();
  const startDate = document.getElementById('goalStartDateRaw').value;
  const endDate = document.getElementById('goalEndDateRaw').value;
  const targetAmount = parseAmt('goalTargetAmount');
  const sources = Array.from(document.querySelectorAll('#goalSourceFundList input[type=checkbox]:checked')).map(cb => cb.value);
  const ccy = document.getElementById('goalCcy').value;
  if (!name || !targetAmount) return;
  const saveBtn = document.querySelector('#goalsOverlay .submit-btn');
  if (saveBtn) saveBtn.textContent = 'Saving…';
  const existing = goalsEditId ? GOALS.find(g => g.id === goalsEditId) : null;
  const payload = {
    type: 'goals', action: 'save',
    id: goalsEditId || null,
    name, startDate, endDate, targetAmount, sources, ccy,
    completed: existing ? existing.completed : false,
    completedDate: existing ? (existing.completedDate || '') : ''
  };
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      if (goalsEditId) {
        const idx = GOALS.findIndex(g => g.id === goalsEditId);
        if (idx >= 0) GOALS[idx] = { ...GOALS[idx], name, startDate, endDate, targetAmount, sources, ccy };
      } else {
        GOALS.push({ id: j.id, name, startDate, endDate, targetAmount, sources, ccy, completed: false, completedDate: null });
      }
      closeGoalsOverlay();
      renderGoals();
    }
  } finally {
    if (saveBtn) saveBtn.textContent = 'Save Goal';
  }
}

async function deleteGoal() {
  if (!goalsEditId) return;
  const delBtn = document.getElementById('goalDeleteBtn');
  if (delBtn) delBtn.textContent = 'Deleting…';
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody({ type: 'goals', action: 'delete', id: goalsEditId }) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      GOALS = GOALS.filter(g => g.id !== goalsEditId);
      closeGoalsOverlay();
      renderGoals();
    }
  } finally {
    if (delBtn) delBtn.textContent = 'Delete Goal';
  }
}

async function toggleGoalComplete() {
  if (!goalsEditId) return;
  const goal = GOALS.find(g => g.id === goalsEditId);
  if (!goal) return;
  const newCompleted = !goal.completed;
  const newCompletedDate = newCompleted ? todayISO() : null;
  const completeBtn = document.getElementById('goalMarkCompleteBtn');
  if (completeBtn) completeBtn.textContent = 'Saving…';
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, {
      method: 'POST', headers: {'Content-Type': 'text/plain'},
      body: apiBody({
        type: 'goals', action: 'save', id: goalsEditId,
        name: goal.name, startDate: goal.startDate, endDate: goal.endDate,
        targetAmount: goal.targetAmount, sources: goal.sources, ccy: goal.ccy || 'IDR',
        completed: newCompleted, completedDate: newCompletedDate || ''
      })
    });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      goal.completed = newCompleted;
      goal.completedDate = newCompletedDate;
    }
  } finally {
    if (completeBtn) {
      completeBtn.textContent = goal.completed ? 'Mark Incomplete' : 'Mark Complete';
      completeBtn.className = 'goal-complete-btn' + (goal.completed ? ' done' : '');
    }
  }
}

// ── PROFILE HUB NAVIGATION ────────────────────────────────────
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
    const res = await fetch(apiGet(`type=month&y=${y}&m=${m}`), { method: 'GET' });
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
    const res = await fetch(apiGet('type=recurring'), { method: 'GET' });
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
            lastFired: (local?.lastFired && local.lastFired > (r.lastFired || ''))
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
  // clientTs lets the server reject this write if a newer one already landed —
  // fetchWithTimeout's Promise.race does NOT cancel the underlying fetch, so an
  // abandoned (client-timed-out) request can still complete server-side minutes
  // later and silently overwrite newer data without this guard.
  const clientTs = Date.now();
  try {
    // allowEmpty confirms to the server this is a deliberate "delete the last rule" push,
    // not an accidental empty array from a client-side bug — the server refuses to wipe an
    // already-populated sheet with an empty saveAll unless this is set (appsscript_v40).
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

function _initRecurringEndYears() {
  const curY = new Date().getFullYear();
  const opts = '<option value="">Year</option>' +
    Array.from({length: 11}, (_, i) => {
      const y = curY + i;
      return `<option value="${y}">${y}</option>`;
    }).join('');
  document.getElementById('inputRecurringEndYear').innerHTML = opts;
  document.getElementById('recurringEditEndYear').innerHTML = opts;
}

function _autoSetEndYear(yearId) {
  const yEl = document.getElementById(yearId);
  if (!yEl.value) yEl.value = String(new Date().getFullYear());
}

function _getEndMonthValue(monthId, yearId) {
  const m = document.getElementById(monthId).value;
  const y = document.getElementById(yearId).value;
  if (!m || !y) return null;
  return `${y}-${m}`;
}

function _setEndMonthValue(monthId, yearId, value) {
  const mEl = document.getElementById(monthId);
  const yEl = document.getElementById(yearId);
  if (value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    const [year, month] = value.split('-');
    // Add the year option on-the-fly if it's not in the generated list (e.g. a past year)
    if (!yEl.querySelector(`option[value="${year}"]`)) {
      const opt = document.createElement('option');
      opt.value = year; opt.textContent = year;
      yEl.appendChild(opt);
    }
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
function getRecurringDue() {
  const today = new Date();
  const mk = curMonthKey();
  return loadRecurring().filter(r =>
    r.active &&
    r.dayOfMonth <= today.getDate() &&
    r.lastFired !== mk &&
    (!r.endMonth || r.endMonth >= mk)
  );
}

function getRecurringProjections(year, month) {
  const rules = loadRecurring();
  const mk = `${year}-${String(month).padStart(2,'0')}`;
  return rules
    .filter(r => r.active && (!r.endMonth || r.endMonth >= mk))
    .map(r => ({
      id: `proj_${r.id}`,
      ruleId: r.id,
      date: `${year}-${String(month).padStart(2,'0')}-${String(r.dayOfMonth).padStart(2,'0')}`,
      tx: getInstallmentName(r, mk),
      amount: r.amount,
      category: r.cat,
      pm: r.pm,
      notes: r.notes || '',
      type: r.type,
      projected: true,
    }));
}

// Toggle the day-of-month and end-date rows in the input form
function toggleRecurringRow() {
  const on = document.getElementById('inputRecurring').checked;
  document.getElementById('recurringDayRow').style.display = on ? '' : 'none';
  document.getElementById('recurringEndRow').style.display = on ? '' : 'none';
  if (on) {
    const raw = document.getElementById('inputDateRaw').value;
    const day = raw ? parseInt(raw.split('-')[2]) : new Date().getDate();
    document.getElementById('inputRecurringDay').value = day;
  } else {
    document.getElementById('inputRecurringEndMonth').value = '';
    document.getElementById('inputRecurringEndYear').value = '';
  }
}

// ── RECURRING PROMPT (on app load) ───────────────────────────────────────────

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

  const due = getRecurringDue().filter(r => !promptedSet.has(String(r.id)));
  if (!due.length) return;
  _pendingRecurring = due;

  // Record these rule ids as "prompted" immediately — survives app close without any
  // interaction — but do NOT stamp lastFired here. lastFired only changes once the user
  // actually confirms Add or an explicit Skip (addSelectedRecurring / dismissRecurringPrompt),
  // so if the app is killed between "popup shown" and "user taps Add" (iOS PWA), the rule
  // stays correctly due and gets prompted again on the next open instead of silently
  // vanishing into an unsynced, permanently-projected calendar entry.
  due.forEach(r => promptedSet.add(String(r.id)));
  localStorage.setItem(promptedKey, JSON.stringify([...promptedSet]));
  // Clean up stale prompt-tracking keys from previous months (old blanket-flag format too)
  Object.keys(localStorage)
    .filter(k => k.startsWith('notapub_rprompt_') && k !== promptedKey)
    .forEach(k => localStorage.removeItem(k));

  _renderRecurringPrompt();
  document.getElementById('recurringPrompt').classList.add('open');
}

function _renderRecurringPrompt() {
  const n = _pendingRecurring.length;
  document.getElementById('recurringPromptSubtitle').textContent =
    `${n} transaction${n > 1 ? 's' : ''} ready to add`;
  document.getElementById('recurringAddBtn').textContent = `Add ${n} Transaction${n > 1 ? 's' : ''}`;
  const list = document.getElementById('recurringPromptList');
  list.innerHTML = _pendingRecurring.map((r, i) => `
    <label class="recurring-prompt-item">
      <input class="recurring-prompt-check" type="checkbox" data-ridx="${i}" checked onchange="_updateRecurringPromptBtn()">
      <div class="recurring-prompt-info">
        <div class="recurring-prompt-tx">${esc(getInstallmentName(r, curMonthKey()))}</div>
        <div class="recurring-prompt-meta">${esc(r.cat)} · ${esc(r.pm)}</div>
      </div>
      <div class="recurring-prompt-amt ${r.type === 'income' ? 'income' : ''}" style="color:${r.type==='income'?'var(--green)':'var(--text)'}">${r.type === 'income' ? '+' : '-'}${fRp(r.amount)}</div>
    </label>`).join('');
}

function _updateRecurringPromptBtn() {
  const n = document.querySelectorAll('#recurringPromptList input:checked').length;
  document.getElementById('recurringAddBtn').textContent = `Add ${n} Transaction${n !== 1 ? 's' : ''}`;
}

// Shared by addSelectedRecurring() (bulk, from the due-popup) and handleProjectedAddSync()
// (single, from tapping a still-projected calendar entry and choosing "Add & Sync") — builds
// the local optimistic transaction and pushes it to the sheet the same way submitOpex() does.
function _addAndSyncRecurringRule(r) {
  const today = todayISO();
  const txName = getInstallmentName(r, curMonthKey());
  const rec = { id: Date.now() + Math.random(), date: today, tx: txName, amount: r.amount,
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

function openProjectedActionModal(ruleId) {
  const rules = loadRecurring();
  const r = rules.find(x => String(x.id) === String(ruleId));
  if (!r) return;
  _projectedActionRuleId = ruleId;
  document.getElementById('projectedActionSubtitle').textContent =
    `"${r.tx}" (${fRp(r.amount)}) — add & sync to Google Sheets, or skip this occurrence if you've already recorded it another way.`;
  document.getElementById('projectedActionModal').classList.add('open');
}

function closeProjectedActionModal() {
  document.getElementById('projectedActionModal').classList.remove('open');
  _projectedActionRuleId = null;
}

function handleProjectedAddSync() {
  const ruleId = _projectedActionRuleId;
  closeProjectedActionModal();
  if (isSyncing || !ruleId) return;
  const rules = loadRecurring();
  const idx = rules.findIndex(x => String(x.id) === String(ruleId));
  if (idx === -1) return;
  const r = rules[idx];
  isSyncing = true;
  rules[idx].lastFired = curMonthKey();
  saveRecurring(rules);
  showToast('Adding recurring transaction…', 'loading', 0);
  _addAndSyncRecurringRule(r).then(() => {
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
  closeProjectedActionModal();
  if (!ruleId) return;
  const rules = loadRecurring();
  const idx = rules.findIndex(x => String(x.id) === String(ruleId));
  if (idx === -1) return;
  rules[idx].lastFired = curMonthKey();
  saveRecurring(rules);
  showToast('Occurrence skipped', 'success');
  calInited = false;
  if (document.getElementById('page-home').classList.contains('active')) {
    initCalendar();
    calRefreshOpenDayPanel();
  }
}

function addSelectedRecurring() {
  // Re-entrancy guard (mirrors submitOpex's isSyncing check): without this, a double-fired
  // tap/click on #recurringAddBtn (no touchstart/touchend debounce here, unlike .cal-tx-item)
  // creates two independent txHistory/queue entries with different ids for the same logical
  // transaction — if only one of the two syncs lands, the other renders as a permanent
  // duplicate that the calGetMonthData signature dedup correctly declines to hide (it can't
  // tell an accidental double-add from a genuinely different 3rd transaction).
  if (isSyncing) return;
  isSyncing = true;
  const addBtn = document.getElementById('recurringAddBtn');
  if (addBtn) addBtn.disabled = true;
  const checked = [...document.querySelectorAll('#recurringPromptList input[type=checkbox]:checked')];
  if (!checked.length) {
    isSyncing = false;
    if (addBtn) addBtn.disabled = false;
    dismissRecurringPrompt();
    return;
  }
  const rules = loadRecurring();
  const mk = curMonthKey();
  const syncPromises = [];
  checked.forEach(cb => {
    const r = _pendingRecurring[+cb.dataset.ridx];
    if (!r) return;
    // Mark rule fired
    const idx = rules.findIndex(x => x.id === r.id);
    if (idx !== -1) rules[idx].lastFired = mk;
    syncPromises.push(_addAndSyncRecurringRule(r));
  });
  saveLocal(); updateStatus(); saveRecurring(rules);
  dismissRecurringPrompt();
  const n = checked.length;
  showToast(`${n} recurring transaction${n !== 1 ? 's' : ''} added ✓`, 'success');
  // Refresh calendar after all syncs complete so the server already has the rows
  // when fetchCurrentMonth(true) requests them — HIST.opex and txHistory (synced=true)
  // are then consistent and no duplicate appears.
  Promise.all(syncPromises).then(() => {
    isSyncing = false;
    if (addBtn) addBtn.disabled = false;
    calInited = false;
    if (document.getElementById('page-home').classList.contains('active')) initCalendar();
    fetchCurrentMonth(true).then(() => {
      calInited = false;
      if (document.getElementById('page-home').classList.contains('active')) initCalendar();
    });
  });
}

function dismissRecurringPrompt() {
  document.getElementById('recurringPrompt').classList.remove('open');
  // Mark every pending rule as handled for this month so the prompt does not
  // re-appear on the next app open (whether the user added or skipped).
  const mk = curMonthKey();
  const rules = loadRecurring();
  let changed = false;
  (_pendingRecurring || []).forEach(r => {
    const idx = rules.findIndex(x => x.id === r.id);
    if (idx !== -1 && rules[idx].lastFired !== mk) {
      rules[idx].lastFired = mk;
      changed = true;
    }
  });
  if (changed) saveRecurring(rules);
}

// ── RECURRING LIST PAGE ───────────────────────────────────────────────────────

function renderRecurringList() {
  const rules = loadRecurring();
  const container = document.getElementById('recurringListContainer');
  if (!rules.length) {
    container.innerHTML = '<p style="color:var(--text2);text-align:center;padding:48px 0 24px;font-size:14px">No recurring transactions yet.<br>Tap + to add one.</p>';
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
  container.innerHTML = html;
}

function _recurringCard(r) {
  const isInc = r.type === 'income';
  const endLabel = r.endMonth ? `<div class="recurring-card-day" style="color:var(--text2)">Until ${_formatEndMonth(r.endMonth)}</div>` : '';
  return `<div class="recurring-card">
    <div class="recurring-card-dot ${isInc ? 'income' : 'expense'}"></div>
    <div class="recurring-card-info">
      <div class="recurring-card-tx">${esc(r.tx)}</div>
      <div class="recurring-card-meta">${esc(r.cat)} · ${esc(r.pm)}</div>
      <div class="recurring-card-day">Every ${ordinalSuffix(r.dayOfMonth)} of the month</div>
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
  document.getElementById('recurringEditDay').value    = r.dayOfMonth;
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
  const day = parseInt(document.getElementById('recurringEditDay').value) || 0;
  if (!tx || !cat || !amt || !pm || day < 1 || day > 31) {
    showToast('All fields required (day 1–31)', 'error'); return;
  }
  const rules = loadRecurring();
  const idx = rules.findIndex(x => x.id === id);
  if (idx === -1) { closeRecurringEditModal(); return; }
  const endMonth = _getEndMonthValue('recurringEditEndMonth', 'recurringEditEndYear');
  rules[idx] = { ...rules[idx], type: _recurringEditType, tx, cat, amount: amt, pm, notes, dayOfMonth: day, endMonth: endMonth || null };
  saveRecurring(rules);
  closeRecurringEditModal();
  renderRecurringList();
  showToast('Recurring rule updated', 'success');
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
  showToast('Recurring rule deleted', 'success');
}
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js" integrity="sha384-dug+JxfBvklEQdJ4AYuBBAIScUz0bVN73xpy273gcAwHjb3qI0fXmuYNaNfdyYJG" crossorigin="anonymous">