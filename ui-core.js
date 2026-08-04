// ── TABS ──────────────────────────────────────────────────────
function switchTab(tab, el) {
  closeInputOverlay();
  closeGoalsOverlay();
  closeConfigItemOverlay();
  closeSetBalanceOverlay();
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById('nav-more').classList.remove('sub-active');
  const navBtn = tab === 'profile' ? document.getElementById('nav-more') : document.getElementById('nav-'+tab);
  if(navBtn) navBtn.classList.add('active');
  document.getElementById('page-'+tab).classList.add('active');

  if(tab==='home'){
    if(!histLoaded) onHistLoaded(()=>fetchCurrentMonth().then(()=>{ calInited=false; initCalendar(); calRefreshOpenDayPanel(); }));
    else fetchCurrentMonth().then(()=>{ calInited=false; initCalendar(); calRefreshOpenDayPanel(); });
  }
  if(tab==='insights'){
    const insPage=document.getElementById('page-insights');
    if(insPage)insPage.scrollTop=0;
    const wCtrl=document.getElementById('weeklyControls');if(wCtrl)wCtrl.style.display=insightsMode==='weekly'?'block':'none';
    const mCtrl=document.getElementById('monthlyControls');if(mCtrl)mCtrl.style.display=insightsMode==='monthly'?'block':'none';
    const yCtrl=document.getElementById('yearlyControls');if(yCtrl)yCtrl.style.display=insightsMode==='yearly'?'block':'none';
    const cCtrl=document.getElementById('categoryControls');if(cCtrl)cCtrl.style.display=insightsMode==='category'?'block':'none';
    const wEls=['weeklySummary','weeklyBarCard','weeklyDonutCard'];
    const mEls=['monthlySummary','monthlyBarCard','monthlyDonutCard'];
    const yEls=['yearlySummary','yearlyBarCard','yearlyMonthCard','yearlyDonutCard'];
    const cEls=['catRankingCard','catTrendCard'];
    wEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=insightsMode==='weekly'?'block':'none'});
    mEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=insightsMode==='monthly'?'block':'none'});
    yEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=insightsMode==='yearly'?'block':'none'});
    cEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=insightsMode==='category'?'block':'none'});
    if(!histLoaded) {
      const activeSummary=insightsMode==='weekly'?'weeklySummary':insightsMode==='yearly'?'yearlySummary':'monthlySummary';
      const el=document.getElementById(activeSummary);
      if(el)el.innerHTML='<div class="chart-loading">Loading data…</div>';
      onHistLoaded(()=>{
        fetchAccountBalances().then(()=>{ buildAccountBalances(); setInsightsSubPage(insightsSubPage); });
      });
    } else {
      fetchAccountBalances().then(()=>{ buildAccountBalances(); setInsightsSubPage(insightsSubPage); });
    }
  }
  if(tab==='networth'){
    if(!histLoaded) onHistLoaded(()=>initNetWorth());
    else initNetWorth();
  }
  if(tab==='goals'){
    fetchFxRates();
    const _loadGoals = () => Promise.all([
      fetchSheetPrices(),
      fetchLiveInvest().catch(() => {}),
      fetchAccountBalances().catch(() => {})
    ]).then(() => {
      buildAccountBalances();
      return fetchGoals();
    });
    if(!histLoaded) onHistLoaded(_loadGoals);
    else _loadGoals();
  }
  if(tab==='recurring'){
    renderRecurringList();
    fetchRecurring().then(() => renderRecurringList());
  }
  if(tab==='settings'){
    fetchConfig().then(renderSettingsLists);
  }
  if(tab==='account'){
    loadAccountUsageInfo();
  }
  if(tab==='search'){
    initSearchPage();
    if(!histLoaded) onHistLoaded(()=>{ renderSearchOrMonitor(); });
  }
}

function openInputOverlay() {
  // Reset edit state
  overlayEditRowIndex = null;
  overlayEditId = null;
  overlayEditMode = false;
  const submitBtn = document.getElementById('submitOpexBtn');
  if (submitBtn) submitBtn.textContent = 'Save Transaction';
  const delBtn = document.getElementById('deleteOpexBtn');
  if (delBtn) delBtn.style.display = 'none';
  // Reset to expense mode
  const expBtn = document.querySelector('.pill-toggle-btn[data-mode="expense"]');
  if (expBtn) setInputMode('expense', expBtn);
  // Default to selected calendar date, fall back to today
  const t = calCurrentDateStr || todayISO();
  const rawEl = document.getElementById('inputDateRaw');
  if (rawEl) {
    const b = curMonthBounds();
    rawEl.min = b.min; rawEl.max = b.max;
    rawEl.value = t; document.getElementById('inputDateText').textContent = isoDisp(t);
  }
  // Clear fields
  ['inputTx','inputAmount','inputNotes'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  // Reset recurring toggle (prevents stale state bleeding into edit sessions)
  document.getElementById('inputRecurring').checked = false;
  document.getElementById('recurringDayRow').style.display = 'none';
  document.getElementById('recurringEndRow').style.display = 'none';
  document.getElementById('inputRecurringEndMonth').value = '';
  document.getElementById('inputRecurringEndYear').value = '';
  if (typeof buildSmartPills === 'function') buildSmartPills();
  checkCcInstallmentVisibility();
  const ov = document.getElementById('inputOverlay');
  ov.classList.add('open');
  adjustOverlayForVisualViewport();
  // Focus first input after slide animation completes
  setTimeout(() => {
    const f = document.getElementById('inputTx');
    if (f) f.focus();
  }, 360);
}

function closeInputOverlay() {
  const ov = document.getElementById('inputOverlay');
  if (ov) {
    ov.classList.remove('open');
    ov.style.top = '';
    ov.style.height = '';
  }
  // Reset edit state
  overlayEditRowIndex = null;
  overlayEditId = null;
  overlayEditMode = false;
  overlayEditType = 'opex';
  const submitBtn = document.getElementById('submitOpexBtn');
  if (submitBtn) submitBtn.textContent = 'Save Transaction';
  const delBtn = document.getElementById('deleteOpexBtn');
  if (delBtn) delBtn.style.display = 'none';
  const submitInvestBtn = document.getElementById('submitInvestBtn');
  if (submitInvestBtn) submitInvestBtn.textContent = 'Save Investment';
  const delInvestBtn = document.getElementById('deleteInvestBtn');
  if (delInvestBtn) delInvestBtn.style.display = 'none';
  const submitTransferBtn = document.getElementById('submitTransferBtn');
  if (submitTransferBtn) submitTransferBtn.textContent = 'Save Transfer';
  const delTransferBtn = document.getElementById('deleteTransferBtn');
  if (delTransferBtn) delTransferBtn.style.display = 'none';
}

// ── Handle bar swipe-down to close ───────────────────────────
// Attach directly — script runs after DOM is parsed, no DOMContentLoaded needed
attachSwipeClose('inputSheetHandle', closeInputOverlay);
attachSwipeClose('goalsSheetHandle', closeGoalsOverlay);
attachSwipeClose('configItemSheetHandle', closeConfigItemOverlay);

function openInputFromHome() {
  openInputOverlay();
}

// ── SUBMIT OPEX ───────────────────────────────────────────────
function submitOpex() {
  if (isSyncing) return;
  if (overlayEditMode) {
    isSyncing = true;
    updateTransaction();
    if (document.getElementById('inputRecurring').checked) {
      const _day = parseInt(document.getElementById('inputRecurringDay').value) || 0;
      if (_day >= 1 && _day <= 31) {
        const _tx     = sanitizeInput(document.getElementById('inputTx').value, 100).trim();
        const _amount = parseGroupedAmt('inputAmount');
        const _cat    = sanitizeInput(document.getElementById('inputCat').value, 50).trim();
        const _pm     = sanitizeInput(document.getElementById('inputPm').value, 50).trim();
        const _notes  = sanitizeInput(document.getElementById('inputNotes').value, 200);
        const _end    = _getEndMonthValue('inputRecurringEndMonth', 'inputRecurringEndYear');
        if (_tx && _amount && _cat && _pm) {
          const rules = loadRecurring();
          rules.push({
            id: Date.now(), type: inputMode,
            tx: _tx, cat: _cat, amount: _amount, pm: _pm, notes: _notes,
            dayOfMonth: _day, active: true, lastFired: curMonthKey(),
            endMonth: _end || null
          });
          saveRecurring(rules);
          resetRecurringToggle();
          showToast('Recurring rule created ✓', 'success');
        }
      }
    }
    isSyncing = false;
    return;
  }
  // Set the guard before reading/validating fields (not after the optimistic
  // txHistory.unshift below) so a second rapid call can't sneak in and create a
  // duplicate local entry in the gap — see addSelectedRecurring for the same pattern.
  isSyncing = true;
  const date=document.getElementById('inputDateRaw').value;
  const tx=sanitizeInput(document.getElementById('inputTx').value,100);
  const amount=parseGroupedAmt('inputAmount');
  const cat=sanitizeInput(document.getElementById('inputCat').value,50);
  const pm=sanitizeInput(document.getElementById('inputPm').value,50);
  const notes=sanitizeInput(document.getElementById('inputNotes').value,200);
  if(!date||!tx||!amount||!cat||!pm){isSyncing=false;showToast('All fields required','error');return}

  // CC Installment Logic
  const isInstallment = document.getElementById('ccInstallmentBtn').classList.contains('active');
  const installmentMonths = parseInt(document.getElementById('inputInstallmentMonths').value) || 0;
  if (isInstallment) {
    if (installmentMonths < 2) {
      isSyncing = false;
      showToast('Installment period must be at least 2 months', 'error');
      return;
    }
  }

  let finalAmount = amount;
  let finalTx = tx;
  if (isInstallment) {
    finalAmount = Math.round(amount / installmentMonths);
    finalTx = `${tx} (1/${installmentMonths})`;
  }

  const isFuture = date > todayISO();
  const r = {id:Date.now(),date,tx:finalTx,amount:finalAmount,category:cat,pm,notes,type:inputMode,synced:false,future:isFuture};
  txHistory.unshift(r);
  queue.push({...r, action:inputMode});
  saveLocal();updateStatus();
  buildAccountBalances();
  renderAccountBalanceCards();
  // Navigate back to Home immediately, with Saving toast
  switchTab('home', null);
  showToast('Saving transaction…', 'loading', 0);
  syncOpex(r).then(ok=>{
    isSyncing = false;
    if(ok){
      queue=queue.filter(q=>q.id!==r.id);
      txHistory=txHistory.map(h=>h.id===r.id?{...h,synced:true}:h);
      saveLocal();updateStatus();showToast('Saved ✓','success');
      // Optimistically write the new row into nota_curMonth cache so the transaction
      // survives a browser close before fetchCurrentMonth(true) completes.
      // fetchCurrentMonth(true) will overwrite this with the authoritative sheet row
      // (which includes rowIndex, making it editable). Without this, deleting the
      // cache key first creates a window where a reload shows no transaction at all.
      const cacheKey=curMonthCacheKey();
      const dateParts=r.date.split('-');
      const optimisticRow={d:parseInt(dateParts[2]),cat:r.category,tx:r.tx,pm:r.pm,...(r.notes?{notes:r.notes}:{}),...(r.type==='income'?{inc:r.amount}:{exp:r.amount})};
      const cachedRows=JSON.parse(localStorage.getItem(cacheKey)||'[]');
      cachedRows.push(optimisticRow);
      localStorage.setItem(cacheKey,JSON.stringify(cachedRows));
      // Force-refresh so the new row gets rowIndex from the sheet (makes it editable)
      fetchCurrentMonth(true).then(rowCount=>{calInited=false;if(document.getElementById('page-home').classList.contains('active')){initCalendar();calRefreshOpenDayPanel();}buildAccountBalances();renderAccountBalanceCards();if(rowCount===0)showToast('Sent to sheet — couldn\'t confirm readback','error',6000);});
    }
    else showToast(navigator.onLine ? 'Saved locally — sync pending' : 'Offline — will sync when connected','');
  });
  // Save recurring rule if toggle is ON
  if (isInstallment) {
    const endMonthVal = getEndMonth(date, installmentMonths);
    const rules = loadRecurring();
    rules.push({
      id: Date.now() + 1,
      type: 'expense',
      tx: `${tx} (Installment)`,
      cat,
      amount: finalAmount,
      pm,
      notes: notes || '',
      dayOfMonth: parseInt(date.split('-')[2]) || new Date().getDate(),
      active: true,
      lastFired: dateToMonthKey(date),
      endMonth: endMonthVal,
      installmentTotal: installmentMonths,
      installmentStart: dateToMonthKey(date)
    });
    saveRecurring(rules);
  } else if (document.getElementById('inputRecurring').checked) {
    const day = parseInt(document.getElementById('inputRecurringDay').value) || 0;
    if (day >= 1 && day <= 31) {
      const endMonth = _getEndMonthValue('inputRecurringEndMonth', 'inputRecurringEndYear');
      const rules = loadRecurring();
      rules.push({
        id: Date.now(),
        type: inputMode,
        tx, cat, amount, pm, notes,
        dayOfMonth: day,
        active: true,
        lastFired: curMonthKey(),
        endMonth: endMonth || null
      });
      saveRecurring(rules);
    }
  }
  resetOpexForm();
}

function resetOpexForm() {
  const t=todayISO();
  document.getElementById('inputDateRaw').value=t;
  document.getElementById('inputDateText').textContent=isoDisp(t);
  document.getElementById('inputTx').value='';
  document.getElementById('inputAmount').value='';
  document.getElementById('inputCat').value='';
  document.getElementById('inputPm').value='';
  document.getElementById('inputNotes').value='';
  resetRecurringToggle();
  checkCcInstallmentVisibility();
}

// ── TRANSFER ──────────────────────────────────────────────────
function submitTransfer() {
  if (isSyncing) return;
  if (overlayEditMode && overlayEditType === 'transfer') { updateTransferTransaction(); return; }
  isSyncing = true;
  const date = document.getElementById('xfrDateRaw').value;
  const fromPm = sanitizeInput(document.getElementById('xfrFrom').value, 50).trim();
  const toPm = sanitizeInput(document.getElementById('xfrTo').value, 50).trim();
  const amount = parseGroupedAmt('xfrAmount');
  const notes = sanitizeInput(document.getElementById('xfrNotes').value, 200);
  if (!date || !fromPm || !toPm || !amount) { isSyncing = false; showToast('All fields required', 'error'); return; }
  if (fromPm === toPm) { isSyncing = false; showToast('From and To must be different', 'error'); return; }
  const r = { id: Date.now(), date, fromPm, toPm, amount, notes, type: 'transfer', synced: false };
  switchTab('home', null);
  showToast('Saving transfer…', 'loading', 0);

  // Optimistically save transfer locally and recompute balances
  txHistory.unshift(r);
  saveLocal();
  buildAccountBalances();
  renderAccountBalanceCards();

  syncTransfer(r).then(ok => {
    isSyncing = false;
    if (ok) {
      r.synced = true;
      saveLocal();
      showToast('Transfer saved ✓', 'success');
      Promise.all([
        fetchCurrentMonth(true),
        fetchAllOpex(),
      ]).then(() => {
        calInited = false;
        if (document.getElementById('page-home').classList.contains('active')) { initCalendar(); calRefreshOpenDayPanel(); }
        buildAccountBalances();
        renderAccountBalanceCards();
      });
    } else {
      showToast(navigator.onLine ? 'Save failed' : 'Offline — sync pending', '');
    }
  });
  resetTransferForm();
}

function resetTransferForm() {
  const t = todayISO();
  document.getElementById('xfrDateRaw').value = t;
  document.getElementById('xfrDateText').textContent = isoDisp(t);
  document.getElementById('xfrFrom').value = '';
  document.getElementById('xfrTo').value = '';
  document.getElementById('xfrAmount').value = '';
  document.getElementById('xfrNotes').value = '';
}

async function syncTransfer(r) {
  try {
    const payload = {
      type: 'transfer',
      date: isoSheetDate(r.date), month: isoMonthKey(r.date),
      fromPm: r.fromPm, toPm: r.toPm,
      amount: r.amount, notes: r.notes || '',
      clientId: String(r.id),
    };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    return j.status === 'ok' && !j.version;
  } catch (e) { console.error('[syncTransfer]', e.message); return false; }
}

async function deleteTransfer(txId) {
  if (!txId) return;
  showToast('Deleting transfer…', 'loading', 0);

  // Optimistically remove transfer from local memory and update balances immediately
  txHistory = txHistory.filter(h => h.id !== txId && h.txId !== txId && String(h.id) !== String(txId));
  HIST.opex = (HIST.opex || []).filter(r => r.id !== txId && String(r.id) !== String(txId));
  saveLocal();
  buildAccountBalances();
  renderAccountBalanceCards();

  try {
    const payload = { type: 'transfer', action: 'delete', id: txId };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      showToast('Transfer deleted ✓', 'success');
      Promise.all([fetchCurrentMonth(true), fetchAllOpex()]).then(() => {
        calInited = false;
        if (document.getElementById('page-home').classList.contains('active')) { initCalendar(); calRefreshOpenDayPanel(); }
        buildAccountBalances();
        renderAccountBalanceCards();
      });
    } else {
      showToast('Delete failed', 'error');
    }
  } catch (e) { showToast('Delete failed', 'error'); }
}

