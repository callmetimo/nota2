// Nota — data layer that replaces Nota's Apps Script backend.
// Same JSON shapes as the old ?type=... API, but reads/writes go straight
// to a Google Sheet the app created in the signed-in user's own Drive
// (via SheetsClient), scoped by drive.file so nothing else in their
// account is touched.

const DataStore = (() => {
  const LS_SS_ID = 'notaPublic_spreadsheetId';
  const LS_OPEX_GID = 'notaPublic_opexSheetId';
  const LS_INVEST_GID = 'notaPublic_investSheetId';

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const GOAL_COL_LETTER_START = 'J'; // J:P (7 cols)
  const GOALS_START_ROW = 15;
  const RECURRING_RANGE = 'R:AC'; // 12 cols
  const RECURRING_DATA_ROW = 2;

  let spreadsheetId = localStorage.getItem(LS_SS_ID) || null;
  let opexGid = localStorage.getItem(LS_OPEX_GID) ? Number(localStorage.getItem(LS_OPEX_GID)) : null;

  // ── BOOTSTRAP ────────────────────────────────────────────────
  async function bootstrap() {
    if (spreadsheetId) return; // already set up on this browser

    const created = await SheetsClient.create({
      properties: { title: 'Nota Data' },
      sheets: [
        { properties: { title: 'Opex', sheetId: 0 } },
        { properties: { title: 'Invest', sheetId: 1 } },
      ],
    });
    spreadsheetId = created.spreadsheetId;
    opexGid = created.sheets.find(s => s.properties.title === 'Opex').properties.sheetId;
    const investGid = created.sheets.find(s => s.properties.title === 'Invest').properties.sheetId;

    localStorage.setItem(LS_SS_ID, spreadsheetId);
    localStorage.setItem(LS_OPEX_GID, String(opexGid));
    localStorage.setItem(LS_INVEST_GID, String(investGid));

    await SheetsClient.updateValues(spreadsheetId, 'Opex!A1:K1', [[
      'Date','Month','Category','Transaction','PM','Income','Expense','Notes','Deleted','Future','TxID',
    ]]);
    await SheetsClient.updateValues(spreadsheetId, 'Invest!A1:H1', [[
      'Date','Stock','Type','Action','Account','Lot','Price','TotalIdr',
    ]]);
    await SheetsClient.updateValues(spreadsheetId, 'Invest!J1:K7', [
      ['AAPL',''], ['JNJ',''], ['VYM',''], ['QQQ',''], ['CHF IDR',''], ['USD IDR',''], ['Star Stable',''],
    ]);
    await SheetsClient.batchUpdate(spreadsheetId, [{
      repeatCell: {
        range: { sheetId: opexGid, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'MMM yyyy' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    }]);
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
  async function handleInvest(data) {
    const { date, month, stock, stockType, action, account, lot, price, totalIdr, pm } = data;
    await SheetsClient.appendValues(spreadsheetId, 'Invest!A:H', [[
      formatDateStr(date), stock, stockType, action, account || '', lot, price, totalIdr,
    ]]);
    if (action === 'Buy') {
      const monthKey = month || deriveMonthKey(date);
      const payMethod = account || pm || 'BCA';
      await writeToOpex(date, monthKey, 'Investment', stock, payMethod, 'expense', totalIdr, '');
    }
    return { status: 'ok', wrote: true };
  }

  async function handleGetInvest(since) {
    const res = await SheetsClient.getValues(spreadsheetId, 'Invest!A2:H');
    const data = res.values || [];
    const rows = [];
    data.forEach(row => {
      const stock = String(row[1] || '').trim();
      const action = String(row[3] || '').trim();
      if (!stock || (action !== 'Buy' && action !== 'Sell')) return;
      const dateStr = cellToDateStr(row[0]);
      if (!dateStr || dateStr < since) return;
      rows.push({
        date: dateStr, stock, action,
        account: String(row[4] || '').trim(),
        lot: Number(row[5]) || 0, price: Number(row[6]) || 0, totalIdr: Number(row[7]) || 0,
      });
    });
    return { status: 'ok', rows };
  }

  // ── PRICES ────────────────────────────────────────────────────
  async function handleGetPrices() {
    const res = await SheetsClient.getValues(spreadsheetId, 'Invest!J1:K7');
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

  // ── GOALS (Invest!J15:P) ──────────────────────────────────────
  async function handleGetGoals() {
    const res = await SheetsClient.getValues(spreadsheetId, `Invest!J${GOALS_START_ROW}:P`);
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
    const res = await SheetsClient.getValues(spreadsheetId, `Invest!J${GOALS_START_ROW}:J`);
    const col = res.values || [];
    let lastFilledOffset = -1;
    col.forEach((row, i) => { if (String(row[0] || '').trim()) lastFilledOffset = i; });
    return GOALS_START_ROW + lastFilledOffset + 1;
  }

  async function handleGoals(data) {
    const { action, rowNum, name, startDate, endDate, targetAmount, sources, completed, completedDate } = data;
    if (action === 'delete') {
      if (!rowNum || rowNum < GOALS_START_ROW) return { status: 'error', message: 'Invalid rowNum' };
      await SheetsClient.clearValues(spreadsheetId, `Invest!J${rowNum}:P${rowNum}`);
      return { status: 'ok' };
    }
    const sourcesStr = Array.isArray(sources) ? sources.join(', ') : (sources || '');
    const rowData = [
      name || '', startDate || '', endDate || '', Number(targetAmount) || 0,
      sourcesStr, completed ? 'TRUE' : 'FALSE', completedDate || '',
    ];
    const targetRow = rowNum || await findNextGoalRow();
    await SheetsClient.updateValues(spreadsheetId, `Invest!J${targetRow}:P${targetRow}`, [rowData]);
    return { status: 'ok', rowNum: targetRow };
  }

  // ── RECURRING (Invest!R:AC) ───────────────────────────────────
  async function handleGetRecurring() {
    const res = await SheetsClient.getValues(spreadsheetId, `Invest!R${RECURRING_DATA_ROW}:AC`);
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

    const header = await SheetsClient.getValues(spreadsheetId, 'Invest!R1:AC1');
    if (!(header.values && header.values[0] && header.values[0][0])) {
      await SheetsClient.updateValues(spreadsheetId, 'Invest!R1:AC1', [[
        'id','type','tx','cat','amount','pm','notes','dayOfMonth','active','lastFired','_deleted','endMonth',
      ]]);
    }

    await SheetsClient.clearValues(spreadsheetId, `Invest!R${RECURRING_DATA_ROW}:AC`);
    if (rules.length === 0) return { status: 'ok', count: 0 };

    const rows = rules.map(r => [
      Number(r.id) || 0, String(r.type || '').slice(0, 20), String(r.tx || '').slice(0, 100),
      String(r.cat || '').slice(0, 50), Number(r.amount) || 0, String(r.pm || '').slice(0, 30),
      String(r.notes || '').slice(0, 500), Number(r.dayOfMonth) || 1, r.active ? 'TRUE' : 'FALSE',
      String(r.lastFired || '').slice(0, 7), '', String(r.endMonth || '').slice(0, 7),
    ]);
    await SheetsClient.updateValues(spreadsheetId, `Invest!R${RECURRING_DATA_ROW}:AC${RECURRING_DATA_ROW + rows.length - 1}`, rows);
    return { status: 'ok', count: rows.length };
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
      if (type === 'invest') return handleGetInvest(url.searchParams.get('since') || '2020-01-01');
      if (type === 'goals') return handleGetGoals();
      if (type === 'recurring') return handleGetRecurring();
      return { status: 'error', message: 'Unknown type' };
    }

    const data = JSON.parse(opts.body);
    if (data.type === 'opex') return handleOpex(data);
    if (data.type === 'invest') return handleInvest(data);
    if (data.type === 'goals') return handleGoals(data);
    if (data.type === 'recurring') return handleRecurring(data);
    return { status: 'error', message: 'Unknown type' };
  }

  return { bootstrap, handleRequest };
})();
