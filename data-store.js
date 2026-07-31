// Nota — data layer that replaces Nota's Apps Script backend.
// Same JSON shapes as the old ?type=... API, but reads/writes go straight
// to a Google Sheet the app created in the signed-in user's own Drive
// (via SheetsClient), scoped by drive.file so nothing else in their
// account is touched.

const DataStore = (() => {
  const LS_SS_ID = 'notaPublic_spreadsheetId';
  const LS_OPEX_GID = 'notaPublic_opexSheetId';
  const LS_INVEST_GID = 'notaPublic_investSheetId';
  const LS_SPLIT_MIGRATED = 'notaPublic_splitMigratedV1';

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const STOCK_PRICES_SHEET = 'Stock Prices';
  const GOALS_SHEET = 'Goals';
  const RECURRING_SHEET = 'Recurring';
  const GOALS_START_ROW = 2;     // Goals sheet: header row 1, data from row 2
  const RECURRING_DATA_ROW = 2;  // Recurring sheet: header row 1, data from row 2
  const OLD_GOALS_START_ROW = 15; // pre-split location, used only during migration
  const CONFIG_SHEET = 'Config';
  const CONFIG_DATA_ROW = 2;
  const BALANCES_SHEET = 'Balances';

  const CAT_COLOR_DEFAULTS = {
    'Transport':'#60a0f0','Meals':'#c8f060','Entertainment':'#ff6b6b','Groceries':'#ffaa44',
    'Household':'#a78bfa','Medical':'#34d399','Utilities':'#f472b6',
    'Gas':'#fbbf24','Travel':'#22d3ee','Insurance':'#e879f9',
    'Gifts':'#fca5a5','Self Care':'#c4b5fd',
    'Home Repair':'#f87171','Income':'#4ade80',
  };
  const ACCOUNT_CCY_DEFAULTS = {'USD CIMB':'USD'};
  const STOCK_TYPE_DEFAULTS = {'USDIDR CIMB':'Forex'};

  const CONFIG_DEFAULTS = [
    ...['Entertainment','Gas','Gifts','Groceries','Home Repair','Household','Income','Insurance','Meals','Medical','Self Care','Transport','Travel','Utilities']
      .map((name, i) => ({ kind: 'category', name, color: CAT_COLOR_DEFAULTS[name] || '', ccy: '', assetType: '', archived: false, sortOrder: i })),
    ...['BCA','CIMB Niaga','eWallet','Flazz']
      .map((name, i) => ({ kind: 'pm', name, color: '', ccy: '', assetType: '', archived: false, sortOrder: i })),
    ...['USDIDR CIMB']
      .map((name, i) => ({ kind: 'stock', name, color: '', ccy: '', assetType: STOCK_TYPE_DEFAULTS[name] || '', archived: false, sortOrder: i })),
    ...['IDR CIMB','USD CIMB','IDR BCA','IDR Maybank']
      .map((name, i) => ({ kind: 'account', name, color: '', ccy: ACCOUNT_CCY_DEFAULTS[name] || '', assetType: '', archived: false, sortOrder: i })),
  ];

  let spreadsheetId = localStorage.getItem(LS_SS_ID) || null;
  let opexGid = localStorage.getItem(LS_OPEX_GID) ? Number(localStorage.getItem(LS_OPEX_GID)) : null;
  let investGid = localStorage.getItem(LS_INVEST_GID) ? Number(localStorage.getItem(LS_INVEST_GID)) : null;

  // ── BOOTSTRAP ────────────────────────────────────────────────
  // Finds a "Nota Data" spreadsheet this app already created for the signed-in
  // user, if one exists — drive.file scope lets the app see files it created
  // in a *previous* session even after localStorage (which is all that used to
  // be checked here) gets cleared, e.g. iOS Safari/PWA evicting site storage.
  // Without this, every localStorage loss silently created a fresh duplicate.
  async function findExistingSpreadsheet() {
    const res = await SheetsClient.findFiles(
      "name='Nota Data' and trashed=false and mimeType='application/vnd.google-apps.spreadsheet'"
    );
    const files = (res.files || []).filter(f => !f.trashed);
    if (!files.length) return null;
    files.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
    return files[0]; // oldest = the original, in case duplicates already exist
  }

  async function bootstrap() {
    if (spreadsheetId) {
      // Already set up on this browser in a prior session — still worth a one-time
      // check for the sheet-split migration, since that shipped after many users
      // already had spreadsheetId cached (which used to skip this whole function).
      if (!localStorage.getItem(LS_SPLIT_MIGRATED)) {
        const meta = await SheetsClient.getSpreadsheetMeta(spreadsheetId);
        await migrateToSplitSheets(meta);
        localStorage.setItem(LS_SPLIT_MIGRATED, '1');
      }
      return;
    }

    const existing = await findExistingSpreadsheet();
    if (existing) {
      spreadsheetId = existing.id;
      const meta = await SheetsClient.getSpreadsheetMeta(spreadsheetId);
      const opexSheet = (meta.sheets || []).find(s => s.properties.title === 'Opex');
      const investSheet = (meta.sheets || []).find(s => s.properties.title === 'Invest');
      opexGid = opexSheet ? opexSheet.properties.sheetId : null;
      investGid = investSheet ? investSheet.properties.sheetId : null;
      localStorage.setItem(LS_SS_ID, spreadsheetId);
      if (opexGid != null) localStorage.setItem(LS_OPEX_GID, String(opexGid));
      if (investGid != null) localStorage.setItem(LS_INVEST_GID, String(investGid));
      await migrateToSplitSheets(meta);
      localStorage.setItem(LS_SPLIT_MIGRATED, '1');
      return;
    }

    const created = await SheetsClient.create({
      properties: { title: 'Nota Data' },
      sheets: [
        { properties: { title: 'Opex', sheetId: 0 } },
        { properties: { title: 'Invest', sheetId: 1 } },
        { properties: { title: CONFIG_SHEET, sheetId: 2 } },
        { properties: { title: STOCK_PRICES_SHEET, sheetId: 3 } },
        { properties: { title: GOALS_SHEET, sheetId: 4 } },
        { properties: { title: RECURRING_SHEET, sheetId: 5 } },
        { properties: { title: BALANCES_SHEET, sheetId: 6 } },
      ],
    });
    spreadsheetId = created.spreadsheetId;
    opexGid = created.sheets.find(s => s.properties.title === 'Opex').properties.sheetId;
    investGid = created.sheets.find(s => s.properties.title === 'Invest').properties.sheetId;

    localStorage.setItem(LS_SS_ID, spreadsheetId);
    localStorage.setItem(LS_OPEX_GID, String(opexGid));
    localStorage.setItem(LS_INVEST_GID, String(investGid));
    localStorage.setItem(LS_SPLIT_MIGRATED, '1');

    await SheetsClient.updateValues(spreadsheetId, 'Opex!A1:K1', [[
      'Date','Month','Category','Transaction','PM','Income','Expense','Notes','Deleted','Future','TxID',
    ]]);
    await SheetsClient.updateValues(spreadsheetId, 'Invest!A1:J1', [[
      'Date','Stock','Type','Action','Account','Lot','Price','TotalIdr','TxID','LinkedOpexTxID',
    ]]);
    await SheetsClient.updateValues(spreadsheetId, `${STOCK_PRICES_SHEET}!A1:B1`, [['Label', 'Price']]);
    await SheetsClient.updateValues(spreadsheetId, `${STOCK_PRICES_SHEET}!A2:B8`, [
      ['AAPL',''], ['JNJ',''], ['VYM',''], ['QQQ',''], ['CHF IDR',''], ['USD IDR',''], ['Star Stable',''],
    ]);
    await SheetsClient.updateValues(spreadsheetId, `${GOALS_SHEET}!A1:G1`, [[
      'Name','StartDate','EndDate','TargetAmt','Sources','Completed','CompletedDate',
    ]]);
    await SheetsClient.updateValues(spreadsheetId, `${RECURRING_SHEET}!A1:L1`, [[
      'id','type','tx','cat','amount','pm','notes','dayOfMonth','active','lastFired','_deleted','endMonth',
    ]]);
    await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A1:J1`, [[
      'kind', 'name', 'color', 'ccy', 'assetType', 'archived', 'sortOrder', 'linkedPM', 'balance', 'balanceDate',
    ]]);
    const configRows = CONFIG_DEFAULTS.map(it => [
      it.kind, it.name, it.color, it.ccy, it.assetType, it.archived ? 'TRUE' : 'FALSE', it.sortOrder, it.linkedPM || '',
      (it.balance !== null && it.balance !== undefined && String(it.balance).trim() !== '') ? Number(it.balance) : '',
      String(it.balanceDate || '').slice(0, 10),
    ]);
    await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:J${CONFIG_DATA_ROW + configRows.length - 1}`, configRows);
    await SheetsClient.updateValues(spreadsheetId, `${BALANCES_SHEET}!A1:D1`, [[
      'Account', 'Date', 'Amount', 'TxID',
    ]]);
    await SheetsClient.batchUpdate(spreadsheetId, [{
      repeatCell: {
        range: { sheetId: opexGid, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'MMM yyyy' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    }]);
  }

  // ── MIGRATION: split Invest's prices/goals/recurring blocks into their own sheets ──
  // Idempotent and resumable: each block checks whether its destination sheet already
  // has a header before copying, so a migration interrupted partway (tab closed, network
  // drop) just re-attempts whichever blocks didn't finish, next time bootstrap() runs.
  async function migrateToSplitSheets(meta) {
    const titles = (meta.sheets || []).map(s => s.properties.title);
    const missing = [STOCK_PRICES_SHEET, GOALS_SHEET, RECURRING_SHEET, BALANCES_SHEET].filter(t => !titles.includes(t));
    if (missing.length) {
      await SheetsClient.batchUpdate(spreadsheetId, missing.map(title => ({ addSheet: { properties: { title } } })));
    }
    await migratePricesBlock();
    await migrateGoalsBlock();
    await migrateRecurringBlock();
    await migrateBalancesHeader();
  }

  async function sheetHasHeader(sheetName) {
    const res = await SheetsClient.getValues(spreadsheetId, `${sheetName}!A1`);
    return !!(res.values && res.values[0] && res.values[0][0]);
  }

  async function migratePricesBlock() {
    if (await sheetHasHeader(STOCK_PRICES_SHEET)) return;
    const old = await SheetsClient.getValues(spreadsheetId, 'Invest!J1:K7');
    const rows = old.values || [];
    await SheetsClient.updateValues(spreadsheetId, `${STOCK_PRICES_SHEET}!A1:B1`, [['Label', 'Price']]);
    if (rows.length) {
      await SheetsClient.updateValues(spreadsheetId, `${STOCK_PRICES_SHEET}!A2:B${1 + rows.length}`, rows);
    }
    await SheetsClient.clearValues(spreadsheetId, 'Invest!J1:K7');
  }

  async function migrateGoalsBlock() {
    if (await sheetHasHeader(GOALS_SHEET)) return;
    const old = await SheetsClient.getValues(spreadsheetId, `Invest!J${OLD_GOALS_START_ROW}:P`);
    const dataRows = (old.values || []).filter(r => r && r[0]);
    await SheetsClient.updateValues(spreadsheetId, `${GOALS_SHEET}!A1:G1`, [[
      'Name','StartDate','EndDate','TargetAmt','Sources','Completed','CompletedDate',
    ]]);
    if (dataRows.length) {
      await SheetsClient.updateValues(spreadsheetId, `${GOALS_SHEET}!A2:G${1 + dataRows.length}`, dataRows);
    }
    await SheetsClient.clearValues(spreadsheetId, `Invest!J${OLD_GOALS_START_ROW}:P`);
  }

  async function migrateRecurringBlock() {
    if (await sheetHasHeader(RECURRING_SHEET)) return;
    const old = await SheetsClient.getValues(spreadsheetId, 'Invest!R1:AC');
    const oldRows = old.values || [];
    const header = (oldRows[0] && oldRows[0][0]) ? oldRows[0] : [
      'id','type','tx','cat','amount','pm','notes','dayOfMonth','active','lastFired','_deleted','endMonth',
    ];
    const dataRows = oldRows.slice(1).filter(r => r && r[0]);
    await SheetsClient.updateValues(spreadsheetId, `${RECURRING_SHEET}!A1:L1`, [header]);
    if (dataRows.length) {
      await SheetsClient.updateValues(spreadsheetId, `${RECURRING_SHEET}!A2:L${1 + dataRows.length}`, dataRows);
    }
    await SheetsClient.clearValues(spreadsheetId, 'Invest!R1:AC');
  }

  async function migrateBalancesHeader() {
    if (await sheetHasHeader(BALANCES_SHEET)) return;
    await SheetsClient.updateValues(spreadsheetId, `${BALANCES_SHEET}!A1:D1`, [[
      'Account', 'Date', 'Amount', 'TxID',
    ]]);
  }

  // One-time action (triggered from Settings) that installs live GOOGLEFINANCE formulas
  // into the Stock Prices sheet. Re-running is harmless — it just rewrites the same formulas.
  async function installLivePriceFormulas() {
    await SheetsClient.updateValues(spreadsheetId, `${STOCK_PRICES_SHEET}!B2:B7`, [
      ['=GOOGLEFINANCE("NASDAQ:AAPL","price")'],
      ['=GOOGLEFINANCE("NYSE:JNJ","price")'],
      ['=GOOGLEFINANCE("NYSEARCA:VYM","price")'],
      ['=GOOGLEFINANCE("NASDAQ:QQQ","price")'],
      ['=GOOGLEFINANCE("CURRENCY:CHFIDR")'],
      ['=GOOGLEFINANCE("CURRENCY:USDIDR")'],
    ], 'USER_ENTERED');
  }

  async function requireReady() {
    await Auth.ready; // blocks until sign-in + bootstrap() have completed
    if (!spreadsheetId) throw new Error('Spreadsheet not initialised — sign in first');
  }

  // ── SHARED HELPERS (ported from appsscript_v40.js) ───────────
  function isDeletedFlag(v) { return String(v).trim().toLowerCase() === 'deleted'; }

  function normalizeMonthKey(val) {
    const s = String(val).trim();
    const old = s.match(/^([A-Za-z]{3})\s+(\d{4})$/);
    if (old) {
      const idx = MONTHS.findIndex(mo => mo.toLowerCase() === old[1].toLowerCase());
      if (idx >= 0) return (idx + 1) + '/1/' + old[2];
    }
    return s;
  }

  function parseDayFromCell(v) {
    const m = String(v).match(/^(\d+)/);
    return m ? parseInt(m[1]) : 0;
  }

  function formatDateStr(dateInput) {
    const s = String(dateInput).trim();
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      const day = isoMatch[3];
      const mon = MONTHS[parseInt(isoMatch[2], 10) - 1];
      const yr = isoMatch[1].slice(-2);
      return `${day} ${mon} ${yr}`;
    }
    const strMatch = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
    if (strMatch) {
      const day = strMatch[1].padStart(2, '0');
      const mon = strMatch[2].charAt(0).toUpperCase() + strMatch[2].slice(1, 3).toLowerCase();
      const yr = strMatch[3].length === 4 ? strMatch[3].slice(-2) : strMatch[3].padStart(2, '0');
      return `${day} ${mon} ${yr}`;
    }
    return s;
  }

  function deriveMonthKey(dateInput) {
    const s = String(dateInput).trim();
    const isoMatch = s.match(/^(\d{4})-(\d{2})/);
    if (isoMatch) return MONTHS[parseInt(isoMatch[2], 10) - 1] + ' ' + isoMatch[1];
    const strMatch = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
    if (strMatch) {
      const mon = strMatch[2].charAt(0).toUpperCase() + strMatch[2].slice(1, 3).toLowerCase();
      const year = strMatch[3].length === 2 ? '20' + strMatch[3] : strMatch[3];
      return mon + ' ' + year;
    }
    return '';
  }

  function cellToDateStr(val) { return String(val || '').trim(); }

  // Invest!A has a mix of formats across its history: legacy rows entered as
  // "DD/MM/YYYY" and rows written by this app via formatDateStr() as "DD Mon YY".
  // Comparing either of those directly against an ISO "YYYY-MM-DD" `since` cutoff
  // with plain string `<` is meaningless (e.g. "07/05/2025" < "2000-01-01" is TRUE
  // because '0' < '2' lexically) and was silently dropping most rows from
  // handleGetInvest — normalize to ISO first so the comparison is actually valid.
  function parseAnyDateToISO(val) {
    const s = String(val || '').trim();
    if (!s) return '';
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\w*\s+(\d{2,4})$/);
    if (m) {
      const idx = MONTHS.findIndex(mo => mo.toLowerCase() === m[2].slice(0, 3).toLowerCase());
      if (idx >= 0) {
        const yr = m[3].length === 2 ? '20' + m[3] : m[3];
        return `${yr}-${String(idx + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      }
    }
    return '';
  }

  // ── OPEX ──────────────────────────────────────────────────────
  async function findOpexRowById(id) {
    if (!id) return null;
    const res = await SheetsClient.getValues(spreadsheetId, 'Opex!K2:K');
    const ids = res.values || [];
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() === String(id).trim()) return i + 2;
    }
    return null;
  }

  async function writeToOpex(date, month, cat, tx, pm, action, amount, notes, future) {
    const isIncome = action === 'income';
    const income = isIncome ? amount : '';
    const expense = isIncome ? '' : amount;
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    await SheetsClient.appendValues(spreadsheetId, 'Opex!A:K', [[
      formatDateStr(date), month, cat, tx, pm, income, expense, notes || '', '', future ? 1 : 0, id,
    ]]);
    return id;
  }

  async function handleOpex(data) {
    const { action, date, month, tx, cat, pm, amount, notes, future, isIncome } = data;
    if (action === 'edit') {
      const rowIndex = await findOpexRowById(data.id);
      if (!rowIndex) return { status: 'error', message: 'Row not found' };
      const income = isIncome ? Number(amount) : '';
      const expense = isIncome ? '' : Number(amount);
      await SheetsClient.updateValues(spreadsheetId, `Opex!A${rowIndex}:J${rowIndex}`, [[
        formatDateStr(date), month, cat, tx, pm, income, expense, notes || '', '', future ? 1 : 0,
      ]]);
      return { status: 'ok' };
    }
    if (action === 'delete') {
      const rowIndex = await findOpexRowById(data.id);
      if (!rowIndex) return { status: 'error', message: 'Row not found' };
      await SheetsClient.batchUpdate(spreadsheetId, [{
        deleteDimension: {
          range: { sheetId: opexGid, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
        },
      }]);
      return { status: 'ok' };
    }
    const id = await writeToOpex(date, month, cat, tx, pm, action, amount, notes, future);
    return { status: 'ok', wrote: true, id };
  }

  async function findOpexRowsByTxId(txId) {
    if (!txId) return [];
    const res = await SheetsClient.getValues(spreadsheetId, 'Opex!K2:K');
    const ids = res.values || [];
    const rows = [];
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() === String(txId).trim()) rows.push(i + 2);
    }
    return rows;
  }

  async function handleTransfer(data) {
    if (data.action === 'delete') {
      const rowIndices = await findOpexRowsByTxId(data.id);
      if (!rowIndices.length) return { status: 'error', message: 'Transfer rows not found' };
      const sorted = [...rowIndices].sort((a, b) => b - a);
      for (const rowIndex of sorted) {
        await SheetsClient.batchUpdate(spreadsheetId, [{
          deleteDimension: {
            range: { sheetId: opexGid, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
          },
        }]);
      }
      return { status: 'ok' };
    }
    const { date, month, fromPm, toPm, amount, notes } = data;
    const groupId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    const txId = 'xfr_' + groupId;
    await SheetsClient.appendValues(spreadsheetId, 'Opex!A:K', [[
      formatDateStr(date), month, 'Transfer', 'Transfer', fromPm, '', amount, notes || '', '', 0, txId,
    ]]);
    await SheetsClient.appendValues(spreadsheetId, 'Opex!A:K', [[
      formatDateStr(date), month, 'Transfer', 'Transfer', toPm, amount, '', notes || '', '', 0, txId,
    ]]);
    return { status: 'ok', wrote: true, id: txId };
  }

  async function handleGetMonth(y, m) {
    const res = await SheetsClient.getValues(spreadsheetId, 'Opex!A2:K');
    const data = res.values || [];
    const targetMk = m + '/1/' + y;
    const rows = [];
    data.forEach((row, idx) => {
      if (normalizeMonthKey(row[1]) !== targetMk) return;
      if (isDeletedFlag(row[8])) return;
      const day = parseDayFromCell(row[0]);
      if (!day) return;
      const r = { d: day, cat: String(row[2] || '').trim(), tx: String(row[3] || '').trim(), pm: String(row[4] || '').trim(), rowIndex: idx + 2 };
      const inc = Number(row[5]) || 0, exp = Number(row[6]) || 0, notes = String(row[7] || '').trim();
      if (inc) r.inc = inc;
      if (exp) r.exp = exp;
      if (notes) r.notes = notes;
      if (Number(row[9]) === 1) r.future = true;
      if (row[10]) r.id = String(row[10]).trim();
      rows.push(r);
    });
    return { status: 'ok', rows, y, m };
  }

  // Builds a {key: [values...]} map from entries already ordered most-recent-first,
  // deduping repeated values per key while preserving that recency order.
  function buildRecentMap(entries) {
    const map = {};
    for (const { key, value } of entries) {
      if (!key || !value) continue;
      if (!map[key]) map[key] = [];
      if (!map[key].includes(value)) map[key].push(value);
    }
    return map;
  }

  // Returns every non-deleted Opex row across all months, shaped to match HIST.opex
  // ({y, m (0-indexed), d, mk, cat, tx, pm, inc?, exp?, notes?, future?, id?, rowIndex}).
  // Nota Public has no data.json bulk-history snapshot (unlike the original Nota app),
  // so the frontend calls this once at startup to populate full history directly from
  // the Sheet instead of relying on a static file that doesn't exist here.
  async function handleGetAllOpex() {
    const res = await SheetsClient.getValues(spreadsheetId, 'Opex!A2:K');
    const data = res.values || [];
    const rows = [];
    data.forEach((row, idx) => {
      if (isDeletedFlag(row[8])) return;
      const day = parseDayFromCell(row[0]);
      if (!day) return;
      const mk = normalizeMonthKey(row[1]); // "M/1/YYYY"
      const mm = mk.match(/^(\d{1,2})\/1\/(\d{4})$/);
      if (!mm) return;
      const mIdx = Number(mm[1]) - 1;
      const y = Number(mm[2]);
      const r = {
        y, m: mIdx, d: day, mk: `${MONTHS[mIdx]} ${y}`,
        cat: String(row[2] || '').trim(), tx: String(row[3] || '').trim(), pm: String(row[4] || '').trim(),
        rowIndex: idx + 2,
      };
      const inc = Number(row[5]) || 0, exp = Number(row[6]) || 0, notes = String(row[7] || '').trim();
      if (inc) r.inc = inc;
      if (exp) r.exp = exp;
      if (notes) r.notes = notes;
      if (Number(row[9]) === 1) r.future = true;
      if (row[10]) r.id = String(row[10]).trim();
      rows.push(r);
    });

    // Smart-autofill maps for the input form: what Category/PM was used for a given
    // Transaction name in the last 30 days, most-recent-first (see getSmartCats/
    // getSmartPms/autoFillIfExactMatch in index.html).
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const recent = rows
      .filter(r => new Date(r.y, r.m, r.d) >= cutoff)
      .sort((a, b) => new Date(b.y, b.m, b.d) - new Date(a.y, a.m, a.d));
    const txCat = buildRecentMap(recent.map(r => ({ key: r.tx, value: r.cat })));
    const txPm = buildRecentMap(recent.map(r => ({ key: r.tx, value: r.pm })));

    return { status: 'ok', rows, txCat, txPm };
  }

  async function getCashBalance() {
    const res = await SheetsClient.getValues(spreadsheetId, 'Opex!F2:I');
    const rows = res.values || [];
    let balance = 0;
    rows.forEach(([inc, exp, , deleted]) => {
      if (isDeletedFlag(deleted)) return;
      balance += (Number(inc) || 0) - (Number(exp) || 0);
    });
    return balance;
  }

  // ── INVEST ────────────────────────────────────────────────────
  async function findInvestRowById(id) {
    if (!id) return null;
    const res = await SheetsClient.getValues(spreadsheetId, 'Invest!I2:I');
    const ids = res.values || [];
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() === String(id).trim()) return i + 2;
    }
    return null;
  }

  async function deleteOpexRowById(opexId) {
    const rowIndex = await findOpexRowById(opexId);
    if (!rowIndex) return;
    await SheetsClient.batchUpdate(spreadsheetId, [{
      deleteDimension: {
        range: { sheetId: opexGid, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
      },
    }]);
  }

  async function handleInvest(data) {
    // `op` selects edit/delete; `action` always means Buy/Sell (never overloaded
    // with 'edit'/'delete' the way Opex's `action` field is, since Invest already
    // uses `action` for its own Buy/Sell domain value).
    const { op, action, date, month, stock, stockType, account, lot, price, totalIdr, pm } = data;

    if (op === 'edit') {
      const rowIndex = await findInvestRowById(data.id);
      if (!rowIndex) return { status: 'error', message: 'Row not found' };
      const linkRes = await SheetsClient.getValues(spreadsheetId, `Invest!J${rowIndex}`);
      const existingOpexId = String((linkRes.values && linkRes.values[0] && linkRes.values[0][0]) || '').trim();

      await SheetsClient.updateValues(spreadsheetId, `Invest!A${rowIndex}:H${rowIndex}`, [[
        formatDateStr(date), stock, stockType, action, account || '', lot, price, totalIdr,
      ]]);

      let newOpexId = existingOpexId;
      const newActionIsBuy = action === 'Buy';
      if (existingOpexId && newActionIsBuy) {
        const opexRow = await findOpexRowById(existingOpexId);
        if (opexRow) {
          const monthKey = month || deriveMonthKey(date);
          const payMethod = account || pm || 'BCA';
          await SheetsClient.updateValues(spreadsheetId, `Opex!A${opexRow}:J${opexRow}`, [[
            formatDateStr(date), monthKey, 'Investment', stock, payMethod, '', Number(totalIdr), '', '', 0,
          ]]);
        }
      } else if (existingOpexId && !newActionIsBuy) {
        await deleteOpexRowById(existingOpexId);
        newOpexId = '';
      } else if (!existingOpexId && newActionIsBuy) {
        const monthKey = month || deriveMonthKey(date);
        const payMethod = account || pm || 'BCA';
        newOpexId = await writeToOpex(date, monthKey, 'Investment', stock, payMethod, 'expense', totalIdr, '');
      }
      if (newOpexId !== existingOpexId) {
        await SheetsClient.updateValues(spreadsheetId, `Invest!J${rowIndex}`, [[newOpexId]]);
      }
      return { status: 'ok' };
    }

    if (op === 'delete') {
      const rowIndex = await findInvestRowById(data.id);
      if (!rowIndex) return { status: 'error', message: 'Row not found' };
      const linkRes = await SheetsClient.getValues(spreadsheetId, `Invest!J${rowIndex}`);
      const existingOpexId = String((linkRes.values && linkRes.values[0] && linkRes.values[0][0]) || '').trim();
      if (existingOpexId) await deleteOpexRowById(existingOpexId);
      await SheetsClient.batchUpdate(spreadsheetId, [{
        deleteDimension: {
          range: { sheetId: investGid, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
        },
      }]);
      return { status: 'ok' };
    }

    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    let opexId = '';
    if (action === 'Buy') {
      const monthKey = month || deriveMonthKey(date);
      const payMethod = account || pm || 'BCA';
      opexId = await writeToOpex(date, monthKey, 'Investment', stock, payMethod, 'expense', totalIdr, '');
    }
    await SheetsClient.appendValues(spreadsheetId, 'Invest!A:J', [[
      formatDateStr(date), stock, stockType, action, account || '', lot, price, totalIdr, id, opexId,
    ]]);
    return { status: 'ok', wrote: true, id };
  }

  async function handleGetInvest(since) {
    const res = await SheetsClient.getValues(spreadsheetId, 'Invest!A2:J');
    const data = res.values || [];
    const rows = [];
    data.forEach((row, idx) => {
      const stock = String(row[1] || '').trim();
      const action = String(row[3] || '').trim();
      if (!stock || (action !== 'Buy' && action !== 'Sell')) return;
      const dateStr = cellToDateStr(row[0]);
      if (!dateStr) return;
      const isoDate = parseAnyDateToISO(dateStr);
      // Only exclude when the date parsed cleanly AND is before the cutoff — an
      // unparseable date must never silently drop a real transaction.
      if (isoDate && isoDate < since) return;
      const r = {
        date: isoDate || dateStr, stock, action,
        account: String(row[4] || '').trim(),
        lot: Number(row[5]) || 0, price: Number(row[6]) || 0, totalIdr: Number(row[7]) || 0,
        rowIndex: idx + 2,
      };
      if (row[8]) r.id = String(row[8]).trim();
      if (row[9]) r.opexTxId = String(row[9]).trim();
      rows.push(r);
    });

    // Smart-autofill map for the Invest form's Account field: what Account was used
    // for a given Asset (stock) in the last 30 days, most-recent-first — independent
    // of `since`, which is only used to bound how much history the caller wants back.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const recent = rows
      .filter(r => new Date(r.date) >= cutoff)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    const txAccount = buildRecentMap(recent.map(r => ({ key: r.stock, value: r.account })));

    return { status: 'ok', rows, txAccount };
  }

  // ── PRICES ────────────────────────────────────────────────────
  async function handleGetPrices() {
    const res = await SheetsClient.getValues(spreadsheetId, `${STOCK_PRICES_SHEET}!A2:B8`);
    const range = res.values || [];
    const labelMap = {
      'AAPL': 'AAPL', 'JNJ': 'JNJ', 'VYM': 'VYM', 'QQQ': 'QQQ',
      'CHF IDR': 'CHFIDR', 'USD IDR': 'USDIDR', 'Star Stable': 'StarStable',
    };
    const prices = {};
    range.forEach(([label, price]) => {
      if (!label) return;
      const key = labelMap[String(label).trim()];
      if (key && price) {
        const num = parseFloat(String(price).replace(/[$Rp,\s]/g, ''));
        if (!isNaN(num)) prices[key] = num;
      }
    });
    const cashBalance = await getCashBalance();
    return { status: 'ok', prices, cashBalance, ts: new Date().toISOString() };
  }

  // ── GOALS (Goals!A2:G) ─────────────────────────────────────────
  async function handleGetGoals() {
    const res = await SheetsClient.getValues(spreadsheetId, `${GOALS_SHEET}!A${GOALS_START_ROW}:G`);
    const data = res.values || [];
    const goals = [];
    data.forEach((row, idx) => {
      const name = String(row[0] || '').trim();
      if (!name) return;
      goals.push({
        rowNum: GOALS_START_ROW + idx,
        name,
        startDate: cellToDateStr(row[1]),
        endDate: cellToDateStr(row[2]),
        targetAmount: Number(row[3]) || 0,
        sources: row[4] ? String(row[4]).split(',').map(s => s.trim()).filter(Boolean) : [],
        completed: String(row[5] || '').toLowerCase() === 'true',
        completedDate: cellToDateStr(row[6]) || null,
      });
    });
    return { status: 'ok', goals };
  }

  async function findNextGoalRow() {
    const res = await SheetsClient.getValues(spreadsheetId, `${GOALS_SHEET}!A${GOALS_START_ROW}:A`);
    const col = res.values || [];
    let lastFilledOffset = -1;
    col.forEach((row, i) => { if (String(row[0] || '').trim()) lastFilledOffset = i; });
    return GOALS_START_ROW + lastFilledOffset + 1;
  }

  async function handleGoals(data) {
    const { action, rowNum, name, startDate, endDate, targetAmount, sources, completed, completedDate } = data;
    if (action === 'delete') {
      if (!rowNum || rowNum < GOALS_START_ROW) return { status: 'error', message: 'Invalid rowNum' };
      await SheetsClient.clearValues(spreadsheetId, `${GOALS_SHEET}!A${rowNum}:G${rowNum}`);
      return { status: 'ok' };
    }
    const sourcesStr = Array.isArray(sources) ? sources.join(', ') : (sources || '');
    const rowData = [
      name || '', startDate || '', endDate || '', Number(targetAmount) || 0,
      sourcesStr, completed ? 'TRUE' : 'FALSE', completedDate || '',
    ];
    const targetRow = rowNum || await findNextGoalRow();
    await SheetsClient.updateValues(spreadsheetId, `${GOALS_SHEET}!A${targetRow}:G${targetRow}`, [rowData]);
    return { status: 'ok', rowNum: targetRow };
  }

  // ── RECURRING (Recurring!A2:L) ─────────────────────────────────
  async function handleGetRecurring() {
    const res = await SheetsClient.getValues(spreadsheetId, `${RECURRING_SHEET}!A${RECURRING_DATA_ROW}:L`);
    const data = res.values || [];
    const rules = [];
    data.forEach(row => {
      const id = Number(row[0]);
      if (!id) return;
      if (isDeletedFlag(row[10])) return;
      const endMonthVal = String(row[11] || '').trim();
      rules.push({
        id, type: String(row[1] || '').trim(), tx: String(row[2] || '').trim(), cat: String(row[3] || '').trim(),
        amount: Number(row[4]) || 0, pm: String(row[5] || '').trim(), notes: String(row[6] || '').trim(),
        dayOfMonth: Number(row[7]) || 1, active: String(row[8] || '').trim().toLowerCase() === 'true',
        lastFired: String(row[9] || '').trim(),
        endMonth: /^\d{4}-(0[1-9]|1[0-2])$/.test(endMonthVal) ? endMonthVal : null,
      });
    });
    return { status: 'ok', rules };
  }

  async function handleRecurring(data) {
    const { action, rules } = data;
    if (action !== 'saveAll') return { status: 'error', message: 'Unknown action' };
    if (!Array.isArray(rules)) return { status: 'error', message: 'rules must be an array' };

    const header = await SheetsClient.getValues(spreadsheetId, `${RECURRING_SHEET}!A1:L1`);
    if (!(header.values && header.values[0] && header.values[0][0])) {
      await SheetsClient.updateValues(spreadsheetId, `${RECURRING_SHEET}!A1:L1`, [[
        'id','type','tx','cat','amount','pm','notes','dayOfMonth','active','lastFired','_deleted','endMonth',
      ]]);
    }

    await SheetsClient.clearValues(spreadsheetId, `${RECURRING_SHEET}!A${RECURRING_DATA_ROW}:L`);
    if (rules.length === 0) return { status: 'ok', count: 0 };

    const rows = rules.map(r => [
      Number(r.id) || 0, String(r.type || '').slice(0, 20), String(r.tx || '').slice(0, 100),
      String(r.cat || '').slice(0, 50), Number(r.amount) || 0, String(r.pm || '').slice(0, 30),
      String(r.notes || '').slice(0, 500), Number(r.dayOfMonth) || 1, r.active ? 'TRUE' : 'FALSE',
      String(r.lastFired || '').slice(0, 7), '', String(r.endMonth || '').slice(0, 7),
    ]);
    await SheetsClient.updateValues(spreadsheetId, `${RECURRING_SHEET}!A${RECURRING_DATA_ROW}:L${RECURRING_DATA_ROW + rows.length - 1}`, rows);
    return { status: 'ok', count: rows.length };
  }

  // ── CONFIG (Categories / PMs / Assets / Accounts — "Config" tab) ──
  async function ensureConfigSheetExists() {
    const meta = await SheetsClient.getSpreadsheetMeta(spreadsheetId);
    const exists = (meta.sheets || []).some(s => s.properties.title === CONFIG_SHEET);
    if (!exists) {
      await SheetsClient.batchUpdate(spreadsheetId, [{ addSheet: { properties: { title: CONFIG_SHEET } } }]);
    }
    await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A1:J1`, [[
      'kind', 'name', 'color', 'ccy', 'assetType', 'archived', 'sortOrder', 'linkedPM', 'balance', 'balanceDate',
    ]]);
    return !exists;
  }

  async function handleGetConfig() {
    const justCreated = await ensureConfigSheetExists();
    if (justCreated) {
      const rows = CONFIG_DEFAULTS.map(it => [
        it.kind, it.name, it.color, it.ccy, it.assetType, it.archived ? 'TRUE' : 'FALSE', it.sortOrder, it.linkedPM || '',
        (it.balance !== null && it.balance !== undefined && String(it.balance).trim() !== '') ? Number(it.balance) : '',
        String(it.balanceDate || '').slice(0, 10),
      ]);
      await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:J${CONFIG_DATA_ROW + rows.length - 1}`, rows);
      return { status: 'ok', items: CONFIG_DEFAULTS };
    }
    const res = await SheetsClient.getValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:J`);
    const rows = res.values || [];
    if (rows.length === 0) {
      // Header exists but no data rows — seed now.
      const seedRows = CONFIG_DEFAULTS.map(it => [
        it.kind, it.name, it.color, it.ccy, it.assetType, it.archived ? 'TRUE' : 'FALSE', it.sortOrder, it.linkedPM || '',
        (it.balance !== null && it.balance !== undefined && String(it.balance).trim() !== '') ? Number(it.balance) : '',
        String(it.balanceDate || '').slice(0, 10),
      ]);
      await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:J${CONFIG_DATA_ROW + seedRows.length - 1}`, seedRows);
      return { status: 'ok', items: CONFIG_DEFAULTS };
    }
    const items = rows
      .filter(r => r[1])
      .map((r, idx) => {
        let balVal = null;
        if (r[8] !== undefined && r[8] !== null && String(r[8]).trim() !== '') {
          const rawNum = Number(String(r[8]).replace(/[^0-9.-]/g, ''));
          if (!isNaN(rawNum)) balVal = rawNum;
        }
        return {
          kind: String(r[0] || '').trim(),
          name: String(r[1] || '').trim(),
          color: String(r[2] || '').trim(),
          ccy: String(r[3] || '').trim(),
          assetType: String(r[4] || '').trim(),
          archived: String(r[5] || '').trim().toUpperCase() === 'TRUE',
          sortOrder: Number(r[6]) || idx,
          linkedPM: String(r[7] || '').trim(),
          balance: balVal,
          balanceDate: String(r[9] || '').trim(),
        };
      })
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return { status: 'ok', items };
  }

  async function handleConfig(data) {
    const { action, items } = data;
    if (action !== 'saveAll') return { status: 'error', message: 'Unknown action' };
    if (!Array.isArray(items)) return { status: 'error', message: 'items must be an array' };
    await ensureConfigSheetExists();
    await SheetsClient.clearValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:J`);
    if (items.length === 0) return { status: 'ok', count: 0 };
    const rows = items.map((it, idx) => [
      String(it.kind || '').slice(0, 20),
      String(it.name || '').slice(0, 100),
      String(it.color || '').slice(0, 20),
      String(it.ccy || '').slice(0, 10),
      String(it.assetType || '').slice(0, 20),
      it.archived ? 'TRUE' : 'FALSE',
      Number.isFinite(it.sortOrder) ? it.sortOrder : idx,
      String(it.linkedPM || '').slice(0, 50),
      (it.balance !== null && it.balance !== undefined && String(it.balance).trim() !== '') ? Number(it.balance) : '',
      String(it.balanceDate || '').slice(0, 10),
    ]);
    await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:J${CONFIG_DATA_ROW + rows.length - 1}`, rows);
    return { status: 'ok', count: rows.length };
  }

  // ── BALANCES (Balances!A2:D) ────────────────────────────────────
  async function handleGetBalances() {
    const res = await SheetsClient.getValues(spreadsheetId, `${BALANCES_SHEET}!A2:D`);
    const rows = res.values || [];
    const latestByAccount = {};
    rows.forEach(row => {
      const account = String(row[0] || '').trim();
      const date    = String(row[1] || '').trim();
      const amount  = Number(row[2]) || 0;
      const txId    = String(row[3] || '').trim();
      if (!account || !date) return;
      const existing = latestByAccount[account];
      if (!existing || date > existing.date) {
        latestByAccount[account] = { date, amount, txId };
      }
    });
    return { status: 'ok', balances: latestByAccount };
  }

  async function handleSaveBalance(data) {
    const { account, date, amount, txId } = data;
    if (!account || !date) return { status: 'error', message: 'account and date required' };
    await SheetsClient.appendValues(spreadsheetId, `${BALANCES_SHEET}!A:D`, [[
      String(account).slice(0, 100),
      String(date).slice(0, 10),
      Number(amount) || 0,
      String(txId || '').slice(0, 50),
    ]]);

    // Update Column I & J in Config sheet for matching account
    try {
      await ensureConfigSheetExists();
      const configRes = await SheetsClient.getValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:J`);
      const configRows = configRes.values || [];
      let found = false;
      for (let i = 0; i < configRows.length; i++) {
        const row = configRows[i];
        if (String(row[0] || '').trim() === 'account' && String(row[1] || '').trim().toLowerCase() === String(account).trim().toLowerCase()) {
          while (row.length < 10) row.push('');
          row[8] = Number(amount) || 0;
          row[9] = String(date).slice(0, 10);
          const rowNum = CONFIG_DATA_ROW + i;
          await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A${rowNum}:J${rowNum}`, [row]);
          found = true;
          break;
        }
      }
      if (!found) {
        const newRow = ['account', String(account).trim(), '', '', '', 'FALSE', configRows.length, '', Number(amount) || 0, String(date).slice(0, 10)];
        await SheetsClient.appendValues(spreadsheetId, `${CONFIG_SHEET}!A:J`, [newRow]);
      }
    } catch (e) {
      console.warn('[handleSaveBalance] Could not update Config sheet columns I/J:', e);
    }

    return { status: 'ok' };
  }

  // ── REQUEST ROUTER (mirrors the old doGet/doPost dispatch) ───
  async function handleRequest(urlStr, opts) {
    await requireReady();
    const url = new URL(urlStr);
    const method = (opts && opts.method) || 'GET';

    if (method === 'GET') {
      const type = url.searchParams.get('type');
      if (type === 'prices') return handleGetPrices();
      if (type === 'month') return handleGetMonth(url.searchParams.get('y'), url.searchParams.get('m'));
      if (type === 'allOpex') return handleGetAllOpex();
      if (type === 'invest') return handleGetInvest(url.searchParams.get('since') || '2020-01-01');
      if (type === 'goals') return handleGetGoals();
      if (type === 'recurring') return handleGetRecurring();
      if (type === 'config') return handleGetConfig();
      if (type === 'balances') return handleGetBalances();
      return { status: 'error', message: 'Unknown type' };
    }

    const data = JSON.parse(opts.body);
    if (data.type === 'opex') return handleOpex(data);
    if (data.type === 'invest') return handleInvest(data);
    if (data.type === 'goals') return handleGoals(data);
    if (data.type === 'recurring') return handleRecurring(data);
    if (data.type === 'config') return handleConfig(data);
    if (data.type === 'balances') return handleSaveBalance(data);
    if (data.type === 'transfer') return handleTransfer(data);
    return { status: 'error', message: 'Unknown type' };
  }

  function getSpreadsheetId() { return spreadsheetId; }

  return { bootstrap, handleRequest, getSpreadsheetId, installLivePriceFormulas };
})();