function openEditTransferOverlay(tx, dateStr = calCurrentDateStr) {
  if (!tx) return;
  overlayEditId   = tx.sheetId || null;
  overlayEditMode = true;
  overlayEditType = 'transfer';
  const btn = document.querySelector('.pill-toggle-btn[data-mode="transfer"]');
  if (btn) setInputMode('transfer', btn);
  const rawEl = document.getElementById('xfrDateRaw');
  if (rawEl && dateStr) {
    rawEl.value = dateStr;
    document.getElementById('xfrDateText').textContent = isoDisp(dateStr);
  }
  document.getElementById('xfrFrom').value   = tx.transferFromPm || '';
  document.getElementById('xfrTo').value     = tx.transferToPm   || '';
  document.getElementById('xfrAmount').value = formatGroupedAmt(tx.amt);
  document.getElementById('xfrNotes').value  = tx.notes || '';
  document.getElementById('submitTransferBtn').textContent = 'Update Transfer';
  document.getElementById('deleteTransferBtn').style.display = 'block';
  document.getElementById('inputOverlay').classList.add('open');
}

async function updateTransferTransaction() {
  const txId = overlayEditId;
  const date = document.getElementById('xfrDateRaw').value;
  const fromPm = sanitizeInput(document.getElementById('xfrFrom').value, 50).trim();
  const toPm = sanitizeInput(document.getElementById('xfrTo').value, 50).trim();
  const amount = parseGroupedAmt('xfrAmount');
  const notes = sanitizeInput(document.getElementById('xfrNotes').value, 200);
  if (!date || !fromPm || !toPm || !amount) { showToast('All fields required', 'error'); return; }
  if (fromPm === toPm) { showToast('From and To must be different', 'error'); return; }

  closeInputOverlay();
  showToast('Updating transfer…', 'loading', 0);

  // Optimistically drop the old linked pair locally — the refetch below replaces
  // it with the authoritative updated rows (same pattern as deleteTransfer).
  txHistory = txHistory.filter(h => h.id !== txId && String(h.id) !== String(txId));
  HIST.opex = (HIST.opex || []).filter(r => r.id !== txId && String(r.id) !== String(txId));
  saveLocal();
  calInited = false; initCalendar();
  buildAccountBalances();
  renderAccountBalanceCards();

  try {
    const payload = {
      type: 'transfer', action: 'edit', id: txId,
      date: isoSheetDate(date), month: isoMonthKey(date),
      fromPm, toPm, amount, notes,
    };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      showToast('Transfer updated ✓', 'success');
      await Promise.all([fetchCurrentMonth(true), fetchAllOpex()]);
      calInited = false;
      if (document.getElementById('page-home').classList.contains('active')) { initCalendar(); calRefreshOpenDayPanel(); }
      buildAccountBalances();
      renderAccountBalanceCards();
    } else {
      showToast('Update failed', 'error');
    }
  } catch (e) { showToast(navigator.onLine ? 'Update failed' : 'Offline — update pending', ''); }
}

async function deleteSheetTransferTransaction() {
  if (!confirm('Delete this transfer?')) return;
  const txId = overlayEditId;
  closeInputOverlay();
  await deleteTransfer(txId);
}

// Uncheck "Set as Recurring" and hide/clear its fields — used after a rule has
// been created (or the overlay is closing) so a stray repeat tap/submit has no
// checked recurring data left to resubmit (prevents duplicate rule creation).
function resetRecurringToggle() {
  document.getElementById('inputRecurring').checked=false;
  document.getElementById('recurringDayRow').style.display='none';
  document.getElementById('recurringEndRow').style.display='none';
  document.getElementById('inputRecurringEndMonth').value='';
  document.getElementById('inputRecurringEndYear').value='';
}

// ── LOCAL-ONLY TRANSACTION MUTATIONS ──────────────────────────
// Used as fallback when the server can't be reached or rowIndex is unknown.
// Keeps HIST.opex, txHistory, and the curMonth localStorage cache consistent.

function _applyLocalDelete(isoDate, txName, amount, rowIndex, id, isIncome) {
  const [fy, fm, fd] = isoDate.split('-').map(Number);
  const nl = txName.toLowerCase();
  // HIST.opex — prefer id (unambiguous even with duplicate rows), then rowIndex, then content match
  if (HIST.opex) {
    if (id) {
      HIST.opex = HIST.opex.filter(r => r.id !== id);
    } else if (rowIndex) {
      HIST.opex = HIST.opex.filter(r => r.rowIndex !== rowIndex);
    } else {
      const idx = HIST.opex.findIndex(r =>
        r.y === fy && r.m === fm - 1 && r.d === fd &&
        r.tx.toLowerCase() === nl && (r.exp || r.inc || 0) === amount
      );
      if (idx !== -1) HIST.opex.splice(idx, 1);
    }
  }
  // txHistory / nota_curMonth cache — trim any stuck ghosts of the same transaction down
  // to however many real HIST.opex rows with this exact signature remain. First-match-only
  // removal left a permanently-stuck synced:false ghost behind whenever the deleted row was
  // the sole real backing row and a ghost also existed (the iOS-PWA-kill race — see
  // sigOfSheetRow/sigOfTxHistory). Count-based so deleting one of several genuinely-identical
  // transactions still only removes one.
  const sig = txSig(fd, txName, amount, isIncome);
  const remainingOpexCount = (HIST.opex || [])
    .filter(r => r.y === fy && r.m === fm - 1 && sigOfSheetRow(r) === sig).length;

  let kept = 0;
  txHistory = txHistory.filter(h => {
    if (h.date !== isoDate || sigOfTxHistory(h) !== sig) return true;
    kept++;
    return kept <= remainingOpexCount;
  });
  localStorage.setItem('notapub_history_v2', JSON.stringify(txHistory));

  // queue (nota_queue_v2) — same trim. Without this, a swept txHistory ghost's still-queued
  // retry entry survives, and retryPendingQueue() resurrects it as a brand-new real
  // transaction on the next app load (HIST.opex legitimately has 0 matching rows post-delete,
  // so the "already covered" guard in retryPendingQueue can't catch it).
  let qKept = 0;
  queue = queue.filter(q => {
    if (q.date !== isoDate || sigOfTxHistory(q) !== sig) return true;
    qKept++;
    return qKept <= remainingOpexCount;
  });
  localStorage.setItem('notapub_queue_v2', JSON.stringify(queue));

  const cKey = curMonthCacheKey(fy, fm);
  const cached = JSON.parse(localStorage.getItem(cKey) || '[]');
  let cKept = 0;
  const trimmedCache = cached.filter(r => {
    if (r.d !== fd || sigOfSheetRow(r) !== sig) return true;
    cKept++;
    return cKept <= remainingOpexCount;
  });
  localStorage.setItem(cKey, JSON.stringify(trimmedCache));
}

function _applyLocalEdit(isoDate, txName, amount, newDate, newTx, newAmount, newCat, newPm, newNotes, newIsIncome, rowIndex, id) {
  const [fy, fm, fd] = isoDate.split('-').map(Number);
  const [nfy, nfm, nfd] = newDate.split('-').map(Number);
  const nl = txName.toLowerCase();
  const newIsFuture = newDate > todayISO();
  // HIST.opex — prefer id (unambiguous even with duplicate rows), then rowIndex, then content match
  if (HIST.opex) {
    HIST.opex = HIST.opex.map(r => {
      const matches = id ? r.id === id
        : rowIndex ? r.rowIndex === rowIndex
        : (r.y === fy && r.m === fm-1 && r.d === fd && r.tx.toLowerCase() === nl && (r.exp||r.inc||0) === amount);
      if (matches) {
        return {...r, y:nfy, m:nfm-1, d:nfd, tx:newTx, cat:newCat, pm:newPm, notes:newNotes||'',
                inc: newIsIncome ? newAmount : 0, exp: newIsIncome ? 0 : newAmount, amt: newAmount, future: newIsFuture};
      }
      return r;
    });
    // Defense in depth: an unconfirmed (no-rowIndex) optimistic placeholder for the OLD
    // day can exist separately from the row that was just matched/moved above (e.g. a
    // recurring-add's optimistic cache row that hasn't been reconciled into HIST.opex
    // with a rowIndex yet). calGetMonthData's ghost-filter only recognizes a placeholder
    // as stale when a CONFIRMED row shares its day+signature — but the day was just
    // vacated by this edit, so nothing on the old day will ever look "confirmed" again.
    // Strip any such leftover here so it can't survive to be re-displayed as a ghost.
    const beforeLen = HIST.opex.length;
    HIST.opex = HIST.opex.filter(r => !(
      !r.rowIndex && r.y === fy && r.m === fm-1 && r.d === fd &&
      (r.tx||'').toLowerCase() === nl && (r.exp||r.inc||0) === amount
    ));
    if (HIST.opex.length !== beforeLen) {
      dupDebugLog('_applyLocalEdit:strippedStaleOldDayPlaceholder', { isoDate, txName, amount, newDate });
    }
  }
  // txHistory
  txHistory = txHistory.map(h => {
    if (h.date === isoDate && h.tx.toLowerCase() === nl && h.amount === amount) {
      return {...h, date:newDate, tx:newTx, amount:newAmount, category:newCat, pm:newPm,
              notes:newNotes||'', type: newIsIncome ? 'income' : 'expense', future: newIsFuture};
    }
    return h;
  });
  localStorage.setItem('notapub_history_v2', JSON.stringify(txHistory));
  // nota_curMonth cache: remove from old month, add to new month
  const oldKey = curMonthCacheKey(fy, fm);
  const oldCached = JSON.parse(localStorage.getItem(oldKey) || '[]');
  localStorage.setItem(oldKey, JSON.stringify(
    oldCached.filter(r => !(r.d === fd && (r.tx||'').toLowerCase() === nl && (r.exp||r.inc||0) === amount))
  ));
  const newKey = curMonthCacheKey(nfy, nfm);
  const newCached = JSON.parse(localStorage.getItem(newKey) || '[]');
  const newRow = {d:nfd, cat:newCat, tx:newTx, pm:newPm,
                  ...(newNotes ? {notes:newNotes} : {}),
                  ...(newIsIncome ? {inc:newAmount} : {exp:newAmount})};
  newCached.push(newRow);
  localStorage.setItem(newKey, JSON.stringify(newCached));
}

// ── EDIT / DELETE TRANSACTION ─────────────────────────────────
function openEditOverlay(idx) {
  let tx = calCurrentTxns[idx];
  if (!tx) return;
  openEditOverlayFromRow(tx, calCurrentDateStr);
}

// Shared core for opening the edit overlay from any transaction row source
// (calendar day panel via openEditOverlay, or Search page via openSearchTxEdit).
// `row` may be a calCurrentTxns-shaped entry (amt/inc/cat) or a raw HIST.opex/
// txHistory row (exp/inc/amount, cat/category) — both are normalized below.
function openEditOverlayFromRow(row, dateStr) {
  let tx = row;
  const amt = tx.amt != null ? tx.amt : (tx.amount || tx.exp || tx.inc || 0);
  const cat = tx.cat || tx.category || '';
  // Try HIST.opex for a rowIndex/id (fast path; works once fresh data is cached).
  // If rowIndex is still missing the server will find the row by content via _findRowIndex.
  if (!tx.rowIndex && dateStr) {
    const [fy, fm, fd] = dateStr.split('-').map(Number);
    const live = (HIST.opex || []).find(r =>
      r.y === fy && r.m === fm - 1 && r.d === fd && r.rowIndex &&
      r.tx.toLowerCase() === tx.tx.toLowerCase() &&
      (r.exp || r.inc || 0) === amt
    );
    if (live) tx = {...tx, rowIndex: live.rowIndex, sheetId: live.id || null};
  }
  const rowIndex = tx.rowIndex || null;
  const sheetId  = tx.sheetId || tx.id || null;
  overlayEditRowIndex = rowIndex;
  overlayEditId       = sheetId;
  overlayEditMode = true;

  // Store original identifying info so the server can find the row by content
  // when rowIndex is unavailable (old Apps Script cache / stale response).
  overlayEditOrigDate  = dateStr ? isoSheetDate(dateStr) : '';
  overlayEditOrigMonth = dateStr ? isoMonthKey(dateStr)  : '';
  overlayEditOrigTx    = tx.tx  || '';
  overlayEditOrigAmt   = amt || 0;
  overlayEditOrigInc   = (tx.inc || 0) > 0;

  // Set mode pill (income vs expense)
  const mode = tx.inc > 0 ? 'income' : 'expense';
  const modeBtn = document.querySelector(`.pill-toggle-btn[data-mode="${mode}"]`);
  if (modeBtn) setInputMode(mode, modeBtn);

  // Pre-fill date from the transaction's own date. Only clamp to current-month
  // bounds when the transaction actually falls in the current month — editing
  // an older transaction shouldn't be blocked from keeping its original date.
  const rawEl = document.getElementById('inputDateRaw');
  if (rawEl) {
    const b = curMonthBounds();
    if (dateStr && dateStr >= b.min && dateStr <= b.max) {
      rawEl.min = b.min; rawEl.max = b.max;
    } else {
      rawEl.removeAttribute('min'); rawEl.removeAttribute('max');
    }
    if (dateStr) {
      rawEl.value = dateStr;
      document.getElementById('inputDateText').textContent = isoDisp(dateStr);
    }
  }

  // Pre-fill fields
  document.getElementById('inputTx').value     = tx.tx    || '';
  document.getElementById('inputAmount').value = formatGroupedAmt(amt);
  document.getElementById('inputCat').value    = cat;
  document.getElementById('inputPm').value     = tx.pm    || '';
  document.getElementById('inputNotes').value  = tx.notes || '';

  // Pre-set the recurring day from the transaction's date (user still must toggle recurring ON)
  const _recurringDay = parseInt(dateStr?.split('-')[2] || tx.d) || new Date().getDate();
  document.getElementById('inputRecurringDay').value = _recurringDay;

  // Switch button labels
  document.getElementById('submitOpexBtn').textContent = 'Update Transaction';
  document.getElementById('deleteOpexBtn').style.display = 'block';

  checkCcInstallmentVisibility();
  document.getElementById('inputOverlay').classList.add('open');
}

async function updateTransaction() {
  _suppressVisRefresh = true;
  const rowIndex = overlayEditRowIndex;
  const id = overlayEditId;
  const date   = document.getElementById('inputDateRaw').value;
  const tx     = document.getElementById('inputTx').value.trim();
  const amount = parseGroupedAmt('inputAmount');
  const cat    = document.getElementById('inputCat').value.trim();
  const pm     = document.getElementById('inputPm').value.trim();
  const notes  = document.getElementById('inputNotes').value.trim();
  const isInc  = inputMode === 'income';
  if (!date || !tx || !amount || !cat || !pm) { showToast('All fields required', 'error'); return; }
  const isFuture = date > todayISO();

  // Snapshot orig values before closeInputOverlay clears them
  const origDate = overlayEditOrigDate;
  const origMonth = overlayEditOrigMonth;
  const origTx  = overlayEditOrigTx;
  const origAmt = overlayEditOrigAmt;
  const origInc = overlayEditOrigInc;
  const origISO = calCurrentDateStr;

  // Apply locally first — calendar updates immediately
  _applyLocalEdit(origISO, origTx, origAmt, date, tx, amount, cat, pm, notes, isInc, rowIndex, id);
  closeInputOverlay();
  calInited = false; initCalendar();
  buildAccountBalances();
  renderAccountBalanceCards();
  if (document.getElementById('page-search').classList.contains('active')) {
    renderSearchOrMonitor();
    if (searchActiveQuery) performSearch(searchActiveQuery);
  }
  showToast('Updating…', 'loading', 0);

  const payload = {
    type: 'opex', action: 'edit', rowIndex, id,
    date: isoSheetDate(date), month: isoMonthKey(date),
    cat, tx, pm, amount, notes, isIncome: isInc, future: isFuture,
    origDate, origMonth, origTx, origAmt, origIsIncome: origInc
  };
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      // Refresh from server to get authoritative rowIndex. _applyLocalEdit() already
      // patched the old-day/new-day cache entries precisely above — don't blind-wipe
      // the whole month's cache here, that only widens the window where a stale
      // in-flight fetch (see curMonthFetchSeq) is the sole data to merge against.
      await fetchCurrentMonth(true);
      calInited = false; initCalendar();
      buildAccountBalances();
      renderAccountBalanceCards();
      if (document.getElementById('page-search').classList.contains('active')) {
        renderSearchOrMonitor();
        if (searchActiveQuery) performSearch(searchActiveQuery);
      }
      showToast('Updated ✓', 'success');
    } else {
      showToast('Updated locally ✓', 'success');
    }
  } catch(e) {
    showToast(navigator.onLine ? 'Updated locally ✓' : 'Offline — updated locally', 'success');
  } finally {
    _suppressVisRefresh = false;
  }
}

