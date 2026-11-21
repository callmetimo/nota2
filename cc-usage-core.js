/* CC Usage core: pure BCA-style combined-limit math. No DOM, no globals (HIST / txHistory / CONFIG_ITEMS),
   no clock: the caller passes `today` ('YYYY-MM-DD', local) and pre-normalised rows, so it is unit-testable in Node.
   Dates are split as strings, never parsed with new Date('YYYY-MM-DD') (that is UTC and shifts the day). */
const CCUsageCore = (() => {
  const CICILAN_RE = /CICILAN\b.*?\bKE\s*0*(\d{1,3})\s*DARI\s*0*(\d{1,3})/i; // "IPHONE CICILAN KE 1 DARI 12"
  const LEGACY_RE = /\((\d{1,3})\/(\d{1,3})\)\s*$/;                           // old in-app rows "Laptop (3/6)"
  const POKOK_RE = /\[pokok:(\d+)\]/i;                                         // principal tag written into notes
  // Rows the old recurring system generated after the numbered ones ("Sun Yoga (Installment)"): they carry no X.
  const CONT_RE = /\(\s*installment\s*\)\s*$/i;

  const pad = n => (n < 10 ? '0' + n : '' + n);
  const iso = (y, m0, d) => y + '-' + pad(m0 + 1) + '-' + pad(d);
  const parts = s => [+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)];
  const lc = s => String(s || '').toLowerCase();

  function dim(y, m0) {
    if (m0 === 1) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
    return [3, 5, 8, 10].includes(m0) ? 30 : 31;
  }
  // billingDate 0/missing means "calendar month", i.e. the cycle ends on the last day.
  const bdEff = bd => (bd >= 1 ? bd : 31);
  // Same rule as applyBillingCycle: a day after the billing day belongs to the next cycle.
  const cycleIdx = (y, m0, d, bd) => y * 12 + m0 + (d > bd ? 1 : 0);
  const endDay = (idx, bd) => Math.min(bd, dim(Math.floor(idx / 12), idx % 12));

  function dayAfter(s) {
    const [y, m0, d] = parts(s);
    if (d < dim(y, m0)) return iso(y, m0, d + 1);
    return m0 === 11 ? iso(y + 1, 0, 1) : iso(y, m0 + 1, 1);
  }

  function cycleRange(idx, bd) {
    const prev = idx - 1;
    const prevEnd = iso(Math.floor(prev / 12), prev % 12, endDay(prev, bd));
    return { start: dayAfter(prevEnd), end: iso(Math.floor(idx / 12), idx % 12, endDay(idx, bd)) };
  }

  function parseInstallment(tx) {
    const s = String(tx || '');
    let m = s.match(CICILAN_RE);
    if (!m) m = s.match(LEGACY_RE);
    if (!m) return null;
    const x = +m[1], y = +m[2];
    if (!(x >= 1 && x <= y && y <= 60)) return null;
    return { x, y, normName: cleanName(s.replace(m[0], ' ')) };
  }

  function cleanName(str) {
    return str.toUpperCase().replace(/[,\-–:]+/g, ' ').replace(/\s+/g, ' ').trim() || 'CICILAN';
  }

  const bdOf = (bdByPm, pm) => bdEff((bdByPm || {})[lc(pm)] || 0);
  const curIdxOf = (today, bd) => { const [y, m0, d] = parts(today); return cycleIdx(y, m0, d, bd); };

  // Rows must be charges on the group's PMs dated <= today. Installment rows are ALSO regular charges
  // for the statement/unbilled buckets (they are billed amounts); this only derives the locked principal.
  //
  // Real ledgers are messy, so rows are placed chronologically into series *instances*:
  //  - a numbered row (X of Y) joins the instance of the same name whose last number is X-1 (same
  //    monthly amount wins a tie), otherwise it starts a new instance. Two purchases that share a
  //    name ("Train (1/3)" twice) therefore stay two series instead of being merged.
  //  - an "(Installment)" row (no number) is the next instalment of the open instance of that name.
  function buildSeries(rows, group, today, bdByPm) {
    const closed = group.closedSeries || [];
    const charges = rows.map((r, i) => ({ r, i })).filter(e => e.r.kind === 'charge')
      .sort((a, b) => a.r.date.localeCompare(b.r.date) || a.i - b.i).map(e => e.r);
    const inst = [];
    const place = (s, r, x) => { s.rows.push(r); s.xs.push(x); if (x >= s.xMax) { s.xMax = x; s.last = r; } };
    // Same amount as the series' last instalment wins; otherwise the most recently active one.
    const pick = (pool, r) => {
      if (!pool.length) return null;
      const same = pool.filter(s => s.last.amount === r.amount);
      return (same.length ? same : pool).reduce((a, b) => (b.last.date > a.last.date ? b : a));
    };
    charges.forEach(r => {
      const p = parseInstallment(r.tx);
      if (p) {
        const same = inst.filter(s => s.name === p.normName && s.y === p.y);
        const next = same.filter(s => s.xMax === p.x - 1);
        // Earlier numbers that were never recorded: attach to a series that is behind this number.
        const behind = p.x > 1 ? same.filter(s => s.xMax > 0 && s.xMax < p.x - 1) : [];
        const target = pick(next.length ? next : behind, r);
        if (target) { place(target, r, p.x); return; }
        const fresh = { name: p.normName, y: p.y, rows: [], xs: [], xMax: 0, last: null };
        inst.push(fresh);
        place(fresh, r, p.x);
      } else if (CONT_RE.test(r.tx)) {
        const open = inst.filter(s => s.name === cleanName(r.tx.replace(CONT_RE, ' ')) && s.xMax < s.y);
        const target = pick(open, r);
        if (target) place(target, r, target.xMax + 1);
      }
    });

    const seen = {};
    inst.forEach(s => { const k = s.name + '|' + s.y; seen[k] = (seen[k] || 0) + 1; s.base = k; s.n = seen[k]; });
    return inst.map(s => {
      const key = s.n > 1 ? `${s.base}#${s.n}` : s.base;
      const lastRow = s.last, a = lastRow.amount;
      let P = null;
      s.rows.some(r => { const m = String(r.notes || '').match(POKOK_RE); if (m) P = +m[1]; return !!m; });
      // The latest non-empty transaction note tells same-named purchases apart ("Halle - Frankfurt").
      const note = s.rows.slice().reverse().map(r => String(r.notes || '').replace(POKOK_RE, '').trim()).find(Boolean) || '';
      const m = P ? Math.round(P / s.y) : 0;
      const isClosed = closed.includes(key);
      let remaining;
      if (s.xMax >= s.y || isClosed) remaining = 0;
      else if (P) remaining = P - m * s.xMax;
      else remaining = a * (s.y - s.xMax);
      const nextX = s.xMax + 1;
      let nextAmount = P ? m : a;
      if (P && nextX === s.y) nextAmount = P - m * (s.y - 1);
      const lastBd = bdOf(bdByPm, lastRow.pm);
      const prevStart = cycleRange(curIdxOf(today, lastBd) - 1, lastBd).start;
      return {
        key, name: s.name, y: s.y, xMax: s.xMax, amount: a, principal: P, remaining: Math.round(remaining), note,
        nextX, nextAmount: Math.round(nextAmount), lastDate: lastRow.date, pm: lastRow.pm, cat: lastRow.cat || '',
        ambiguous: seen[s.base] > 1, stale: s.xMax < s.y && lastRow.date < prevStart, closed: isClosed,
        // Every row of the series with its instalment number (the page uses them to show payments per cycle).
        entries: s.rows.map((r, i) => ({ row: r, x: s.xs[i] }))
      };
    });
  }

  function computeCCUsage(group, allRows, today, bdByPm) {
    const tempOk = group.tempLimit > 0 && !!group.tempLimitExpiry;
    const tempActive = tempOk && today <= group.tempLimitExpiry;
    const tempExpired = tempOk && today > group.tempLimitExpiry;
    const activeLimit = tempActive ? group.tempLimit : group.permanentLimit;

    const pmSet = new Set((group.pms || []).map(lc));
    const rows = allRows.filter(r => pmSet.has(lc(r.pm)) && r.date <= today);
    const known = bdByPm || {};
    const missingPms = (group.pms || []).filter(p => !(lc(p) in known));
    const cycles = (group.pms || []).filter(p => lc(p) in known).map(pm => {
      const bd = bdOf(bdByPm, pm), idx = curIdxOf(today, bd);
      return { pm, bd, idx, start: cycleRange(idx, bd).start, end: cycleRange(idx, bd).end };
    });

    const hasAnchor = !!group.anchorDate && group.anchorOutstanding != null;
    let billedCharges = 0, unbilledCharges = 0, credits = 0;
    rows.filter(r => !(hasAnchor && r.date <= group.anchorDate)).forEach(r => {
      if (r.kind === 'credit') { credits += r.amount; return; }
      const [y, m0, d] = parts(r.date);
      const bd = bdOf(bdByPm, r.pm);
      if (cycleIdx(y, m0, d, bd) < curIdxOf(today, bd)) billedCharges += r.amount;
      else unbilledCharges += r.amount;
    });
    const cycleSpend = unbilledCharges;

    if (hasAnchor) {
      const [ty, tm] = parts(today);
      const earliest = cycles.length ? cycles.map(c => c.start).sort()[0] : iso(ty, tm, 1);
      const v = group.anchorOutstanding;
      if (v < 0) credits += -v;
      else if (group.anchorDate < earliest) billedCharges += v;
      else unbilledCharges += v;
    }

    const statementBalance = Math.max(0, billedCharges - credits);
    const excess = Math.max(0, credits - billedCharges);
    const unbilled = Math.max(0, unbilledCharges - excess);
    const overpayment = Math.max(0, excess - unbilledCharges);
    const series = buildSeries(rows, group, today, bdByPm);
    const installmentRemaining = series.reduce((n, s) => n + s.remaining, 0);
    const pendingAuth = group.pendingAuth || 0;
    const usedTotal = statementBalance + unbilled + installmentRemaining + pendingAuth - overpayment;
    const remaining = activeLimit - usedTotal;
    const sameCycle = cycles.every(c => c.start === cycles[0].start && c.end === cycles[0].end);

    return {
      activeLimit, tempActive, tempExpired,
      statementBalance: Math.round(statementBalance), unbilled: Math.round(unbilled),
      cycleSpend: Math.round(cycleSpend), installmentRemaining: Math.round(installmentRemaining),
      pendingAuth, overpayment: Math.round(overpayment), usedTotal: Math.round(usedTotal),
      remaining: Math.round(remaining), overLimit: remaining < 0,
      cycles, sameCycle, series, missingPms
    };
  }

  // Rows whose own-PM cycle index equals idx (for the transaction list).
  function cycleRowsFor(rows, bdByPm, idx) {
    return rows.filter(r => {
      const [y, m0, d] = parts(r.date);
      return cycleIdx(y, m0, d, bdOf(bdByPm, r.pm)) === idx;
    });
  }

  return { dim, bdEff, cycleIdx, endDay, dayAfter, cycleRange, parseInstallment, buildSeries, computeCCUsage, cycleRowsFor };
})();