async function deleteSheetTransaction() {
  if (!confirm('Delete this transaction?')) return;
  // On iOS PWA, the native confirm() dialog fires visibilitychange when dismissed.
  // Suppress the visibility-triggered fetch so it doesn't restore the deleted row
  // from the sheet before the server has processed the delete.
  _suppressVisRefresh = true;
  const rowIndex = overlayEditRowIndex;
  const id = overlayEditId;

  // Snapshot before closeInputOverlay clears state
  const origDate  = overlayEditOrigDate;
  const origMonth = overlayEditOrigMonth;
  const origTx    = overlayEditOrigTx;
  const origAmt   = overlayEditOrigAmt;
  const origInc   = overlayEditOrigInc;
  const origISO   = calCurrentDateStr;

  // Delete locally first — calendar updates immediately regardless of server
  _applyLocalDelete(origISO, origTx, origAmt, rowIndex, id, origInc);
  closeInputOverlay();
  calInited = false; initCalendar();
  buildAccountBalances();
  renderAccountBalanceCards();
  if (document.getElementById('page-search').classList.contains('active')) {
    renderSearchOrMonitor();
    if (searchActiveQuery) performSearch(searchActiveQuery);
  }
  showToast('Deleting…', 'loading', 0);

  const payload = {
    type: 'opex', action: 'delete', rowIndex, id,
    origDate, origMonth, origTx, origAmt, origIsIncome: origInc
  };
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      showToast('Deleted ✓', 'success');
      // Force-refresh cache from sheet so the deleted row is gone from localStorage.
      // This prevents the stale cache from showing the deleted transaction on next startup.
      fetchCurrentMonth(true).then(() => {
        calInited = false;
        if (document.getElementById('page-home').classList.contains('active')) initCalendar();
        buildAccountBalances();
        renderAccountBalanceCards();
        if (document.getElementById('page-search').classList.contains('active')) {
          renderSearchOrMonitor();
          if (searchActiveQuery) performSearch(searchActiveQuery);
        }
      });
    } else {
      showToast('Deleted locally ✓', 'success');
    }
  } catch(e) {
    showToast(navigator.onLine ? 'Deleted locally ✓' : 'Offline — deleted locally', 'success');
  } finally {
    _suppressVisRefresh = false;
  }
}

// ── EDIT / DELETE INVEST TRANSACTION ───────────────────────────
function openEditInvestOverlay(row) {
  if (!row) return;
  overlayEditRowIndex = row.rowIndex || null;
  overlayEditId       = row.id || null;
  overlayEditMode = true;
  overlayEditType = 'invest';

  const modeBtn = document.querySelector('.pill-toggle-btn[data-mode="invest"]');
  if (modeBtn) setInputMode('invest', modeBtn);

  const actionBtn = document.querySelector(`.action-btn[data-action="${row.action === 'Sell' ? 'Sell' : 'Buy'}"]`);
  if (actionBtn) setInvestAction(row.action === 'Sell' ? 'Sell' : 'Buy', actionBtn);

  const dateIso = row.date ? String(row.date).slice(0, 10) : todayISO();
  document.getElementById('inputDateRawI').value = dateIso;
  document.getElementById('inputDateTextI').textContent = isoDisp(dateIso);
  document.getElementById('inputStock').value   = row.stock   || '';
  document.getElementById('inputAccount').value = row.account || '';
  document.getElementById('inputLot').value     = row.lot ? formatGroupedAmt(row.lot) : '';
  document.getElementById('inputPrice').value   = row.price ? formatGroupedAmt(row.price) : '';
  document.getElementById('inputTotal').value   = row.totalIdr ? formatGroupedAmt(row.totalIdr) : '';

  document.getElementById('submitInvestBtn').textContent = 'Update Investment';
  document.getElementById('deleteInvestBtn').style.display = 'block';

  document.getElementById('inputOverlay').classList.add('open');
}

async function updateInvestTransaction() {
  const rowIndex = overlayEditRowIndex;
  const id = overlayEditId;
  const date=document.getElementById('inputDateRawI').value;
  const stock=sanitizeInput(document.getElementById('inputStock').value,50);
  const account=sanitizeInput(document.getElementById('inputAccount').value,30);
  const lot=parseAmt('inputLot');
  const price=parseAmt('inputPrice');
  const total=parseAmt('inputTotal');
  if(!date||!stock||!account||!lot||!price){showToast('All fields required','error');return}
  closeInputOverlay();
  showToast('Updating…', 'loading', 0);
  const payload = {
    type:'invest', op:'edit', id, rowIndex,
    date:isoSheetDate(date), month:isoMonthKey(date), stock,
    stockType:STOCK_TYPE[stock]||'', action:investAction,
    account, lot, price, totalIdr:total,
  };
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      await fetchLiveInvest();
      localStorage.removeItem(curMonthCacheKey());
      await fetchCurrentMonth(true);
      if (document.getElementById('page-search').classList.contains('active')) renderSearchOrMonitor();
      buildAccountBalances();
      renderAccountBalanceCards();
      showToast('Updated ✓', 'success');
    } else {
      showToast('Update failed', 'error');
    }
  } catch(e) {
    showToast(navigator.onLine ? 'Update failed' : 'Offline — try again later', 'error');
  }
}

async function deleteSheetInvestTransaction() {
  if (!confirm('Delete this investment transaction?')) return;
  const rowIndex = overlayEditRowIndex;
  const id = overlayEditId;
  closeInputOverlay();
  showToast('Deleting…', 'loading', 0);
  const payload = { type:'invest', op:'delete', id, rowIndex };
  try {
    const res = await fetchWithTimeout(APPS_SCRIPT_URL, { method: 'POST', headers: {'Content-Type': 'text/plain'}, body: apiBody(payload) });
    const j = await res.json().catch(() => ({}));
    if (j.status === 'ok') {
      await fetchLiveInvest();
      localStorage.removeItem(curMonthCacheKey());
      await fetchCurrentMonth(true);
      if (document.getElementById('page-search').classList.contains('active')) renderSearchOrMonitor();
      buildAccountBalances();
      renderAccountBalanceCards();
      showToast('Deleted ✓', 'success');
    } else {
      showToast('Delete failed', 'error');
    }
  } catch(e) {
    showToast(navigator.onLine ? 'Delete failed' : 'Offline — try again later', 'error');
  }
}

// ── SUBMIT INVEST ─────────────────────────────────────────────
function submitInvest() {
  if (isSyncing) return;
  if (overlayEditMode && overlayEditType === 'invest') { updateInvestTransaction(); return; }
  const date=document.getElementById('inputDateRawI').value;
  const stock=sanitizeInput(document.getElementById('inputStock').value,50);
  const account=sanitizeInput(document.getElementById('inputAccount').value,30);
  const lot=parseAmt('inputLot');
  const price=parseAmt('inputPrice');
  const total=parseAmt('inputTotal');
  if(!date||!stock||!account||!lot||!price){showToast('All fields required','error');return}
  const r={id:Date.now(),date,stock,account,action:investAction,lot,price,totalIdr:total,type:'invest',synced:false};
  investHistory.unshift(r);
  queue.push({...r});
  saveLocal();updateStatus();
  buildAccountBalances();
  renderAccountBalanceCards();
  const investBtn = document.querySelector('#form-invest .submit-btn');
  if (investBtn) { investBtn.disabled = true; investBtn.textContent = 'Saving…'; }
  isSyncing = true;
  syncInvest(r).then(ok=>{
    isSyncing = false;
    if (investBtn) { investBtn.disabled = false; investBtn.textContent = 'Save Investment'; }
    if(ok){
      queue=queue.filter(q=>q.id!==r.id);
      investHistory=investHistory.map(h=>h.id===r.id?{...h,synced:true}:h);
      saveLocal();updateStatus();showToast('Saved ✓','success');
      // Refresh HIST.opex so the Opex expense row created by the invest sync is included
      localStorage.removeItem(curMonthCacheKey());
      fetchCurrentMonth(true).then(() => { buildAccountBalances(); renderAccountBalanceCards(); });
    }
    else showToast(navigator.onLine ? 'Saved locally — sync pending' : 'Offline — will sync when connected','');
  });
  const t=todayISO();
  document.getElementById('inputDateRawI').value=t;
  document.getElementById('inputDateTextI').textContent=isoDisp(t);
  document.getElementById('inputStock').value='';
  document.getElementById('inputAccount').value='';
  document.getElementById('inputLot').value='';
  document.getElementById('inputPrice').value='';
  document.getElementById('inputTotal').value='';
  const _ca=document.getElementById('investCurrentAvg'); if(_ca)_ca.textContent='—';
  const _na=document.getElementById('investNewAvg'); if(_na)_na.textContent='—';
}

// ── SYNC ──────────────────────────────────────────────────────
async function syncOpex(r) {
  try {
    const sheetDate = isoSheetDate(r.date);
    const monthHeader = isoMonthKey(r.date);
    const month = isoMonthKey(r.date);
    const payload = {
      type:'opex', action:r.type,
      date:sheetDate, month, monthHeader,
      tx:r.tx, cat:r.category, pm:r.pm, amount:r.amount, notes:r.notes||'', future:r.future||false,
      clientId: String(r.id)
    };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:apiBody(payload)});
    const j = await res.json().catch(()=>({}));
    // Guard: doGet fallback returns {status:'ok', version:N} — not a real write
    return j.status === 'ok' && !j.version;
  } catch(e){console.error('[syncOpex]',e.message);return false}
}
async function syncInvest(r) {
  try {
    const sheetDate = isoSheetDate(r.date);
    const payload = {
      type:'invest', date:sheetDate, stock:r.stock,
      stockType:STOCK_TYPE[r.stock]||'',
      action:r.action, account:r.account||'', lot:r.lot, price:r.price, totalIdr:r.totalIdr,
      clientId: String(r.id)
    };
    const res = await fetchWithTimeout(APPS_SCRIPT_URL,{method:'POST',headers:{'Content-Type':'text/plain'},body:apiBody(payload)});
    const j = await res.json().catch(()=>({}));
    return j.status === 'ok' && !j.version;
  } catch(e){console.error('[syncInvest]',e.message);return false}
}

// ── LOCAL STORAGE ─────────────────────────────────────────────
function saveLocal(){
  localStorage.setItem('notapub_queue_v2',JSON.stringify(queue));
  localStorage.setItem('notapub_history_v2',JSON.stringify(txHistory));
  localStorage.setItem('notapub_invest_v2',JSON.stringify(investHistory));
  updateFabBadge();
}
function updateFabBadge(){
  const b=document.getElementById('fabQueueBadge');
  if(b) b.style.display='none';
}
function pruneStaleHistory(){
  if(!txHistory.length) return;
  // Build map of month key → row count in data.json
  const histMonthCounts={};
  HIST.opex.forEach(r=>{ histMonthCounts[r.mk]=(histMonthCounts[r.mk]||0)+1; });
  if(!Object.keys(histMonthCounts).length) return;
  // Never prune current-month entries — they may carry rowIndex for editing
  const today=new Date();
  const curMk=`${MO[today.getMonth()]} ${today.getFullYear()}`;
  // Also protect the previous month in case data.json hasn't been fully archived yet
  const prevDate=new Date(today.getFullYear(),today.getMonth()-1,1);
  const prevMk=`${MO[prevDate.getMonth()]} ${prevDate.getFullYear()}`;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const before=txHistory.length;
  txHistory=txHistory.filter(r=>{
    if(!r.synced) return true; // never drop unsynced
    if(r.date && typeof r.date === 'string' && r.date < cutoffStr) return false; // aggressively drop synced > 60 days
    if(!r.date || typeof r.date !== 'string') return true;
    const mk=isoMonthKey(r.date);
    if(mk===curMk) return true; // keep current month
    if(mk===prevMk) return true; // keep previous month (may not be fully archived yet)
    return !(histMonthCounts[mk]>=10); // drop only if well-represented in data.json
  });
  if(txHistory.length<before){
    localStorage.setItem('notapub_history_v2',JSON.stringify(txHistory));
  }
}
function updateStatus(){}
function showToast(msg,type,duration){
  const t=document.getElementById('toast');t.textContent=msg;
  t.className='toast show'+(type?' '+type:'');
  if(duration===0)return; // persistent — caller must dismiss
  setTimeout(()=>t.className='toast',duration||3000);
}
function hideToast(){
  const t=document.getElementById('toast');t.className='toast';
}

// ── INSIGHTS ──────────────────────────────────────────────────
let insightsSubPage = 'accounts';
let ccMonitorDate = new Date();
let ccMonitorPmFilter = 'all';

function setInsightsSubPage(sub, el) {
  insightsSubPage = sub || 'accounts';
  const toggle = document.getElementById('insightsSubPageToggle');
  if (toggle) {
    toggle.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sub === insightsSubPage);
    });
  }

  const subAccounts = document.getElementById('insightsSubAccounts');
  const subExpense = document.getElementById('insightsSubExpense');

  if (subAccounts) subAccounts.style.display = (insightsSubPage === 'accounts' ? 'block' : 'none');
  if (subExpense) subExpense.style.display = (insightsSubPage === 'expense' ? 'block' : 'none');

  if (insightsSubPage === 'accounts') {
    renderAccountBalanceCards();
  } else if (insightsSubPage === 'expense') {
    renderInsightsAccountFilter();
    renderChartTab(insightsMode);
  }
}

function changeCCMonth(delta) {
  ccMonitorDate.setMonth(ccMonitorDate.getMonth() + delta);
  renderCCMonitor();
}

function onCCPmChange(val) {
  ccMonitorPmFilter = val;
  renderCCMonitor();
}

function renderInsightsAccountFilter() {
  const select = document.getElementById('insightsAccountFilter');
  if (!select) return;
  const pmList = Array.from(new Set(allPMs || []));
  let html = `<option value="all"${insightsAccountFilterVal === 'all' ? ' selected' : ''}>All Accounts</option>`;
  html += pmList.map(pm => `<option value="${esc(pm)}"${insightsAccountFilterVal === pm ? ' selected' : ''}>${esc(pm)}</option>`).join('');
  select.innerHTML = html;
}

function onInsightsAccountFilterChange(val) {
  insightsAccountFilterVal = val;
  wView = val;
  mView = val;
  yView = val;
  cView = val;
  renderChartTab(insightsMode);
}

function renderCCMonitor() {
  const container = document.getElementById('searchMonitorContainer');
  if (!container) return;

  const curY = ccMonitorDate.getFullYear();
  const curM = ccMonitorDate.getMonth() + 1; // 1-12
  const monthNameStr = new Date(curY, curM - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });

  // 1. Get all available payment methods (from settings/history config)
  const pmList = Array.from(new Set(allPMs || []));

  const targetPms = (ccMonitorPmFilter === 'all')
    ? pmList.map(p => p.toLowerCase())
    : [ccMonitorPmFilter.toLowerCase()];

  function isMatchPM(pmVal) {
    if (!pmVal) return false;
    const low = String(pmVal).toLowerCase().trim();
    return targetPms.some(t => low.includes(t) || t.includes(low));
  }

  // 2. Fetch current month opex transactions (both expenses and incomes)
  const currentTxns = [];
  (HIST.opex || []).forEach((r, i) => {
    if (r.y === curY && r.m === (curM - 1) && isMatchPM(r.pm)) {
      const isInc = (r.inc || 0) > 0;
      currentTxns.push({
        source: 'hist-opex',
        idx: i,
        day: r.d,
        desc: r.tx || r.notes || (isInc ? 'Income' : 'Expense'),
        category: r.cat || (isInc ? 'Income' : 'Other'),
        pm: r.pm || '',
        amount: Number(isInc ? r.inc : r.exp) || 0,
        type: isInc ? 'income' : 'expense',
        row: r
      });
    }
  });

  const isCurrentCalMonth = (curY === new Date().getFullYear() && curM === (new Date().getMonth() + 1));
  (txHistory || []).forEach((r, i) => {
    if (isCurrentCalMonth && r.synced) return;
    if (!r.date) return;
    const parts = r.date.split('-');
    if (+parts[0] === curY && +parts[1] === curM && isMatchPM(r.pm)) {
      const isInc = r.type === 'income';
      currentTxns.push({
        source: 'local-opex',
        idx: i,
        day: parseInt(parts[2], 10),
        desc: r.tx || r.notes || (isInc ? 'Income' : 'Expense'),
        category: r.category || (isInc ? 'Income' : 'Other'),
        pm: r.pm || '',
        amount: Number(r.amount) || 0,
        type: r.type,
        row: r
      });
    }
  });

  // Previous month opex expenses and income total for comparison
  let prevY = curY;
  let prevM = curM - 1;
  if (prevM < 1) { prevM = 12; prevY--; }
  let prevTotal = 0;
  let prevIncomeTotal = 0;
  (HIST.opex || []).forEach(r => {
    if (r.y === prevY && r.m === (prevM - 1) && isMatchPM(r.pm)) {
      if ((r.exp || 0) > 0) prevTotal += Number(r.exp) || 0;
      if ((r.inc || 0) > 0) prevIncomeTotal += Number(r.inc) || 0;
    }
  });

  currentTxns.sort((a, b) => b.day - a.day || b.amount - a.amount);
  const currentTotalExpenses = currentTxns.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  const currentTotalIncome = currentTxns.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const txCount = currentTxns.length;

  let compDiffHtml = '';
  if (prevTotal > 0) {
    const diffPct = Math.round(((currentTotalExpenses - prevTotal) / prevTotal) * 100);
    const sign = diffPct > 0 ? '+' : '';
    const color = diffPct > 0 ? 'var(--red)' : 'var(--accent)';
    compDiffHtml = `<span style="color:${color};font-weight:600">${sign}${diffPct}%</span> vs prev month`;
  } else {
    compDiffHtml = 'No prev month comparison';
  }

  let compIncomeDiffHtml = '';
  if (prevIncomeTotal > 0) {
    const diffPct = Math.round(((currentTotalIncome - prevIncomeTotal) / prevIncomeTotal) * 100);
    const sign = diffPct > 0 ? '+' : '';
    const color = diffPct > 0 ? 'var(--green)' : 'var(--red)';
    compIncomeDiffHtml = `<span style="color:${color};font-weight:600">${sign}${diffPct}%</span> vs prev month`;
  } else {
    compIncomeDiffHtml = 'No prev month comparison';
  }

  let html = `
    <!-- Header Controls -->
    <div class="chart-card" style="margin-bottom:12px;padding:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <button class="toggle-btn" style="flex:0 0 auto;padding:6px 12px;font-size:12px" onclick="changeCCMonth(-1)">‹ Prev</button>
        <div style="font-size:15px;font-weight:700;color:var(--text)">${monthNameStr}</div>
        <button class="toggle-btn" style="flex:0 0 auto;padding:6px 12px;font-size:12px" onclick="changeCCMonth(1)">Next ›</button>
      </div>

      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:12px;color:var(--text2);white-space:nowrap">Account Filter:</span>
        <select class="form-input" style="padding:6px 10px;font-size:12px;border-radius:var(--radius-sm)" onchange="onCCPmChange(this.value)">
          <option value="all"${ccMonitorPmFilter==='all'?' selected':''}>All Accounts</option>
          ${pmList.map(pm => `<option value="${esc(pm)}"${ccMonitorPmFilter===pm?' selected':''}>${esc(pm)}</option>`).join('')}
        </select>
      </div>
    </div>

    <!-- Summary Stats -->
    <div class="summary-row" style="grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
      <div class="summary-card">
        <div class="s-label">Total Expenses</div>
        <div class="s-value" style="color:var(--text);font-size:19px">${fRp(currentTotalExpenses)}</div>
        <div class="s-sub">${compDiffHtml}</div>
      </div>
      <div class="summary-card">
        <div class="s-label">Total Income</div>
        <div class="s-value" style="color:var(--green);font-size:19px">${fRp(currentTotalIncome)}</div>
        <div class="s-sub">${compIncomeDiffHtml}</div>
      </div>
    </div>

    <!-- Transaction List -->
    <div class="chart-card">
      <div class="chart-card-title">Transactions (${txCount})</div>
      ${currentTxns.length === 0 ? `
        <div style="text-align:center;padding:24px 0;color:var(--text2);font-size:13px">
          No transactions recorded for ${monthNameStr}
        </div>
      ` : `
        <div style="display:flex;flex-direction:column;gap:0">
          ${currentTxns.map(item => {
            const t = item.row;
            const isInc = item.type === 'income';
            const catColor = CAT_COLORS[t.cat || t.category] || 'var(--text2)';
            const amountStr = (isInc ? '+' : '-') + fRpS(item.amount);
            const amountColor = isInc ? 'var(--green)' : 'var(--text)';
            const dispDate = monthNameStr.split(' ')[0] + ' ' + item.day;
            const tapAttrs = `data-idx="${item.idx}" data-source="${item.source}" data-type="opex" style="cursor:pointer"`;
            return `
              <div class="detail-item" style="padding:10px 0" ${tapAttrs}>
                <div style="flex:1;min-width:0;padding-right:8px">
                  <div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                    ${esc(t.tx || t.desc || '')}
                  </div>
                  <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                    <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg3);color:${catColor};font-weight:600">
                      ${esc(t.cat || t.category || '')}
                    </span>
                    <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg3);color:var(--text2)">
                      ${esc(t.pm || '')}
                    </span>
                    <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:var(--bg3);color:var(--text2)">
                      ${dispDate}
                    </span>
                  </div>
                </div>
                <div style="font-size:14px;font-weight:700;color:${amountColor};white-space:nowrap">
                  ${amountStr}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;

  container.innerHTML = html;
}

function setIM(mode,el){
  insightsMode=mode;
  toggleActive('#insightsModeToggle .toggle-btn',el);
  const wCtrl=document.getElementById('weeklyControls');if(wCtrl)wCtrl.style.display=mode==='weekly'?'block':'none';
  const mCtrl=document.getElementById('monthlyControls');if(mCtrl)mCtrl.style.display=mode==='monthly'?'block':'none';
  const yCtrl=document.getElementById('yearlyControls');if(yCtrl)yCtrl.style.display=mode==='yearly'?'block':'none';
  const cCtrl=document.getElementById('categoryControls');if(cCtrl)cCtrl.style.display=mode==='category'?'block':'none';
  const wEls=['weeklySummary','weeklyBarCard','weeklyDonutCard'];
  const mEls=['monthlySummary','monthlyBarCard','monthlyDonutCard'];
  const yEls=['yearlySummary','yearlyBarCard','yearlyMonthCard','yearlyDonutCard'];
  const cEls=['catRankingCard','catTrendCard'];
  wEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=mode==='weekly'?'block':'none'});
  mEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=mode==='monthly'?'block':'none'});
  yEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=mode==='yearly'?'block':'none'});
  cEls.forEach(id=>{const e=document.getElementById(id);if(e)e.style.display=mode==='category'?'block':'none'});
  renderChartTab(mode);
}
function setWV(v,el){wView=v;wSelWeek=null;wSelCat=null;toggleActive('#weeklySourceToggle .toggle-btn',el);renderWeekly()}
function setWR(r,el){wRange=r;wSelWeek=null;wSelCat=null;toggleActive('#weeklyRangeToggle .toggle-btn',el);renderWeekly()}
function setMV(v,el){mView=v;mSelMonth=null;mSelCat=null;toggleActive('#monthlySourceToggle .toggle-btn',el);renderMonthly()}
function setMR(r,el){mRange=r;mSelMonth=null;mSelCat=null;toggleActive('#monthlyRangeToggle .toggle-btn',el);renderMonthly()}
function setYV(v,el){yView=v;ySelYear=null;ySelCat=null;toggleActive('#yearlySourceToggle .toggle-btn',el);renderYearly()}
function setYR(r,el){yRange=r;ySelYear=null;ySelCat=null;toggleActive('#yearlyRangeToggle .toggle-btn',el);renderYearly()}
function setCV(v,el){cView=v;cSelCat=null;toggleActive('#catSourceToggle .toggle-btn',el);renderCategory()}
function setCR(r,el){cRange=r;cSelCat=null;toggleActive('#catRangeToggle .toggle-btn',el);renderCategory()}

function renderChartTab(tab){
  if(tab==='weekly')renderWeekly();
  else if(tab==='monthly')renderMonthly();
  else if(tab==='yearly')renderYearly();
  else renderCategory();
}

function getMondayOfDate(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return date;
}
function formatWeekRange(mon, sun) {
  if (mon.getFullYear() === sun.getFullYear()) {
    if (mon.getMonth() === sun.getMonth()) {
      return `${mon.getDate()}-${sun.getDate()} ${MO[mon.getMonth()]} ${mon.getFullYear()}`;
    } else {
      return `${mon.getDate()} ${MO[mon.getMonth()]} - ${sun.getDate()} ${MO[sun.getMonth()]} ${mon.getFullYear()}`;
    }
  } else {
    return `${mon.getDate()} ${MO[mon.getMonth()]} ${mon.getFullYear()} - ${sun.getDate()} ${MO[sun.getMonth()]} ${sun.getFullYear()}`;
  }
}
function getShortWeekLabelFromKey(k) {
  return String(k || '').replace(/ \d{4}$/, '');
}
function getWeekKeyOfRow(r) {
  if (!r || !r.y || r.m === undefined || !r.d) return '';
  const date = new Date(r.y, r.m, r.d);
  const mon = getMondayOfDate(date);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return formatWeekRange(mon, sun);
}
function getWeeklyKeys() {
  const now = new Date();
  const curMon = getMondayOfDate(now);
  const keys = [];
  if (wRange === 'ytd') {
    const startMon = getMondayOfDate(new Date(now.getFullYear(), 0, 1));
    let iter = new Date(startMon);
    while (iter <= curMon) {
      const sun = new Date(iter.getFullYear(), iter.getMonth(), iter.getDate() + 6);
      keys.push(formatWeekRange(iter, sun));
      iter.setDate(iter.getDate() + 7);
    }
  } else {
    const n = parseInt(wRange) || 4;
    for (let i = n - 1; i >= 0; i--) {
      const mon = new Date(curMon.getFullYear(), curMon.getMonth(), curMon.getDate() - i * 7);
      const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
      keys.push(formatWeekRange(mon, sun));
    }
  }
  return keys;
}

function renderWeekly(){
  const rows=getRows(wView),keys=getWeeklyKeys();
  const {totals,catMap,rawRows}=aggregateExpenses(rows,keys,getWeekKeyOfRow);
  const selKey=wSelWeek||keys[keys.length-1];
  if(!wSelWeek)wSelWeek=selKey;
  const maxT=Math.max(...keys.map(k=>totals[k]),1);
  const curTotal=totals[selKey]||0;
  const prevKey=keys[keys.indexOf(selKey)-1];
  const prevTotal=prevKey?totals[prevKey]:0;
  const avgTotal=keys.slice(0,-1).reduce((s,k)=>s+(totals[k]||0),0)/Math.max(keys.length-1,1);
  const trend=prevTotal>0?((curTotal-prevTotal)/prevTotal*100):null;
  const trendStr=trend!==null?`${trend>0?'+':''}${trend.toFixed(0)}%`:'—';
  const trendColor=trend===null?'var(--text2)':trend>0?'var(--red)':'var(--accent)';

  const sumEl=document.getElementById('weeklySummary');
  if(sumEl)sumEl.innerHTML=`
    <div class="summary-row">
      <div class="summary-card"><div class="s-label">${selKey}</div><div class="s-value" style="font-size:15px">${'Rp'+Math.round(curTotal).toLocaleString('id-ID')}</div><div class="s-sub">${wView === 'all' ? 'All Accounts' : wView}</div></div>
      <div class="summary-card"><div class="s-label">vs Last Week</div><div class="s-value" style="color:${trendColor}">${trendStr}</div><div class="s-sub">Avg ${fRpS(Math.round(avgTotal))}/wk</div></div>
    </div>`;

  const barCols=keys.map(k=>{
    const t=totals[k]||0;
    const shortLabel=getShortWeekLabelFromKey(k);
    return barColHTML({
      label:shortLabel,
      amount:t>0?fRpS(t):'',
      pct:maxT>0?(t/maxT*100):0,
      selected:k===selKey?'selected':'',
      onclick:`selectWeek('${escJsAttr(k)}')`
    });
  }).join('');
  const barEl=document.getElementById('weeklyBarCard');
  if(barEl)barEl.innerHTML=`<div class="chart-card"><div class="chart-card-title">Weekly Total — tap week for breakdown</div><div class="bar-chart-wrap"><div class="bar-chart">${barCols}</div></div></div>`;

  const catData=catMap[selKey]||{},total=Object.values(catData).reduce((a,b)=>a+b,0),selRows=rawRows[selKey]||{};
  const sorted=Object.entries(catData).sort((a,b)=>b[1]-a[1]);
  if(!wSelCat||!catData[wSelCat])wSelCat=sorted.length?sorted[0][0]:null;
  const donutEl=document.getElementById('weeklyDonutCard');
  if(donutEl){
    if(total>0){
      const legendHTML=legendRowsHTML(sorted,total,wSelCat,'selectWeeklyCat');
      let detailHTML='';
      if(wSelCat&&selRows[wSelCat]){
        const color=CAT_COLORS[wSelCat]||CAT_COLORS['Other'];
        const txList=[...selRows[wSelCat]].sort((a,b)=>(b.exp||0)-(a.exp||0));
        detailHTML=detailSectionHTML(`${esc(wSelCat)} · ${fRp(catData[wSelCat])}`,color,txList,r=>`${r.d} ${MO[r.m]}`);
      }
      donutEl.innerHTML=`<div class="chart-card">
        <div class="chart-card-title">Breakdown ${selKey} — tap category for transactions</div>
        <div class="donut-wrap"><div>${buildDonut(catData,100)}</div><div class="donut-legend">${legendHTML}</div></div>
        ${detailHTML}</div>`;
    } else {
      donutEl.innerHTML=`<div class="chart-card"><div class="chart-card-title">Breakdown ${selKey}</div><div class="empty-state" style="padding:20px">No data</div></div>`;
    }
  }
}
function selectWeek(k){wSelWeek=k;wSelCat=null;renderWeekly()}
function selectWeeklyCat(cat){wSelCat=cat;renderWeekly()}

function getMonthlyKeys(){
  const now=new Date();
  if(mRange==='ytd'){const k=[];for(let m=0;m<=now.getMonth();m++)k.push(`${MO[m]} ${now.getFullYear()}`);return k}
  const n=parseInt(mRange),k=[];
  for(let i=n-1;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);k.push(`${MO[d.getMonth()]} ${d.getFullYear()}`)}
  return k;
}
function getYearlyKeys(){
  const rows=getRows(yView),nowY=new Date().getFullYear();
  if(yRange==='all'){const ys=[...new Set(rows.map(r=>r.y).filter(Boolean))].sort();return ys.length?ys:[nowY]}
  const n=parseInt(yRange),ys=[];for(let i=n-1;i>=0;i--)ys.push(nowY-i);return ys;
}
function getCatKeys(){
  const now=new Date();
  if(cRange==='ytd'){const k=[];for(let m=0;m<=now.getMonth();m++)k.push(`${MO[m]} ${now.getFullYear()}`);return k}
  const n=parseInt(cRange),k=[];
  for(let i=n-1;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);k.push(`${MO[d.getMonth()]} ${d.getFullYear()}`)}
  return k;
}

// ── Shared insights chart builders ────────────────────────────
// Aggregate expense rows into {totals, catMap, rawRows} keyed by keyFn(row);
// rows whose key is not in `keys` are ignored
function aggregateExpenses(rows,keys,keyFn){
  const totals={},catMap={},rawRows={};
  keys.forEach(k=>{totals[k]=0;catMap[k]={};rawRows[k]={}});
  rows.forEach(r=>{
    const k=keyFn(r);
    if(totals[k]===undefined)return;
    const amt=r.exp||0;
    totals[k]+=amt;
    catMap[k][r.cat]=(catMap[k][r.cat]||0)+amt;
    if(!rawRows[k][r.cat])rawRows[k][r.cat]=[];
    rawRows[k][r.cat].push(r);
  });
  return {totals,catMap,rawRows};
}
// One column of a bar chart; fillStyle is appended after the height rule (e.g. ';opacity:0.7')
function barColHTML({label,amount,pct,selected='',onclick='',fillStyle=''}){
  return`<div class="bar-col ${selected}"${onclick?` onclick="${onclick}"`:''}>
    <div class="bar-amount">${amount}</div>
    <div class="bar-fill" style="height:${Math.max(pct,2)}%${fillStyle}"></div>
    <div class="bar-label">${label}</div>
  </div>`;
}
// Donut legend rows; clickFnName is a global function that receives the category name
function legendRowsHTML(sorted,total,activeCat,clickFnName){
  return sorted.map(([cat,val])=>{
    const color=CAT_COLORS[cat]||CAT_COLORS['Other'],pct=((val/total)*100).toFixed(0);
    return`<div class="legend-row${activeCat===cat?' active':''}" onclick="${clickFnName}('${escJsAttr(cat)}')">
      <div class="legend-dot" style="background:${color}"></div>
      <div class="legend-name">${esc(cat)}</div>
      <div class="legend-pct">${pct}%</div>
      <div class="legend-amt">${fRpS(val)}</div>
    </div>`;
  }).join('');
}
// Transaction list under a chart; dateFn renders the per-row date label (pre-escaped)
function detailSectionHTML(title,color,txList,dateFn){
  return`<div class="detail-section">
    <div class="detail-title"><div class="detail-title-dot" style="background:${color}"></div>${title}</div>
    ${txList.map(r=>`<div class="detail-item">
      <div class="detail-name">${esc(r.tx||'')}</div>
      <div class="detail-date">${dateFn(r)}</div>
      <div class="detail-amt">${fRp(r.exp||0)}</div>
    </div>`).join('')}
  </div>`;
}

function renderMonthly(){
  const rows=getRows(mView),keys=getMonthlyKeys();
  const {totals,catMap,rawRows}=aggregateExpenses(rows,keys,r=>r.mk);
  const selKey=mSelMonth||keys[keys.length-1];
  if(!mSelMonth)mSelMonth=selKey;
  const maxT=Math.max(...keys.map(k=>totals[k]),1);
  const curTotal=totals[selKey]||0;
  const prevKey=keys[keys.indexOf(selKey)-1];
  const prevTotal=prevKey?totals[prevKey]:0;
  const avgTotal=keys.slice(0,-1).reduce((s,k)=>s+(totals[k]||0),0)/Math.max(keys.length-1,1);
  const trend=prevTotal>0?((curTotal-prevTotal)/prevTotal*100):null;
  const trendStr=trend!==null?`${trend>0?'+':''}${trend.toFixed(0)}%`:'—';
  const trendColor=trend===null?'var(--text2)':trend>0?'var(--red)':'var(--accent)';

  document.getElementById('monthlySummary').innerHTML=`
    <div class="summary-row">
      <div class="summary-card"><div class="s-label">${selKey}</div><div class="s-value" style="font-size:15px">${'Rp'+Math.round(curTotal).toLocaleString('id-ID')}</div><div class="s-sub">${mView === 'all' ? 'All Accounts' : mView}</div></div>
      <div class="summary-card"><div class="s-label">vs Last Month</div><div class="s-value" style="color:${trendColor}">${trendStr}</div><div class="s-sub">Avg ${fRpS(Math.round(avgTotal))}/mo</div></div>
    </div>`;

  const barCols=keys.map(k=>{
    const t=totals[k]||0;
    return barColHTML({
      label:k.split(' ')[0],
      amount:t>0?fRpS(t):'',
      pct:maxT>0?(t/maxT*100):0,
      selected:k===selKey?'selected':'',
      onclick:`selectMonth('${escJsAttr(k)}')`
    });
  }).join('');
  document.getElementById('monthlyBarCard').innerHTML=`<div class="chart-card"><div class="chart-card-title">Monthly Total — tap month for breakdown</div><div class="bar-chart-wrap"><div class="bar-chart">${barCols}</div></div></div>`;

  const catData=catMap[selKey]||{},total=Object.values(catData).reduce((a,b)=>a+b,0),selRows=rawRows[selKey]||{};
  const sorted=Object.entries(catData).sort((a,b)=>b[1]-a[1]);
  if(!mSelCat||!catData[mSelCat])mSelCat=sorted.length?sorted[0][0]:null;
  if(total>0){
    const legendHTML=legendRowsHTML(sorted,total,mSelCat,'selectMonthlyCat');
    let detailHTML='';
    if(mSelCat&&selRows[mSelCat]){
      const color=CAT_COLORS[mSelCat]||CAT_COLORS['Other'];
      const txList=[...selRows[mSelCat]].sort((a,b)=>(b.exp||0)-(a.exp||0));
      detailHTML=detailSectionHTML(`${esc(mSelCat)} · ${fRp(catData[mSelCat])}`,color,txList,r=>`${r.d} ${MO[r.m]}`);
    }
    document.getElementById('monthlyDonutCard').innerHTML=`<div class="chart-card">
      <div class="chart-card-title">Breakdown ${selKey} — tap category for transactions</div>
      <div class="donut-wrap"><div>${buildDonut(catData,100)}</div><div class="donut-legend">${legendHTML}</div></div>
      ${detailHTML}</div>`;
  } else {
    document.getElementById('monthlyDonutCard').innerHTML=`<div class="chart-card"><div class="chart-card-title">Breakdown ${selKey}</div><div class="empty-state" style="padding:20px">No data</div></div>`;
  }
}
function selectMonth(k){mSelMonth=k;mSelCat=null;renderMonthly()}
function selectMonthlyCat(cat){mSelCat=cat;renderMonthly()}

function renderYearly(){
  const rows=getRows(yView),years=getYearlyKeys();
  const {totals,catMap:cats,rawRows:rawCats}=aggregateExpenses(rows,years,r=>r.y);
  // Per-month breakdown within each year (not covered by aggregateExpenses)
  const monthBreak={};
  years.forEach(y=>monthBreak[y]={});
  rows.forEach(r=>{
    if(monthBreak[r.y]===undefined)return;
    monthBreak[r.y][r.mk]=(monthBreak[r.y][r.mk]||0)+(r.exp||0);
  });
  const selY=ySelYear||years[years.length-1];
  if(!ySelYear)ySelYear=selY;
  const maxT=Math.max(...years.map(y=>totals[y]||0),1);
  const curTotal=totals[selY]||0;
  const prevY=years[years.indexOf(selY)-1];
  const prevTotal=prevY?totals[prevY]:0;
  const trend=prevTotal>0?((curTotal-prevTotal)/prevTotal*100):null;
  const trendStr=trend!==null?`${trend>0?'+':''}${trend.toFixed(0)}%`:'—';
  const trendColor=trend===null?'var(--text2)':trend>0?'var(--red)':'var(--accent)';

  document.getElementById('yearlySummary').innerHTML=`
    <div class="summary-row">
      <div class="summary-card"><div class="s-label">${selY}</div><div class="s-value">${fRpS(curTotal)}</div><div class="s-sub">${yView === 'all' ? 'All Accounts' : yView}</div></div>
      <div class="summary-card"><div class="s-label">vs Last Year</div><div class="s-value" style="color:${trendColor}">${trendStr}</div><div class="s-sub">Prev: ${fRpS(prevTotal)}</div></div>
    </div>`;

  const barCols=years.map(y=>{
    const t=totals[y]||0;
    return barColHTML({
      label:y,
      amount:fRpS(t),
      pct:maxT>0?(t/maxT*100):0,
      selected:y===selY?'selected':'',
      onclick:`selectYear(${y})`
    });
  }).join('');
  document.getElementById('yearlyBarCard').innerHTML=`<div class="chart-card"><div class="chart-card-title">Yearly Total — tap year for detail</div><div class="bar-chart-wrap"><div class="bar-chart">${barCols}</div></div></div>`;

  const mbData=monthBreak[selY]||{},mbKeys=MO.map(m=>`${m} ${selY}`);
  const mbMax=Math.max(...mbKeys.map(k=>mbData[k]||0),1);
  const mbCols=mbKeys.map(k=>{
    const t=mbData[k]||0;
    return barColHTML({
      label:k.split(' ')[0],
      amount:t>0?fRpS(t):'',
      pct:mbMax>0?(t/mbMax*100):0,
      fillStyle:';opacity:0.7'
    });
  }).join('');
  document.getElementById('yearlyMonthCard').innerHTML=`<div class="chart-card"><div class="chart-card-title">Monthly Breakdown ${selY}</div><div class="bar-chart-wrap"><div class="bar-chart">${mbCols}</div></div></div>`;

  const catData=cats[selY]||{},catTotal=Object.values(catData).reduce((a,b)=>a+b,0);
  const sorted=Object.entries(catData).sort((a,b)=>b[1]-a[1]);
  if(!ySelCat||!catData[ySelCat])ySelCat=sorted.length?sorted[0][0]:null;
  if(catTotal>0){
    const legendHTML=legendRowsHTML(sorted,catTotal,ySelCat,'selectYearlyCat');
    let detailHTML='';
    if(ySelCat&&rawCats[selY][ySelCat]){
      const color=CAT_COLORS[ySelCat]||CAT_COLORS['Other'];
      const txList=[...rawCats[selY][ySelCat]].sort((a,b)=>(b.exp||0)-(a.exp||0));
      detailHTML=detailSectionHTML(`${esc(ySelCat)} ${selY} · ${fRp(catData[ySelCat])}`,color,txList,r=>esc(r.mk));
    }
    document.getElementById('yearlyDonutCard').innerHTML=`<div class="chart-card">
      <div class="chart-card-title">Category Breakdown ${selY} — tap for transactions</div>
      <div class="donut-wrap"><div>${buildDonut(catData,100)}</div><div class="donut-legend">${legendHTML}</div></div>
      ${detailHTML}</div>`;
  } else document.getElementById('yearlyDonutCard').innerHTML='';
}
function selectYear(y){ySelYear=y;ySelCat=null;renderYearly()}
function selectYearlyCat(cat){ySelCat=cat;renderYearly()}

function renderCategory(){
  const rows=getRows(cView),keys=getCatKeys();
  const catTotals={},catMonthly={},catRaw={};
  rows.forEach(r=>{
    if(!keys.includes(r.mk))return;
    const cat=r.cat||'Other',amt=r.exp||0;
    catTotals[cat]=(catTotals[cat]||0)+amt;
    if(!catMonthly[cat])catMonthly[cat]={};
    catMonthly[cat][r.mk]=(catMonthly[cat][r.mk]||0)+amt;
    if(!catRaw[cat])catRaw[cat]=[];
    catRaw[cat].push(r);
  });
  const sorted=Object.entries(catTotals).sort((a,b)=>b[1]-a[1]);
  const maxCat=sorted.length?sorted[0][1]:1;
  if(!cSelCat&&sorted.length)cSelCat=sorted[0][0];

  const CAT_SHORT={'Administration':'Admin','Entertainment':'Entertain.','Self Care':'Self Care'};
  let pillHTML='<div class="pill-grid">';
  sorted.forEach(([cat,total])=>{
    const color=CAT_COLORS[cat]||CAT_COLORS['Other'];
    const barW=maxCat>0?((total/maxCat)*100).toFixed(0):0;
    const isActive=cSelCat===cat;
    const displayName=CAT_SHORT[cat]||cat;
    pillHTML+=`<div class="cat-pill${isActive?' active':''}" onclick="selectCat('${escJsAttr(cat)}')">
      <div class="cat-pill-bar" style="width:${barW}%;background:${color}"></div>
      <div class="cat-pill-name">${esc(displayName)}</div>
      <div class="cat-pill-amt">${fRpS(total)}</div>
    </div>`;
  });
  pillHTML+='</div>';
  document.getElementById('catRankingCard').innerHTML=pillHTML;

  if(cSelCat&&catMonthly[cSelCat]){
    const color=CAT_COLORS[cSelCat]||CAT_COLORS['Other'];
    const mData=catMonthly[cSelCat];
    const mMax=Math.max(...keys.map(k=>mData[k]||0),1);
    const avg=keys.reduce((s,k)=>s+(mData[k]||0),0)/keys.length;
    const txList=(catRaw[cSelCat]||[]).sort((a,b)=>(b.exp||0)-(a.exp||0)).slice(0,10);
    const barCols=keys.map(k=>{
      const t=mData[k]||0;
      return barColHTML({
        label:k.split(' ')[0],
        amount:t>0?fRpS(t):'',
        pct:mMax>0?(t/mMax*100):0,
        fillStyle:`;background:${color};border-color:${color}`
      });
    }).join('');
    document.getElementById('catTrendCard').innerHTML=`<div class="cat-trend-card">
      <div class="cat-trend-header">
        <div class="cat-trend-dot" style="background:${color}"></div>
        <span style="color:var(--text);font-size:13px;font-weight:600">${esc(cSelCat)}</span>
        <span style="color:var(--text2);font-size:12px"> · avg ${fRpS(Math.round(avg))}/mo · total ${fRpS(catTotals[cSelCat])}</span>
      </div>
      <div class="bar-chart-wrap"><div class="bar-chart">${barCols}</div></div>
      ${txList.length?detailSectionHTML('Top transactions',color,txList,r=>esc(r.mk)):''}
    </div>`;
  } else document.getElementById('catTrendCard').innerHTML='';
}
function selectCat(cat){cSelCat=cat;renderCategory()}

function buildDonut(data,size){
  const total=Object.values(data).reduce((a,b)=>a+b,0);
  if(!total)return'';
  const sorted=Object.entries(data).sort((a,b)=>b[1]-a[1]);
  const r=size/2-10,cx=size/2,cy=size/2,circ=2*Math.PI*r;
  let offset=0,paths='';
  sorted.forEach(([cat,val])=>{
    const pct=val/total,dash=pct*circ,color=CAT_COLORS[cat]||CAT_COLORS['Other'];
    paths+=`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="13" stroke-dasharray="${dash} ${circ-dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset+=dash;
  });
  return`<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--bg3)" stroke-width="13"/>
    ${paths}
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" fill="var(--text)" font-size="10" font-weight="700">${fRpS(total)}</text>
  </svg>`;
}

// ── NET WORTH ─────────────────────────────────────────────────
function setNWMode(mode,el){
  nwMode=mode;
  toggleActive('.nw-mode-btn',el);
  if(!histLoaded) onHistLoaded(()=>renderNetWorth());
  else renderNetWorth();
}
function initNetWorth() {
  const render = () => Promise.all([fetchSheetPrices(false), fetchLiveInvest(), fetchAccountBalances()]).then(() => renderNetWorth());
  if (!histLoaded) onHistLoaded(render);
  else render();
}

async function fetchFxRates(){
  const now=Date.now();
  if(fxRates.USD && (now-fxLastFetch)<3600000)return; 
  try {
    const res=await fetch('https://api.frankfurter.app/latest?from=USD,CHF&to=IDR');
    const j=await res.json();
    fxRates.USD = j.rates?.USD?.IDR || j.rates?.IDR;
    const [usdRes, chfRes] = await Promise.all([
      fetch('https://api.frankfurter.app/latest?from=USD&to=IDR'),
      fetch('https://api.frankfurter.app/latest?from=CHF&to=IDR'),
    ]);
    const usdJ = await usdRes.json();
    const chfJ = await chfRes.json();
    fxRates.USD = usdJ.rates?.IDR;
    fxRates.CHF = chfJ.rates?.IDR;
    fxLastFetch = now;
    localStorage.setItem('notapub_fx', JSON.stringify(fxRates));
    localStorage.setItem('notapub_fx_ts', String(now));
  } catch(e){
    fxRates.USD = fxRates.USD || 16500;
    fxRates.CHF = fxRates.CHF || 19000;
  }
}

function computeCashBalance() {
  const base = HIST.cashBalance || 0;
  const cutoff = HIST.cashBalanceAsOf || null; // e.g. '2026-06-01'
  if (!cutoff) return base;
  let delta = 0;
  (txHistory || []).forEach(r => {
    if (!r.date || r.date <= cutoff) return;
    if (r.type === 'income')  delta += (r.amount || 0);
    else if (r.type === 'expense') delta -= (r.amount || 0);
  });
  (investHistory || []).forEach(r => {
    if (!r.date || r.date <= cutoff) return;
    const fromUsdAcct = r.account && ACCOUNT_CCY[r.account] === 'USD';
    if (!fromUsdAcct) {
      if (r.action === 'Buy')  delta -= (r.totalIdr || 0);
      else if (r.action === 'Sell') delta += (r.totalIdr || 0);
    }
  });
  (liveInvest || []).forEach(r => {
    if (!r.date || r.date <= cutoff) return;
    const fromUsdAcct = r.account && ACCOUNT_CCY[r.account] === 'USD';
    if (!fromUsdAcct) {
      if (r.action === 'Buy')  delta -= (r.totalIdr || 0);
      else if (r.action === 'Sell') delta += (r.totalIdr || 0);
    }
  });
  return base + delta;
}

// Shared buy/sell aggregation for every Invest row, keyed by stock. A stock that is
// also registered as a USD-currency Account (e.g. "USDIDR Pluang Febri" funding QQQ
// buys) gets its balance depleted by whatever was spent buying OTHER assets through
// it — otherwise that money would look like it's still sitting in the FX pool when
// it's actually been converted into stock. Used by both renderNetWorth() and
// getGoalCurrentValue() so neither drifts out of sync with the other.
function computeInvestNetLots(allInvest) {
  const buyLots={}, sellLots={}, buyTotalIdr={}, buyPriceWeighted={};
  allInvest.forEach(r=>{
    const s=r.stock;
    if(!(s in buyLots)){buyLots[s]=0;sellLots[s]=0;buyTotalIdr[s]=0;buyPriceWeighted[s]=0;}
    if(r.action==='Buy'){
      buyLots[s]  += r.lot;
      buyTotalIdr[s] += r.totalIdr||0;
      buyPriceWeighted[s] += (r.price||0) * r.lot;
    } else {
      sellLots[s] += r.lot;
    }
  });

  const forexStockKeys = Object.keys(buyLots).filter(s => {
    const cfg = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === s.toLowerCase());
    return getAssetTypeForItem(s, cfg?.assetType || STOCK_TYPE[s], false) === 'Forex';
  });

  allInvest.forEach(r => {
    if (r.action !== 'Buy') return;
    if (!r.account) return;
    const fxSpent = (r.lot || 0) * (r.price || 0);
    if (fxSpent <= 0) return;

    const acctCcy = (ACCOUNT_CCY[r.account] || '').toUpperCase();
    // Direct match: the Invest sheet's Account text names a Config account verbatim.
    let targetKey = (acctCcy && acctCcy !== 'IDR') ? r.account : null;
    // Fallback: no Config account is named exactly this (e.g. Invest says "Pluang USD"
    // but Config's account row is just "Pluang") — fuzzy-match it against known forex
    // holdings instead of silently dropping the depletion.
    if (!targetKey) {
      targetKey = forexStockKeys.find(s => isFxAccountMatch(r.account, ACCOUNT_CCY[s] || 'USD', s));
    }
    if (!targetKey) return;

    if (!(targetKey in sellLots)) { buyLots[targetKey] = buyLots[targetKey] || 0; sellLots[targetKey] = 0; }
    sellLots[targetKey] += fxSpent;
  });

  return { buyLots, sellLots, buyTotalIdr, buyPriceWeighted };
}

async function renderNetWorth(){
  await fetchFxRates();
  const manualUSD = parsePrice(stockPrices['USDIDR']);
  const manualCHF = parsePrice(stockPrices['CHFIDR']);
  const usdRate = manualUSD > 0 ? manualUSD : (fxRates.USD || 16500);
  const chfRate = manualCHF > 0 ? manualCHF : (fxRates.CHF || 19000);

  const navStar = parsePrice(stockPrices['StarStable']);
  const priceQQQ  = parsePrice(stockPrices['QQQ']);
  const priceJNJ  = parsePrice(stockPrices['JNJ']);
  const priceVYM  = parsePrice(stockPrices['VYM']);
  const priceAAPL = parsePrice(stockPrices['AAPL']);

  const allInvest = getAllInvestRows();
  const { buyLots, sellLots, buyTotalIdr, buyPriceWeighted } = computeInvestNetLots(allInvest);

  const holdings = Object.keys(buyLots).map(stock=>{
    const netLot = buyLots[stock] - (sellLots[stock]||0);
    if(netLot <= 0) return null;
    const stockConfig = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === stock.toLowerCase());
    let type = getAssetTypeForItem(stock, stockConfig?.assetType || STOCK_TYPE[stock], false);
    const buyRatio = buyLots[stock] > 0 ? netLot / buyLots[stock] : 0;
    const costBasis = buyTotalIdr[stock] * buyRatio;
    const avgCostPerUnit = buyLots[stock] > 0 ? buyTotalIdr[stock] / buyLots[stock] : 0;
    // avgNativePrice uses r.price×r.lot (native currency) — accurate for USD stocks too
    const avgNativePrice = buyLots[stock] > 0 ? buyPriceWeighted[stock] / buyLots[stock] : 0;

    let currentValue = 0;
    if (stock==='Star Stable Income Fund') currentValue = navStar > 0 ? netLot * navStar : 0;
    else if (stock.startsWith('USDIDR')) currentValue = netLot * usdRate;
    else if (stock==='CHFIDR') currentValue = netLot * chfRate;
    else if (stock==='QQQ')  currentValue = priceQQQ  > 0 ? netLot * priceQQQ  * usdRate : 0;
    else if (stock==='JNJ')  currentValue = priceJNJ  > 0 ? netLot * priceJNJ  * usdRate : 0;
    else if (stock==='VYM')  currentValue = priceVYM  > 0 ? netLot * priceVYM  * usdRate : 0;
    else if (stock==='AAPL') currentValue = priceAAPL > 0 ? netLot * priceAAPL * usdRate : 0;
    else if (parsePrice(stockPrices[stock]) > 0) {
      currentValue = netLot * parsePrice(stockPrices[stock]) * (type === 'US Stock' ? usdRate : 1);
    } else {
      currentValue = costBasis;
    }

    return {stock, type, netLot, costBasis, currentValue, avgCostPerUnit, avgNativePrice};
  }).filter(Boolean);

  // Also include stock items from CONFIG_ITEMS that have a balance/value configured but no Invest sheet transactions
  const stockConfigItems = CONFIG_ITEMS.filter(i => i.kind === 'stock' && !i.archived);
  stockConfigItems.forEach(sItem => {
    const hasInvestLots = buyLots[sItem.name] && (buyLots[sItem.name] - (sellLots[sItem.name] || 0)) > 0;
    if (hasInvestLots) return;

    let rawBal = sItem.balance;
    if (rawBal == null && rawAccountBalances[sItem.name]) {
      rawBal = rawAccountBalances[sItem.name].amount;
    }
    const balNum = parseConfigBalance(rawBal);
    if (balNum !== null && balNum > 0) {
      let type = getAssetTypeForItem(sItem.name, sItem.assetType || STOCK_TYPE[sItem.name], false);

      holdings.push({
        stock: sItem.name,
        type,
        netLot: 1,
        costBasis: balNum,
        currentValue: balNum,
        avgCostPerUnit: balNum,
        avgNativePrice: balNum
      });
    }
  });

  const cashBal = computeCashBalance();
  buildAccountBalances();

  if(nwMode==='holdings'){
    renderHoldings(holdings, usdRate, chfRate, accountBalances);
  } else {
    renderOverview(holdings, usdRate, chfRate, cashBal, accountBalances);
  }
}

function getAssetTypeForItem(name, explicitType, isAccount) {
  const sName = (name || '').trim();
  const sUpper = sName.toUpperCase();
  if (sUpper.includes('JHT')) return 'JHT';

  const cfg = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === sName.toLowerCase());

  let t = (explicitType || cfg?.assetType || STOCK_TYPE[sName] || '').trim();
  if (t && t !== 'Other') return t;

  const ccy = (ACCOUNT_CCY[sName] || cfg?.ccy || '').toUpperCase();

  if (
    sName.startsWith('USDIDR') ||
    sName.startsWith('CHFIDR') ||
    sName.startsWith('EURIDR') ||
    sName.startsWith('SGDIDR') ||
    sUpper.includes('USD') ||
    sUpper.includes('CHF') ||
    sUpper.includes('EUR') ||
    sUpper.includes('SGD') ||
    sUpper.includes('FOREX') ||
    (ccy && ccy !== 'IDR')
  ) {
    return 'Forex';
  }

  if (
    sName === 'Star Stable Income Fund' ||
    sUpper.includes('REKSA DANA') ||
    sUpper.includes('MUTUAL FUND') ||
    sUpper.includes('INCOME FUND')
  ) {
    return 'Reksa Dana';
  }

  if (isAccount || cfg?.kind === 'account') {
    return 'Cash';
  }

  return 'US Stock';
}

function getTypeColor(type) {
  const DYNAMIC_TYPE_COLORS = {
    'US Stock': '#5b8ef0',
    'Cash': '#888780',
    'Reksa Dana': '#4ade80',
    'Forex': '#f59e0b',
    'JHT': '#a855f7',
    'Deposit': '#06b6d4',
    'Gold': '#eab308',
    'Crypto': '#ec4899',
    'Bonds': '#14b8a6'
  };
  if (DYNAMIC_TYPE_COLORS[type]) return DYNAMIC_TYPE_COLORS[type];
  const FALLBACK_PALETTE = ['#f43f5e', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#3b82f6'];
  let hash = 0;
  for (let i = 0; i < type.length; i++) hash = type.charCodeAt(i) + ((hash << 5) - hash);
  return FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length];
}

function getHoldingTheme(type) {
  const color = getTypeColor(type);
  return { color, bg: `${color}25` };
}

function isFxAccountMatch(acctName, ccy, stockName) {
  const aName = (acctName || '').trim();
  const sName = (stockName || '').trim();
  if (!aName || !sName) return false;

  const aLower = aName.toLowerCase();
  const sLower = sName.toLowerCase();

  // 1. Exact match (case-insensitive)
  if (aLower === sLower) return true;

  // 2. Normalized token match (e.g., "USD CIMB" <-> "USDIDR CIMB") — only applies to
  // foreign-currency accounts. A plain IDR cash account (ccy IDR/blank) is never an
  // FX-holding's funding account, so it must not be matched here even if stripping
  // the trailing "IDR" token happens to collide with another instrument's name.
  const ccyUpper = (ccy || '').toUpperCase();
  if (ccyUpper && ccyUpper !== 'IDR') {
    const normA = aLower.replace(/^(usdidr|chfidr|euridr|sgdidr|idr|usd|chf|eur|sgd)\s+/i, '')
                        .replace(/\s+(usdidr|chfidr|euridr|sgdidr|idr|usd|chf|eur|sgd)$/i, '')
                        .replace(/\s+/g, ' ').trim();

    const normS = sLower.replace(/^(usdidr|chfidr|euridr|sgdidr|idr|usd|chf|eur|sgd)\s+/i, '')
                        .replace(/\s+(usdidr|chfidr|euridr|sgdidr|idr|usd|chf|eur|sgd)$/i, '')
                        .replace(/\s+/g, ' ').trim();

    if (normA && normS && normA === normS) {
      return true;
    }
  }

  // 3. Match generic FX pair names like "USDIDR" / "CHFIDR" with currency accounts
  if ((sLower === 'usdidr' || sLower === 'chfidr') && (ccy === 'USD' || ccy === 'CHF' || aLower.includes(ccy?.toLowerCase() || ''))) {
    return true;
  }

  return false;
}

function getNetWorthAllocations(holdings, activeAccounts, acctBals, rawAccountBalances) {
  acctBals = acctBals || {};
  rawAccountBalances = rawAccountBalances || {};
  const groups = {};

  // 1. Investment holdings grouped by assetType allocation (processed FIRST to preserve rich lot/cost details)
  holdings.forEach(h => {
    const cfg = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === h.stock.toLowerCase());
    const t = getAssetTypeForItem(h.stock, cfg?.assetType || h.type, false);
    if (!groups[t]) groups[t] = { type: t, cost: 0, value: 0, items: [] };
    groups[t].cost += h.costBasis;
    groups[t].value += h.currentValue;
    groups[t].items.push({
      itemKind: 'stock',
      name: h.stock,
      holding: h,
      costBasis: h.costBasis,
      currentValue: h.currentValue
    });
  });

  // 2. Active Accounts grouped by assetType allocation (deduplicating items already represented in holdings)
  activeAccounts.forEach(acct => {
    const balObj = acctBals[acct.name];
    const amt = Number(balObj?.amount) || 0;
    if (amt <= 0) return;

    // Deduplicate: Skip account if it is already represented by an investment/FX holding
    const isAlreadyInHoldings = holdings.some(h => isFxAccountMatch(acct.name, acct.ccy, h.stock));
    if (isAlreadyInHoldings) return;

    const t = getAssetTypeForItem(acct.name, acct.assetType, true);
    if (!groups[t]) groups[t] = { type: t, cost: 0, value: 0, items: [] };
    groups[t].cost += amt;
    groups[t].value += amt;
    groups[t].items.push({
      itemKind: 'account',
      name: acct.name,
      acct,
      bal: amt,
      balObj,
      costBasis: amt,
      currentValue: amt,
      ccy: acct.ccy || 'IDR'
    });
  });

  // 3. Fallback rawAccountBalances grouped by assetType allocation
  Object.keys(rawAccountBalances).forEach(k => {
    const rawObj = rawAccountBalances[k];
    const amt = Number(rawObj?.amount) || 0;
    if (amt <= 0) return;

    const kSorted = k.toLowerCase().split(/\s+/).sort().join(' ');

    const inAccts = activeAccounts.some(a => {
      const aLower = a.name.toLowerCase();
      const aSorted = aLower.split(/\s+/).sort().join(' ');
      return aLower === k.toLowerCase() || aSorted === kSorted;
    });

    const kCfg = CONFIG_ITEMS.find(i => i.name && i.name.toLowerCase() === k.toLowerCase());
    const inHoldings = holdings.some(h => isFxAccountMatch(k, kCfg?.ccy || ACCOUNT_CCY[k], h.stock));

    const isConfiguredOrArchived = CONFIG_ITEMS.some(i => {
      const iLower = (i.name || '').toLowerCase();
      const iSorted = iLower.split(/\s+/).sort().join(' ');
      return iLower === k.toLowerCase() || iSorted === kSorted;
    });

    if (!inAccts && !inHoldings && !isConfiguredOrArchived) {
      const cfg = CONFIG_ITEMS.find(i => i.name.toLowerCase() === k.toLowerCase());
      const kType = getAssetTypeForItem(k, cfg?.assetType, cfg ? cfg.kind !== 'stock' : true);
      if (!groups[kType]) groups[kType] = { type: kType, cost: 0, value: 0, items: [] };
      groups[kType].cost += amt;
      groups[kType].value += amt;
      groups[kType].items.push({
        itemKind: 'raw',
        name: k,
        bal: amt,
        costBasis: amt,
        currentValue: amt,
        ccy: 'IDR'
      });
    }
  });

  return groups;
}

function renderHoldings(holdings, usdRate, chfRate, acctBals){
  acctBals = acctBals || {};
  const activeAccounts = CONFIG_ITEMS.filter(i => i.kind === 'account' && !i.archived);

  const allocGroups = getNetWorthAllocations(holdings, activeAccounts, acctBals, rawAccountBalances);

  // Sort allocation type groups by total group value descending
  const sortedTypes = Object.entries(allocGroups)
    .filter(([, group]) => group.items.length)
    .sort((a, b) => {
      const valA = a[1].value > 0 ? a[1].value : a[1].cost;
      const valB = b[1].value > 0 ? b[1].value : b[1].cost;
      return valB - valA;
    });

  if (!sortedTypes.length) {
    document.getElementById('nwContent').innerHTML = '<div class="empty-state">No holdings found</div>';
    return;
  }

  if (!holdingsGroupFilter || !sortedTypes.some(([type]) => type === holdingsGroupFilter)) {
    holdingsGroupFilter = sortedTypes[0][0];
  }

  const grandCost = sortedTypes.reduce((s, [, g]) => s + g.cost, 0);
  const grandValue = sortedTypes.reduce((s, [, g]) => s + (g.value > 0 ? g.value : g.cost), 0);

  let html = `<div class="holding-item" style="margin-bottom:12px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--text2);margin-bottom:4px">Total net worth</div>
        <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Cost basis</div>
        <div style="font-size:13px;font-weight:600">${fUSD(grandCost, usdRate)}</div>
        <div style="font-size:13px;font-weight:600;opacity:0.7">${fRpS(Math.round(grandCost))}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Est. value</div>
        <div style="font-size:13px;font-weight:600">${fUSD(grandValue, usdRate)}</div>
        <div style="font-size:13px;font-weight:600;opacity:0.7">${fRpS(Math.round(grandValue))}</div>
      </div>
    </div>
  </div>`;

  html += '<div class="toggle-row">';
  sortedTypes.forEach(([type]) => {
    const active = type === holdingsGroupFilter ? ' active' : '';
    html += `<div class="toggle-btn holdings-group-btn${active}" data-type="${esc(type)}" onclick="setHoldingsGroupFilter('${esc(type).replace(/'/g, "\\'")}', this)">${esc(type)}</div>`;
  });
  html += '</div>';

  sortedTypes.forEach(([type, group]) => {
    if (type !== holdingsGroupFilter) return;
    const items = group.items;
    if (!items.length) return;

    items.sort((a, b) => {
      if (a.itemKind === 'stock' && b.itemKind !== 'stock') return -1;
      if (a.itemKind !== 'stock' && b.itemKind === 'stock') return 1;
      if (a.itemKind === 'stock' && b.itemKind === 'stock') return b.currentValue - a.currentValue;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    const theme = getHoldingTheme(type);
    const groupCost = group.cost;
    const groupValue = group.value;

    html += `<div class="chart-card-title" style="margin-top:14px;margin-bottom:8px;color:${theme.color};font-size:14px;font-weight:700">${esc(type)}</div>`;

    items.forEach(item => {
      if (item.itemKind === 'account') {
        const acct = item.acct;
        const bal = item.bal;
        const ccy = (ACCOUNT_CCY[acct.name] || acct.ccy || 'IDR').toUpperCase();
        let subText = '';
        if (ccy !== 'IDR' && item.balObj?.nativeAmount != null) {
          subText = `<div style="font-size:10px;color:var(--text2);margin-top:2px">${ccy} ${item.balObj.nativeAmount.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2})}</div>`;
        }

        html += `<div class="holding-item">
          <div class="holding-header">
            <div class="holding-name">${esc(acct.name)}</div>
            <div style="display:flex;gap:4px;align-items:center">
              <span class="holding-badge" style="background:${theme.bg};color:${theme.color}">${esc(type)}</span>
              <span class="holding-badge" style="background:var(--bg3);color:var(--text2)">${ccy}</span>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:6px">
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Balance</div>
              ${dualValSmFull(bal, usdRate)}
              ${subText}
            </div>
          </div>
        </div>`;
      } else if (item.itemKind === 'raw') {
        html += `<div class="holding-item">
          <div class="holding-header">
            <div class="holding-name">${esc(item.name)}</div>
            <span class="holding-badge" style="background:${theme.bg};color:${theme.color}">${esc(type)}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:6px">
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Balance</div>
              ${dualValSmFull(item.bal, usdRate)}
            </div>
          </div>
        </div>`;
      } else if (item.itemKind === 'stock') {
        const h = item.holding;
        const hasValue = h.currentValue > 0;
        const pnl = hasValue ? h.currentValue - h.costBasis : null;
        const pnlPct = pnl !== null && h.costBasis > 0 ? (pnl / h.costBasis * 100) : null;
        const isUSDStock = type === 'US Stock';
        const isUSD = h.stock.toUpperCase().includes('USD') || h.stock.startsWith('USDIDR') || isUSDStock;
        const isCHF = h.stock.toUpperCase().includes('CHF') || h.stock === 'CHFIDR';

        const lotStr = isUSDStock ? `${h.netLot.toLocaleString('en-US')} shares` :
                       isUSD ? `${h.netLot.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2})} USD` :
                       isCHF ? `${h.netLot.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2})} CHF` :
                       `${h.netLot.toLocaleString('id-ID')} units`;

        const avgStr = isUSDStock
          ? `Avg $${Number(Math.round(h.avgNativePrice + 'e2') + 'e-2').toFixed(2)}`
          : isUSD
            ? `Avg rate Rp${Math.round(h.avgNativePrice).toLocaleString('id-ID')}/USD`
            : isCHF
              ? `Avg rate Rp${Math.round(h.avgNativePrice).toLocaleString('id-ID')}/CHF`
              : `Avg ${fRp(Math.round(h.avgNativePrice))}/unit`;

        let mktStr = '';
        if (h.stock === 'Star Stable Income Fund' || h.stock.toLowerCase().includes('star stable')) {
          const nav = parsePrice(stockPrices['StarStable']) || parsePrice(stockPrices['Star Stable Income Fund']);
          if (nav > 0) {
            const navUsd = usdRate > 0 ? (nav / usdRate) : 0;
            mktStr = `Mkt Rp${Math.round(nav).toLocaleString('id-ID')}/unit · $${navUsd.toFixed(2)}`;
          }
        } else if (h.stock.startsWith('USDIDR') || (isUSD && !isUSDStock)) {
          const mktRate = parsePrice(stockPrices['USDIDR']) || usdRate;
          if (mktRate > 0) {
            mktStr = `Mkt rate Rp${Math.round(mktRate).toLocaleString('id-ID')}/USD`;
          }
        } else if (h.stock === 'CHFIDR' || isCHF) {
          const mktRate = parsePrice(stockPrices['CHFIDR']) || chfRate;
          if (mktRate > 0) {
            mktStr = `Mkt rate Rp${Math.round(mktRate).toLocaleString('id-ID')}/CHF`;
          }
        } else if (isUSDStock || parsePrice(stockPrices[h.stock]) > 0) {
          const p = parsePrice(stockPrices[h.stock]);
          if (p > 0) {
            const pIdr = p * usdRate;
            mktStr = `Mkt $${Number(Math.round(p + 'e2') + 'e-2').toFixed(2)} · ${fRpS(Math.round(pIdr))}`;
          }
        }

        html += `<div class="holding-item">
          <div class="holding-header">
            <div class="holding-name" style="color:${theme.color}">${esc(h.stock)}</div>
            <span class="holding-badge" style="background:${theme.bg};color:${theme.color}">${lotStr}</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-top:6px">
            <div>
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Cost basis</div>
              ${dualValSm(h.costBasis, usdRate)}
            </div>
            <div style="text-align:right">
              <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Value</div>
              ${hasValue ? dualVal(h.currentValue, usdRate) : `<div style="color:var(--text2);font-size:12px">Loading…</div>`}
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:6px;padding-top:6px;border-top:0.5px solid var(--border)">
            <div style="font-size:11px;color:var(--text2);line-height:1.35">
              <div>${avgStr}</div>
              ${mktStr ? `<div style="color:var(--blue);font-weight:500;margin-top:1px">${mktStr}</div>` : ''}
            </div>
            <div style="text-align:right;margin-bottom:1px">
              ${pnl !== null ? pnlDual(pnl, pnlPct, usdRate, pnl >= 0 ? 'var(--green)' : 'var(--red)') : ''}
            </div>
          </div>
        </div>`;
      }
    });

    const gPnl = (groupValue > 0 && groupValue !== groupCost) ? groupValue - groupCost : null;
    const gPnlPct = gPnl !== null && groupCost > 0 ? (gPnl / groupCost * 100) : null;
    html += `<div class="holding-item" style="border-color:${theme.color};background:${theme.bg};margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:12px;font-weight:600;color:${theme.color};margin-bottom:4px">Total ${esc(type)}</div>
          <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Cost basis</div>
          <div style="font-size:13px;font-weight:600;color:${theme.color}">${fUSD(groupCost, usdRate)}</div>
          <div style="font-size:13px;font-weight:600;color:${theme.color};opacity:0.7">${fRpS(Math.round(groupCost))}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Est. value</div>
          <div style="font-size:13px;font-weight:600;color:${theme.color}">${fUSD(groupValue, usdRate)}</div>
          <div style="font-size:13px;font-weight:600;color:${theme.color};opacity:0.7">${fRpS(Math.round(groupValue))}</div>
          ${gPnl !== null ? pnlDual(gPnl, gPnlPct, usdRate, gPnl >= 0 ? 'var(--green)' : 'var(--red)') : ''}
        </div>
      </div>
    </div>`;
  });

  document.getElementById('nwContent').innerHTML = html || '<div class="empty-state">No holdings found</div>';
}

function renderOverview(holdings, usdRate, chfRate, cashBalance, acctBals){
  acctBals = acctBals || {};
  const activeAccounts = CONFIG_ITEMS.filter(i => i.kind === 'account' && !i.archived);

  const allocGroups = getNetWorthAllocations(holdings, activeAccounts, acctBals, rawAccountBalances);

  // Derive top metrics directly from allocGroups so Overview top cards and Holdings total sum match 100%!
  let totalInvestCost = 0;
  let totalInvestValue = 0;
  let cashBalanceVal = 0;

  Object.values(allocGroups).forEach(g => {
    g.items.forEach(item => {
      if (item.itemKind === 'stock') {
        totalInvestCost += item.costBasis || 0;
        totalInvestValue += item.currentValue || 0;
      } else {
        cashBalanceVal += item.currentValue || item.bal || 0;
      }
    });
  });

  const hasValue = totalInvestValue > 0;
  const totalNetWorth = (hasValue ? totalInvestValue : totalInvestCost) + cashBalanceVal;
  const pnl = hasValue ? totalInvestValue - totalInvestCost : null;
  const pnlPct = pnl !== null && totalInvestCost > 0 ? (pnl / totalInvestCost * 100) : null;

  function fRpFull(n){ return 'Rp ' + Math.round(n).toLocaleString('id-ID'); }

  // Dynamic "as of" date
  const todayObj = new Date();
  const asOfStr = `${todayObj.getDate()} ${MO[todayObj.getMonth()]} ${todayObj.getFullYear()}`;

  let html = `
    <div class="chart-card" style="margin-bottom:10px">
      <div class="chart-card-title">Total net worth · as of ${asOfStr}</div>
      <div class="val-usd-lg" style="margin-top:4px">${fUSD(totalNetWorth,usdRate)}</div>
      <div class="val-idr-lg" style="margin-bottom:6px">${fRpFull(totalNetWorth)}</div>
      <div style="border-top:0.5px solid var(--border);padding-top:8px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Cost basis</div>
          <div style="font-size:12px;font-weight:500;color:var(--blue)">${fUSD(totalInvestCost,usdRate)}</div>
          <div style="font-size:12px;font-weight:500;color:var(--text2)">${fRpFull(totalInvestCost)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;color:var(--text2);margin-bottom:3px">Unrealized P&L</div>
          ${pnl!==null ? pnlDual(pnl, pnlPct, usdRate, pnl>=0?'var(--green)':'var(--red)') : '<div style="color:var(--text2);font-size:12px">—</div>'}
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-bottom:10px">
      <div class="chart-card">
        <div class="chart-card-title" style="margin-bottom:4px;font-size:9px">Investments</div>
        <div class="val-usd-sm" style="margin-top:3px">${fUSD(hasValue?totalInvestValue:totalInvestCost,usdRate)}</div>
        <div class="val-idr-sm">${fRpS(Math.round(hasValue?totalInvestValue:totalInvestCost))}</div>
      </div>
      <div class="chart-card">
        <div class="chart-card-title" style="margin-bottom:4px;font-size:9px">Cash & Accounts</div>
        <div class="val-idr-sm" style="margin-top:3px;font-size:14px;font-weight:600">${fRpS(Math.round(cashBalanceVal))}</div>
        <div style="font-size:10px;color:var(--text2)">${fUSD(cashBalanceVal,usdRate)}</div>
      </div>
      <div class="chart-card" style="background:var(--blue-dim);border-color:var(--blue)">
        <div class="chart-card-title" style="margin-bottom:4px;font-size:9px;color:var(--blue)">FX Rate</div>
        <div style="font-size:13px;font-weight:600;color:var(--blue);margin-top:3px;line-height:1.2">$1 USD</div>
        <div style="font-size:12px;font-weight:500;color:var(--blue)">= Rp ${Math.round(usdRate).toLocaleString('id-ID')}</div>
      </div>
    </div>`;

  const grandTotal = Object.values(allocGroups).reduce((s, g) => s + (g.value > 0 ? g.value : g.cost), 0);
  const sortedTypes = Object.entries(allocGroups).sort((a, b) => {
    const valA = a[1].value > 0 ? a[1].value : a[1].cost;
    const valB = b[1].value > 0 ? b[1].value : b[1].cost;
    return valB - valA;
  });
  const canvasId = 'nwDonutCanvas';

  const legendRows = sortedTypes.map(([type, data]) => {
    const color = getTypeColor(type);
    const amt = data.value > 0 ? data.value : data.cost;
    return `<div style="display:flex;align-items:center;gap:6px">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <div>
        <div style="font-size:11px;font-weight:600;color:var(--text);white-space:nowrap">${esc(type)}</div>
        <div style="font-size:10px;font-weight:500;color:var(--blue);white-space:nowrap">${fUSD(amt,usdRate)} (${fRpS(Math.round(amt))})</div>
      </div>
    </div>`;
  }).join('');

  html += `<div class="chart-card" style="margin-bottom:10px">
    <div class="chart-card-title">Allocation by type</div>
    <div style="display:flex;align-items:center;gap:8px">
      <div style="position:relative;flex:0 0 auto;width:calc(100% - 95px);aspect-ratio:1">
        <canvas id="${canvasId}" role="img" aria-label="Portfolio allocation donut chart"></canvas>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;flex:0 0 88px">${legendRows}</div>
    </div>
    <div style="margin-top:10px;padding-top:8px;border-top:0.5px solid var(--border);font-size:11px;color:var(--text2)">
      FX rates: USD/IDR ${Math.round(usdRate).toLocaleString('id-ID')} · CHF/IDR ${Math.round(chfRate).toLocaleString('id-ID')}
    </div>
  </div>`;

  document.getElementById('nwContent').innerHTML = html;

  // Init donut chart after DOM is set
  requestAnimationFrame(() => {
    const canvas = document.getElementById(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;

    // Destroy previous instance if exists
    const prev = Chart.getChart(canvas);
    if (prev) prev.destroy();

    const chartData = sortedTypes.map(([type, data]) => ({
      label: type,
      value: data.value > 0 ? data.value : data.cost,
      color: getTypeColor(type)
    }));
    const total = grandTotal;

    // Custom plugin: % inside ring + curved label outside ring
    const arcLabelPlugin = {
      id: 'arcLabels',
      afterDraw(chart) {
        const { ctx, _metasets } = chart;
        const meta = _metasets[0];
        if (!meta || !meta.data.length) return;
        meta.data.forEach((arc, i) => {
          const d = chartData[i];
          const pct = Math.round((d.value / total) * 100);
          const midAngle = (arc.startAngle + arc.endAngle) / 2;
          const midRadius = (arc.innerRadius + arc.outerRadius) / 2;

          // % inside ring — threshold in radians so it works on any canvas size
          // 0.12 rad ≈ 7° which covers smaller slices down to ~2%
          const ix = arc.x + Math.cos(midAngle) * midRadius;
          const iy = arc.y + Math.sin(midAngle) * midRadius;
          const ringWidth = arc.outerRadius - arc.innerRadius;
          const arcSpan = Math.abs(arc.endAngle - arc.startAngle);
          if (arcSpan > 0.12 && ringWidth > 10) {
            ctx.save();
            ctx.font = `bold ${Math.max(8, Math.min(11, ringWidth * 0.28))}px -apple-system, sans-serif`;
            ctx.fillStyle = 'rgba(0,0,0,0.85)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(pct + '%', ix, iy);
            ctx.restore();
          }

          // Curved label outside ring — draw label for every slice
          const labelR = arc.outerRadius + 11;
          const fontSize = 9;
          const charWidth = fontSize * 0.58;

          // isBottom: verified against actual segment midAngles with real data
          // US Stock 342° → false, Reksa Dana 103° → true,
          // Cash 188° → true, JHT 240° → false, Forex 263° → false
          const normalMid = ((midAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          const isBottom = normalMid > Math.PI / 3 && normalMid < 7 * Math.PI / 6;

          const anglePerChar = charWidth / labelR;

          ctx.save();
          ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, sans-serif`;
          ctx.fillStyle = d.color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          if (!isBottom) {
            // Top half: draw L→R clockwise along outer edge
            const startA = midAngle - (d.label.length - 1) * anglePerChar / 2;
            for (let j = 0; j < d.label.length; j++) {
              const a = startA + j * anglePerChar;
              ctx.save();
              ctx.translate(arc.x + Math.cos(a) * labelR, arc.y + Math.sin(a) * labelR);
              ctx.rotate(a + Math.PI / 2);
              ctx.fillText(d.label[j], 0, 0);
              ctx.restore();
            }
          } else {
            // Bottom half: draw L→R counter-clockwise so text is not upside-down
            // Start from the right end of the label arc and go left
            const startA = midAngle + (d.label.length - 1) * anglePerChar / 2;
            for (let j = 0; j < d.label.length; j++) {
              const a = startA - j * anglePerChar;
              ctx.save();
              ctx.translate(arc.x + Math.cos(a) * labelR, arc.y + Math.sin(a) * labelR);
              ctx.rotate(a - Math.PI / 2);
              ctx.fillText(d.label[j], 0, 0);
              ctx.restore();
            }
          }

          ctx.restore();
        });
      }
    };

    new Chart(canvas, {
      type: 'doughnut',
      plugins: [arcLabelPlugin],
      data: {
        labels: chartData.map(d => d.label),
        datasets: [{
          data: chartData.map(d => d.value),
          backgroundColor: chartData.map(d => d.color),
          borderWidth: 3,
          borderColor: '#1c1c1e',
          hoverOffset: 0,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '38%',
        layout: { padding: 28 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const pct = Math.round((ctx.parsed / total) * 100);
                const amt = ctx.parsed >= 1e6
                  ? 'Rp' + (ctx.parsed/1e6).toFixed(1) + 'jt'
                  : 'Rp' + Math.round(ctx.parsed).toLocaleString('id-ID');
                return ` ${amt} · ${pct}%`;
              }
            },
            backgroundColor: 'rgba(30,30,32,0.95)',
            titleColor: 'rgba(255,255,255,0.9)',
            bodyColor: 'rgba(255,255,255,0.55)',
            borderColor: 'rgba(255,255,255,0.08)',
            borderWidth: 0.5,
            padding: 10,
            cornerRadius: 8,
          }
        }
      }
    });
  });
}

function updateHeaderHeight(){
  const h=document.querySelector('.header');
  if(h)document.documentElement.style.setProperty('--header-height',h.offsetHeight+'px');
}

// iOS standalone/PWA mode recomputes 100dvh mid-gesture (WebKit quirk), which
// reflows #page-home's height under a finger scrolling #calTxList and makes the
// scroll appear to snap back before reaching the last item. Pin the height to a
// JS-measured value instead, refreshed only on real viewport-size changes (never
// on scroll) so an in-progress touch-scroll can't trigger this reflow.
let _lastAppVh = 0;
function updateAppVh(){
  const vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  if (Math.abs(vh - _lastAppVh) < 1) return;
  _lastAppVh = vh;
  document.documentElement.style.setProperty('--app-vh', vh + 'px');
  window.scrollTo(0, 0);
}
updateAppVh();
window.addEventListener('resize', updateAppVh);
window.addEventListener('orientationchange', updateAppVh);
if (window.visualViewport) window.visualViewport.addEventListener('resize', updateAppVh);

// Prevent window scroll from shifting fixed/absolute overlays on input focus
window.addEventListener('scroll', () => {
  if (window.scrollY !== 0 || window.scrollX !== 0) {
    window.scrollTo(0, 0);
  }
});
if (window.visualViewport) {
  window.visualViewport.addEventListener('scroll', () => {
    if (window.visualViewport.offsetTop !== 0 || window.visualViewport.offsetLeft !== 0) {
      window.scrollTo(0, 0);
    }
  });
}

// Keeps the currently-open input-sheet overlay anchored within the area the
// on-screen keyboard hasn't covered, instead of the full layout viewport —
// otherwise the sheet (and its focused input) ends up hidden below the keyboard.
function adjustOverlayForVisualViewport() {
  const ov = document.querySelector('.input-overlay.open');
  if (!ov) return;
  const vv = window.visualViewport;
  if (!vv) { ov.style.top = ''; ov.style.height = ''; return; }
  ov.style.top = vv.offsetTop + 'px';
  ov.style.height = vv.height + 'px';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', adjustOverlayForVisualViewport);
  window.visualViewport.addEventListener('scroll', adjustOverlayForVisualViewport);
}

// ── SEARCH FUNCTIONS ──────────────────────────────────────────
let searchTimeout;
let searchCurrentResults = [];
let searchPageIndex = 0;
let searchActiveQuery = '';
let searchScrollAttached = false;
let allTxResults = [];
let allTxPageIndex = 0;

function renderSearchOrMonitor() {
  const query = (document.getElementById('searchInput')?.value || '').trim();
  const monitorContainer = document.getElementById('searchMonitorContainer');
  const resultsCount = document.getElementById('searchResultsCount');
  const results = document.getElementById('searchResults');
  
  if (query) {
    if (monitorContainer) monitorContainer.style.display = 'none';
    if (resultsCount) resultsCount.style.display = 'block';
    if (results) results.style.display = 'block';
  } else {
    if (resultsCount) resultsCount.style.display = 'none';
    if (results) results.style.display = 'none';
    if (monitorContainer) {
      monitorContainer.style.display = 'block';
      renderCCMonitor();
    }
  }
}

function onSearchInput() {
  const val = document.getElementById('searchInput').value.trim();
  document.getElementById('searchClearBtn').style.display = val ? 'flex' : 'none';
  clearTimeout(searchTimeout);
  if (!val) { clearSearch(); return; }
  searchTimeout = setTimeout(() => {
    renderSearchOrMonitor();
    performSearch(val);
  }, 300);
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchClearBtn').style.display = 'none';
  searchCurrentResults = [];
  searchPageIndex = 0;
  searchActiveQuery = '';
  renderSearchOrMonitor();
}

// Collapses paired Transfer rows (same shared xfr_ id — one expense leg on the
// source PM, one income leg on the destination PM) into a single display item,
// same shape as the calendar's calGetMonthData merge (index.html ~5776).
function mergeTransferPairs(results) {
  const xfrGroups = {};
  results.forEach(item => {
    const row = item.row;
    if (item.source === 'hist-opex' && (row.cat || row.category) === 'Transfer' && row.id && String(row.id).startsWith('xfr_')) {
      (xfrGroups[row.id] || (xfrGroups[row.id] = [])).push(item);
    }
  });
  const toRemove = new Set();
  const merged = [];
  Object.entries(xfrGroups).forEach(([xfrId, items]) => {
    if (items.length < 2) return;
    const expItem = items.find(it => (it.row.exp || 0) > 0);
    const incItem = items.find(it => (it.row.inc || 0) > 0);
    if (!expItem || !incItem) return;
    items.forEach(it => toRemove.add(it));
    const expRow = expItem.row, incRow = incItem.row;
    merged.push({
      source: 'hist-transfer', idx: xfrId, type: 'opex',
      row: {
        ...expRow,
        tx: `${expRow.pm} → ${incRow.pm}`, pm: `${expRow.pm} → ${incRow.pm}`,
        cat: 'Transfer', category: 'Transfer', amt: expRow.exp || 0, type: 'transfer',
        transferFromPm: expRow.pm, transferToPm: incRow.pm,
      },
    });
  });
  return toRemove.size ? results.filter(item => !toRemove.has(item)).concat(merged) : results;
}

function performSearch(query) {
  const q = query.toLowerCase();
  const results = [];
  
  const histOpex = HIST.opex || [];
  for (let i = 0; i < histOpex.length; i++) {
    const row = histOpex[i];
    const txMatch = row.tx && row.tx.toLowerCase().includes(q);
    const notesMatch = row.notes && row.notes.toLowerCase().includes(q);
    if (txMatch || notesMatch) results.push({source: 'hist-opex', idx: i, row, type: 'opex'});
  }
  
  const histInvest = HIST.invest || [];
  for (let i = 0; i < histInvest.length; i++) {
    const row = histInvest[i];
    const txMatch = row.stock && row.stock.toLowerCase().includes(q);
    if (txMatch) results.push({source: 'hist-invest', idx: i, row, type: 'invest'});
  }
  
  for (let i = 0; i < txHistory.length; i++) {
    const r = txHistory[i];
    const txMatch = r.tx && r.tx.toLowerCase().includes(q);
    const notesMatch = r.notes && r.notes.toLowerCase().includes(q);
    if (txMatch || notesMatch) results.push({source: 'local-opex', idx: i, row: r, type: 'opex'});
  }
  
  for (let i = 0; i < investHistory.length; i++) {
    const r = investHistory[i];
    const txMatch = r.stock && r.stock.toLowerCase().includes(q);
    if (txMatch) results.push({source: 'local-invest', idx: i, row: r, type: 'invest'});
  }

  const merged = mergeTransferPairs(results);
  merged.sort((a, b) => {
    const dateA = new Date(a.row.date || `${a.row.y}-${String(a.row.m+1).padStart(2,'0')}-${String(a.row.d).padStart(2,'0')}`);
    const dateB = new Date(b.row.date || `${b.row.y}-${String(b.row.m+1).padStart(2,'0')}-${String(b.row.d).padStart(2,'0')}`);
    return dateB - dateA;
  });
  
  searchCurrentResults = merged;
  searchPageIndex = 0;
  renderSearchResults(q);
}

function renderTxItemHTML(item, query) {
  const row = item.row;
  const isInvest = item.type === 'invest';
  const isPending = item.source.startsWith('local');

  let date, tx, cat, pm, amount, notes, icon, cls, color;
  if (isInvest) {
    date = row.date ? isoDisp(row.date) : `${row.d} ${MO[row.m]} ${row.y}`;
    tx = row.stock;
    cat = row.type || 'Stock';
    pm = row.action;
    amount = fRp(row.totalIdr || (row.lot * row.price));
    icon = '📈'; cls = 'invest'; color = 'var(--blue)';
  } else {
    date = row.date ? isoDisp(row.date) : `${row.d} ${MO[row.m]} ${row.y}`;
    tx = row.tx;
    cat = row.cat || row.category;
    pm = row.pm;
    amount = fRp(row.exp || row.amount);
    notes = row.notes || '';
    icon = '💳';
    const pmStyle = PM_STYLES[pm] || PM_STYLE_DEFAULT;
    cls = pmStyle.cls;
    color = pmStyle.color;
  }

  const syncBadge = isPending && !row.synced ? '<span class="badge badge-pending">pending</span>' : '';
  const notesHtml = !isInvest && notes ? `<div class="search-item-note">${highlightMatches(notes, query)}</div>` : '';

  // A Transfer is a paired expense+income row set — row.type/'category' catch both the merged
  // (synced, tappable) shape from mergeTransferPairs and a pending local {type:'transfer'} row
  // (not yet split into paired sheet rows, so never tappable — same as the calendar).
  const isTransfer = !isInvest && (row.cat === 'Transfer' || row.category === 'Transfer' || row.type === 'transfer');
  const editable = isInvest ? !!row.id : (item.source === 'hist-transfer' ? true : !isTransfer);
  const tapAttrs = editable
    ? ` data-idx="${item.idx}" data-source="${item.source}" data-type="${isInvest ? 'invest' : (item.source === 'hist-transfer' ? 'transfer' : 'opex')}" style="cursor:pointer"`
    : '';

  if (isTransfer) { icon = '🔁'; cls = 'transfer'; color = '#a78bfa'; }
  const metaLine = isTransfer ? 'Transfer' : `${esc(cat)} · ${esc(pm)}`;

  return `<div class="tx-item"${tapAttrs}>
    <div class="tx-icon ${cls}">${icon}</div>
    <div class="tx-info" style="flex:1">
      <div class="tx-payee">${highlightMatches(tx, query)}${syncBadge}</div>
      <div class="tx-meta">${date} • ${metaLine}</div>
      ${notesHtml}
    </div>
    <div class="tx-amount" style="color:${color}">${amount}</div>
  </div>`;
}

function renderSearchResults(query) {
  searchActiveQuery = query;
  const countEl = document.getElementById('searchResultsCount');
  const resultsEl = document.getElementById('searchResults');
  const total = searchCurrentResults.length;

  if (total === 0) {
    countEl.style.display = 'none';
    resultsEl.innerHTML = '<div class="empty-state">No results found</div>';
    return;
  }

  countEl.style.display = 'block';
  countEl.textContent = `Found ${total} result${total !== 1 ? 's' : ''} for "${query}"`;

  const pageSize = 20;
  const pageResults = searchCurrentResults.slice(0, (searchPageIndex + 1) * pageSize);

  resultsEl.innerHTML = pageResults.map(item => renderTxItemHTML(item, query)).join('');

  if (pageResults.length < total) {
    resultsEl.innerHTML += `<div class="search-loading">Scroll for more… (${pageResults.length}/${total})</div>`;
  }
}

function renderAllTransactions() {
  const countEl = document.getElementById('searchResultsCount');
  const resultsEl = document.getElementById('searchResults');

  if (!histLoaded) {
    countEl.style.display = 'none';
    resultsEl.innerHTML = '<div class="empty-state">Loading…</div>';
    return;
  }

  const results = [];
  const histOpex = HIST.opex || [];
  for (let i = 0; i < histOpex.length; i++) {
    results.push({source:'hist-opex', idx:i, row:histOpex[i], type:'opex'});
  }
  for (let i = 0; i < liveInvest.length; i++) {
    results.push({source:'live-invest', idx:i, row:liveInvest[i], type:'invest'});
  }
  for (let i = 0; i < txHistory.length; i++) {
    results.push({source:'local-opex', idx:i, row:txHistory[i], type:'opex'});
  }
  // Unsynced local invest rows only — once synced they're already in liveInvest (see syncInvest).
  for (let i = 0; i < investHistory.length; i++) {
    if (investHistory[i].synced) continue;
    results.push({source:'local-invest', idx:i, row:investHistory[i], type:'invest'});
  }

  const merged = mergeTransferPairs(results);
  merged.sort((a, b) => {
    const dateA = new Date(a.row.date || `${a.row.y}-${String(a.row.m+1).padStart(2,'0')}-${String(a.row.d).padStart(2,'0')}`);
    const dateB = new Date(b.row.date || `${b.row.y}-${String(b.row.m+1).padStart(2,'0')}-${String(b.row.d).padStart(2,'0')}`);
    return dateB - dateA;
  });

  allTxResults = merged;
  allTxPageIndex = 0;
  renderAllTxPage();
}

function renderAllTxPage() {
  const countEl = document.getElementById('searchResultsCount');
  const resultsEl = document.getElementById('searchResults');
  const total = allTxResults.length;

  countEl.style.display = 'block';
  countEl.textContent = `All transactions · ${total} total`;

  const pageSize = 20;
  const pageResults = allTxResults.slice(0, (allTxPageIndex + 1) * pageSize);

  resultsEl.innerHTML = pageResults.map(item => renderTxItemHTML(item, '')).join('');

  if (pageResults.length < total) {
    resultsEl.innerHTML += `<div class="search-loading">Scroll for more… (${pageResults.length}/${total})</div>`;
  }
}

function loadMoreAllTx() {
  const pageSize = 20;
  if ((allTxPageIndex + 1) * pageSize < allTxResults.length) {
    allTxPageIndex++;
    renderAllTxPage();
  }
}

function loadMoreSearchResults(query) {
  const pageSize = 20;
  const total = searchCurrentResults.length;
  const currentShown = (searchPageIndex + 1) * pageSize;
  if (currentShown < total) {
    searchPageIndex++;
    renderSearchResults(query);
  }
}

function highlightMatches(text, query) {
  const safe = esc(text);
  if (!query) return safe;
  const regex = new RegExp(`(${esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(regex, '<span class="highlight">$1</span>');
}

function openSearchTxEdit(source, idx) {
  const row = source === 'hist-opex' ? (HIST.opex || [])[idx]
            : source === 'local-opex' ? (txHistory || [])[idx]
            : null;
  if (!row) return;
  const dateStr = row.date ? String(row.date).slice(0, 10)
    : `${row.y}-${String(row.m + 1).padStart(2, '0')}-${String(row.d).padStart(2, '0')}`;
  openEditOverlayFromRow(row, dateStr);
}

function openSearchInvestEdit(source, idx) {
  const row = source === 'live-invest' ? (liveInvest || [])[idx]
            : source === 'hist-invest' ? (HIST.invest || [])[idx]
            : null;
  if (!row || !row.id) return;
  openEditInvestOverlay(row);
}

// Re-resolves both legs from live HIST.opex at tap time (rather than trusting the
// merged row captured at render time), same pattern as openSearchTxEdit.
function openSearchTransferEdit(xfrId) {
  const rows = (HIST.opex || []).filter(r => r.id === xfrId && (r.cat || r.category) === 'Transfer');
  const expRow = rows.find(r => (r.exp || 0) > 0);
  const incRow = rows.find(r => (r.inc || 0) > 0);
  if (!expRow || !incRow) return;
  const merged = {
    ...expRow, cat: 'Transfer', category: 'Transfer', amt: expRow.exp || 0,
    sheetId: expRow.id || null, transferFromPm: expRow.pm, transferToPm: incRow.pm,
  };
  const dateStr = expRow.date ? String(expRow.date).slice(0, 10)
    : `${expRow.y}-${String(expRow.m + 1).padStart(2, '0')}-${String(expRow.d).padStart(2, '0')}`;
  openEditTransferOverlay(merged, dateStr);
}

function initSearchPage() {
  if (!searchScrollAttached) {
    searchScrollAttached = true;
    const resultsEl = document.getElementById('searchResults');
    resultsEl.addEventListener('scroll', () => {
      if (resultsEl.scrollTop + resultsEl.clientHeight >= resultsEl.scrollHeight - 100) {
        if (searchActiveQuery) loadMoreSearchResults(searchActiveQuery);
        else loadMoreAllTx();
      }
    });

    // Reliable tap-to-edit on mobile: inline onclick is swallowed by iOS
    // -webkit-overflow-scrolling:touch scroll layers. Use touchstart/touchend
    // event delegation on the container to detect taps vs scrolls (same
    // pattern as #calTxList).
    const fireSearchTap = item => {
      const { type, source, idx } = item.dataset;
      if (type === 'invest') openSearchInvestEdit(source, parseInt(idx));
      else if (type === 'transfer') openSearchTransferEdit(idx); // idx is the xfr_ id string, not a numeric index
      else openSearchTxEdit(source, parseInt(idx));
    };

    const setupTapToEdit = el => {
      if (!el) return;
      let _ts = 0, _tx = 0, _ty = 0, _touchFired = 0;
      el.addEventListener('touchstart', e => {
        _ts = Date.now(); _tx = e.touches[0].clientX; _ty = e.touches[0].clientY;
      }, {passive: true});
      el.addEventListener('touchend', e => {
        const dt = Date.now() - _ts;
        const dx = Math.abs(e.changedTouches[0].clientX - _tx);
        const dy = Math.abs(e.changedTouches[0].clientY - _ty);
        if (dt > 400 || dx > 8 || dy > 8) return; // scroll or long-press
        const item = e.target.closest('.tx-item[data-idx], .detail-item[data-idx]');
        if (!item) return;
        _touchFired = Date.now(); fireSearchTap(item);
      }, {passive: true});
      el.addEventListener('click', e => {
        if (Date.now() - _touchFired < 600) return;
        const item = e.target.closest('.tx-item[data-idx], .detail-item[data-idx]');
        if (!item) return;
        fireSearchTap(item);
      });
    };

    setupTapToEdit(resultsEl);
    setupTapToEdit(document.getElementById('searchMonitorContainer'));
  }
  clearSearch();
}

// Nota Public has no data.json bulk-history snapshot (unlike the original Nota app
// this was forked from) — full Opex history is fetched directly from the user's
// own Sheet via ?type=allOpex instead.
async function loadHistData(_isRetry) {
  try {
    const res = await fetch(apiGet('type=allOpex'), { method: 'GET' });
    const j = await res.json();
    if (j.status !== 'ok' || !Array.isArray(j.rows)) throw new Error('bad allOpex response');
    HIST.opex = j.rows;
    // Re-apply cached live month rows so the allOpex fetch doesn't clobber a more
    // recent optimistic/local edit (race condition: fetchCurrentMonthFresh may have
    // completed first).
    const now = new Date();
    const cachedRows = JSON.parse(localStorage.getItem(curMonthCacheKey()) || 'null');
    if (cachedRows && cachedRows.length > 0) _applyCurrentMonthRows(cachedRows, now.getFullYear(), now.getMonth()+1);
    if (j.txCat) { HIST.txCat = j.txCat; localStorage.setItem('notapub_txCat', JSON.stringify(j.txCat)); }
    if (j.txPm)  { HIST.txPm  = j.txPm;  localStorage.setItem('notapub_txPm', JSON.stringify(j.txPm)); }
    histLoaded = true;
    histLoadFailed = false;
    pruneStaleHistory();
    buildAccountBalances();
    renderAccountBalanceCards();
    histLoadCallbacks.forEach(cb => cb());
    histLoadCallbacks = [];
  } catch(e) {
    console.warn('allOpex load failed:', e.message);
    // One automatic retry before giving up — a lot of failures here are a transient
    // token refresh/network hiccup during the same startup window, not a real outage.
    if (!_isRetry) {
      await new Promise(r => setTimeout(r, 1500));
      return loadHistData(true);
    }
    const cachedCat = localStorage.getItem('notapub_txCat');
    const cachedPm  = localStorage.getItem('notapub_txPm');
    if (cachedCat) HIST.txCat = JSON.parse(cachedCat);
    if (cachedPm)  HIST.txPm  = JSON.parse(cachedPm);
    // Falling back to whatever's cached (often just recent months) rather than the
    // full history — mark it so the app can distinguish "loaded" from "gave up" and
    // offer to retry, instead of silently pretending history is complete.
    histLoaded = true;
    histLoadFailed = true;
    showToast('Couldn’t load full history — showing cached data', 'error', 4000);
    pruneStaleHistory();
    buildAccountBalances();
    renderAccountBalanceCards();
    histLoadCallbacks.forEach(cb => cb());
    histLoadCallbacks = [];
  }
}

window.addEventListener('notaOpexUpdated', (e) => {
  const j = e.detail;
  if (!j || !Array.isArray(j.rows)) return;
  
  HIST.opex = j.rows;
  if (j.txCat) { HIST.txCat = j.txCat; localStorage.setItem('notapub_txCat', JSON.stringify(j.txCat)); }
  if (j.txPm)  { HIST.txPm  = j.txPm;  localStorage.setItem('notapub_txPm', JSON.stringify(j.txPm)); }
  
  // Update views safely
  pruneStaleHistory();
  buildAccountBalances();
  if (document.getElementById('insightsView').style.display === 'block') {
    renderInsights();
  } else if (document.getElementById('histView').style.display === 'block') {
    renderHistTab();
  }
  renderAccountBalanceCards();
});

(function() {
  const cachedCat = localStorage.getItem('notapub_txCat');
  const cachedPm  = localStorage.getItem('notapub_txPm');
  const cachedAccount = localStorage.getItem('notapub_txAccount');
  if (cachedCat) HIST.txCat = JSON.parse(cachedCat);
  if (cachedPm)  HIST.txPm  = JSON.parse(cachedPm);
  if (cachedAccount) HIST.txAccount = JSON.parse(cachedAccount);
})();

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