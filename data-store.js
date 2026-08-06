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
  const LS_DATE_FORMAT_MIGRATED = 'notaPublic_dateFormatMigratedV1';

  // crypto.randomUUID is available in all modern browsers (Chrome 92+, Safari 15.4+, Firefox 95+).
  // Centralised here so the guard/fallback doesn't have to be repeated at every call site.
  function generateId() { return crypto.randomUUID(); }

  async function fetchAndCacheSheetGids(ssId) {
    const meta = await SheetsClient.getSpreadsheetMeta(ssId);
    const sheets = meta.sheets || [];
    opexGid = sheets.find(s => s.properties.title === 'Opex')?.properties.sheetId ?? null;
    investGid = sheets.find(s => s.properties.title === 'Invest')?.properties.sheetId ?? null;
    if (opexGid != null) localStorage.setItem(LS_OPEX_GID, String(opexGid));
    if (investGid != null) localStorage.setItem(LS_INVEST_GID, String(investGid));
    return meta;
  }

  // Session 29 audit: every date this app writes is auto-detected by Sheets as a real date
  // cell and rendered back (FORMATTED_VALUE) according to the *spreadsheet's own locale* —
  // which is how the Session 28 bug happened (Invest!A dates came back MM/DD/YYYY instead of
  // this app's usual DD/MM/YYYY). Pinning an explicit locale-independent numberFormat on every
  // date column is the durable fix; parseAnyDateToISO()/parseDateInfo() then always see a
  // consistent 'yyyy-mm-dd' string regardless of the underlying spreadsheet's locale.
  // One-time per browser (like LS_SPLIT_MIGRATED) — safe to re-run, just wasted API calls.
  async function ensureDateColumnFormats(meta) {
    if (localStorage.getItem(LS_DATE_FORMAT_MIGRATED)) return;
    try {
      const sheets = (meta && meta.sheets) || (await SheetsClient.getSpreadsheetMeta(spreadsheetId)).sheets || [];
      const gidOf = (title) => sheets.find(s => s.properties.title === title)?.properties.sheetId;
      const configGid = gidOf(CONFIG_SHEET);
      const goalsGid = gidOf(GOALS_SHEET);
      const recurringGid = gidOf(RECURRING_SHEET);

      const requests = [];
      const addCol = (sheetId, colIndex) => {
        if (sheetId == null) return;
        requests.push({
          repeatCell: {
            range: { sheetId, startColumnIndex: colIndex, endColumnIndex: colIndex + 1 },
            cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        });
      };
      addCol(opexGid, 0);       // Opex!A Date
      addCol(investGid, 0);     // Invest!A Date
      addCol(configGid, 9);     // Config!J balanceDate
      addCol(goalsGid, 1);      // Goals!B StartDate
      addCol(goalsGid, 2);      // Goals!C EndDate
      addCol(goalsGid, 6);      // Goals!G CompletedDate
      addCol(recurringGid, 9);  // Recurring!J lastFired
      addCol(recurringGid, 11); // Recurring!L endMonth

      if (requests.length) await SheetsClient.batchUpdate(spreadsheetId, requests);
      localStorage.setItem(LS_DATE_FORMAT_MIGRATED, '1');
    } catch (e) {
      console.warn('[bootstrap] ensureDateColumnFormats error:', e);
    }
  }

  function serializeConfigRow(it, idx) {
    return [
      String(it.kind || '').slice(0, 20),
      String(it.name || '').slice(0, 100),
      String(it.color || '').slice(0, 20),
      String(it.ccy || '').slice(0, 10),
      String(it.assetType || '').slice(0, 50),
      it.archived ? 'TRUE' : 'FALSE',
      Number.isFinite(it.sortOrder) ? it.sortOrder : idx,
      String(it.linkedPM || '').slice(0, 50),
      (it.balance !== null && it.balance !== undefined && String(it.balance).trim() !== '') ? Number(it.balance) : '',
      String(it.balanceDate || '').slice(0, 10),
      it.showOnInsights === false ? 'FALSE' : 'TRUE',
      it.creditCard ? 'TRUE' : 'FALSE',
      Number(it.billingDate) || '',
      Number(it.creditLimit) || '',
    ];
  }

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const STOCK_PRICES_SHEET = 'Stock Prices';
  const GOALS_SHEET = 'Goals';
  const RECURRING_SHEET = 'Recurring';
  const GOALS_START_ROW = 2;     // Goals sheet: header row 1, data from row 2
  const RECURRING_DATA_ROW = 2;  // Recurring sheet: header row 1, data from row 2
  const OLD_GOALS_START_ROW = 15; // pre-split location, used only during migration
  const CONFIG_SHEET = 'Config';
  const CONFIG_DATA_ROW = 2;
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
      .map((name, i) => ({ kind: 'account', name, color: '', ccy: ACCOUNT_CCY_DEFAULTS[name] || '', assetType: '', showOnInsights: true, archived: false, sortOrder: i })),
  ];

  let spreadsheetId = localStorage.getItem(LS_SS_ID) || null;
  let opexGid = localStorage.getItem(LS_OPEX_GID) ? Number(localStorage.getItem(LS_OPEX_GID)) : null;
  let investGid = localStorage.getItem(LS_INVEST_GID) ? Number(localStorage.getItem(LS_INVEST_GID)) : null;

  // ── BOOTSTRAP ────────────────────────────────────────────────
  // Finds a spreadsheet in Google Drive for the signed-in user that contains Nota data.
  // Checks all accessible spreadsheets and selects the one with the most transactions in Opex.
  async function findExistingSpreadsheet() {
    try {
      const res = await SheetsClient.findFiles(
        "trashed=false and mimeType='application/vnd.google-apps.spreadsheet'"
      );
      const files = (res.files || []).filter(f => !f.trashed);
      if (!files.length) return null;

      let bestFile = null;
      let maxOpexRows = -1;

      for (const file of files) {
        try {
          const meta = await SheetsClient.getSpreadsheetMeta(file.id);
          const opexSheet = (meta.sheets || []).find(s => s.properties.title === 'Opex');
          if (opexSheet) {
            const vals = await SheetsClient.getValues(file.id, 'Opex!A2:A100');
            const dataRows = (vals.values || []).filter(r => r && r[0] && String(r[0]).trim() !== '');
            if (dataRows.length > maxOpexRows) {
              maxOpexRows = dataRows.length;
              bestFile = file;
            }
          }
        } catch (e) {
          console.warn('[findExistingSpreadsheet] Error inspecting file', file.id, e);
        }
      }

      if (bestFile && maxOpexRows > 0) return bestFile;

      const notaDataFiles = files.filter(f => f.name === 'Nota Data');
      if (notaDataFiles.length) {
        notaDataFiles.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
        return notaDataFiles[0];
      }

      files.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
      return files[0];
    } catch (e) {
      console.warn('[findExistingSpreadsheet] search failed', e);
      return null;
    }
  }

  async function bootstrap() {
    if (spreadsheetId) {
      // If cached spreadsheet has 0 data rows in Opex, check if another sheet has data
      try {
        const vals = await SheetsClient.getValues(spreadsheetId, 'Opex!A2:A10');
        const dataRows = (vals.values || []).filter(r => r && r[0] && String(r[0]).trim() !== '');
        if (dataRows.length === 0) {
          const better = await findExistingSpreadsheet();
          if (better && better.id !== spreadsheetId) {
            console.log('[bootstrap] Switching from empty cached sheet to sheet with data:', better.id);
            spreadsheetId = better.id;
            localStorage.setItem(LS_SS_ID, spreadsheetId);
            await fetchAndCacheSheetGids(spreadsheetId);
          }
        }
      } catch (e) {
        console.warn('[bootstrap] Error checking cached spreadsheet:', e);
      }

      if (!localStorage.getItem(LS_SPLIT_MIGRATED)) {
        try {
          const meta = await SheetsClient.getSpreadsheetMeta(spreadsheetId);
          await migrateToSplitSheets(meta);
          localStorage.setItem(LS_SPLIT_MIGRATED, '1');
        } catch (e) {
          console.warn('[bootstrap] Migration error:', e);
        }
      }
      if (!localStorage.getItem(LS_DATE_FORMAT_MIGRATED)) {
        await ensureDateColumnFormats();
      }
      return;
    }

    const existing = await findExistingSpreadsheet();
    if (existing) {
      spreadsheetId = existing.id;
      localStorage.setItem(LS_SS_ID, spreadsheetId);
      const meta = await fetchAndCacheSheetGids(spreadsheetId);
      if (investGid != null) localStorage.setItem(LS_INVEST_GID, String(investGid));
      await migrateToSplitSheets(meta);
      localStorage.setItem(LS_SPLIT_MIGRATED, '1');
      // Note: fetch fresh meta rather than reusing `meta` above — migrateToSplitSheets may have
      // just created the Goals/Recurring sheets, so the pre-migration meta wouldn't have their gids.
      await ensureDateColumnFormats();
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
    await SheetsClient.updateValues(spreadsheetId, `${GOALS_SHEET}!A1:I1`, [[
      'Name','StartDate','EndDate','TargetAmt','Sources','Completed','CompletedDate','id','Ccy',
    ]]);
    await SheetsClient.updateValues(spreadsheetId, `${RECURRING_SHEET}!A1:L1`, [[
      'id','type','tx','cat','amount','pm','notes','dayOfMonth','active','lastFired','_deleted','endMonth',
    ]]);
    await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A1:L1`, [[
      'kind', 'name', 'color', 'ccy', 'assetType', 'archived', 'sortOrder', 'linkedPM', 'balance', 'balanceDate', 'showOnInsights', 'creditCard',
    ]]);
    const configRows = CONFIG_DEFAULTS.map((it, idx) => serializeConfigRow(it, idx));
    await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:L${CONFIG_DATA_ROW + configRows.length - 1}`, configRows);
    await SheetsClient.batchUpdate(spreadsheetId, [{
      repeatCell: {
        range: { sheetId: opexGid, startColumnIndex: 1, endColumnIndex: 2 },
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'MMM yyyy' } } },
        fields: 'userEnteredFormat.numberFormat',
      },
    }]);
    await ensureDateColumnFormats({ sheets: created.sheets });
  }

  // ── MIGRATION: split Invest's prices/goals/recurring blocks into their own sheets ──
  // Idempotent and resumable: each block checks whether its destination sheet already
  // has a header before copying, so a migration interrupted partway (tab closed, network
  // drop) just re-attempts whichever blocks didn't finish, next time bootstrap() runs.
  async function migrateToSplitSheets(meta) {
    const titles = (meta.sheets || []).map(s => s.properties.title);
    const missing = [STOCK_PRICES_SHEET, GOALS_SHEET, RECURRING_SHEET].filter(t => !titles.includes(t));
    if (missing.length) {
      await SheetsClient.batchUpdate(spreadsheetId, missing.map(title => ({ addSheet: { properties: { title } } })));
    }
    await migratePricesBlock();
    await migrateGoalsBlock();
    await migrateRecurringBlock();
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
    await SheetsClient.updateValues(spreadsheetId, `${GOALS_SHEET}!A1:I1`, [[
      'Name','StartDate','EndDate','TargetAmt','Sources','Completed','CompletedDate','id','Ccy',
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

  // ── SHARED HELPERS ───────────────────────────────────────────────
  function isDeletedFlag(v) { return String(v).trim().toLowerCase() === 'deleted'; }

  function parseDateInfo(dateVal, monthVal) {
    const dStr = String(dateVal || '').trim();
    const mStr = String(monthVal || '').trim();

    let year = null, month = null, day = null;

    if (dStr) {
      // ISO: "2026-07-25" or "2026/07/25"
      let match = dStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (match) {
        year = parseInt(match[1], 10);
        month = parseInt(match[2], 10);
        day = parseInt(match[3], 10);
      } else {
        // Textual: "25 Jul 26", "25 Jul 2026", "25 July 2026", "25-Jul-2026"
        match = dStr.match(/^(\d{1,2})[\s\/-]+([A-Za-z]{3,9})[\s\/-]+(\d{2,4})/);
        if (match) {
          day = parseInt(match[1], 10);
          const monStr = match[2].slice(0, 3).toLowerCase();
          const mIdx = MONTHS.findIndex(mo => mo.toLowerCase() === monStr);
          if (mIdx >= 0) month = mIdx + 1;
          const yRaw = match[3];
          year = yRaw.length === 2 ? parseInt('20' + yRaw, 10) : parseInt(yRaw, 10);
        } else {
          // Numeric: "25/07/2026", "07/25/2026", "25.07.2026"
          match = dStr.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
          if (match) {
            const p1 = parseInt(match[1], 10);
            const p2 = parseInt(match[2], 10);
            const yRaw = match[3];
            year = yRaw.length === 2 ? parseInt('20' + yRaw, 10) : parseInt(yRaw, 10);
            if (p1 > 12) {
              day = p1;
              month = p2;
            } else if (p2 > 12) {
              month = p1;
              day = p2;
            } else {
              day = p1;
              month = p2;
            }
          } else {
            // Day number only: "25"
            match = dStr.match(/^(\d{1,2})$/);
            if (match) {
              day = parseInt(match[1], 10);
            }
          }
        }
      }
    }

    if ((!month || !year) && mStr) {
      let match = mStr.match(/^([A-Za-z]{3,9})[\s\/-]+(\d{2,4})/);
      if (match) {
        const monStr = match[1].slice(0, 3).toLowerCase();
        const mIdx = MONTHS.findIndex(mo => mo.toLowerCase() === monStr);
        if (mIdx >= 0) month = mIdx + 1;
        const yRaw = match[2];
        year = yRaw.length === 2 ? parseInt('20' + yRaw, 10) : parseInt(yRaw, 10);
      } else {
        match = mStr.match(/^(\d{4})[-/](\d{1,2})/);
        if (match) {
          year = parseInt(match[1], 10);
          month = parseInt(match[2], 10);
        } else {
          match = mStr.match(/^(\d{1,2})[-/](\d{1,2})?[-/]?(\d{2,4})/);
          if (match) {
            month = parseInt(match[1], 10);
            const yRaw = match[3] || match[2];
            if (yRaw) {
              year = yRaw.length === 2 ? parseInt('20' + yRaw, 10) : parseInt(yRaw, 10);
            }
          }
        }
      }
    }

    if (!day || !month || !year || month < 1 || month > 12 || day < 1 || day > 31 || year < 2000 || year > 2100) {
      return null;
    }

    return { year, month, day };
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

  // Sheets API values.get defaults to FORMATTED_VALUE, so a numeric cell can come
  // back as e.g. "1.000.000" (Indonesian-locale dot-grouped) or "1,000" (comma-grouped)
  // instead of a raw number — Number() on either yields NaN. Same parsing already used
  // for Config balances and account Balances; reused here for Goals targetAmount.
  function parseMoneyCell(val, defaultValue = 0) {
    if (val === undefined || val === null || String(val).trim() === '') return defaultValue;
    if (typeof val === 'number') return isNaN(val) ? defaultValue : val;
    let str = String(val).trim().replace(/^(Rp|USD|\$)\s*/i, '');
    if (!str) return defaultValue;
    if (/^\d{1,3}(\.\d{3})+$/.test(str)) str = str.replace(/\./g, '');
    else str = str.replace(/,/g, '');
    const n = Number(str);
    return isNaN(n) ? defaultValue : n;
  }

  // Invest!A has a mix of formats across its history: legacy rows entered as
  // "DD/MM/YYYY" and rows written by this app via formatDateStr() as "DD Mon YY".
  // Comparing either of those directly against an ISO "YYYY-MM-DD" `since` cutoff
  // with plain string `<` is meaningless (e.g. "07/05/2025" < "2000-01-01" is TRUE
  // because '0' < '2' lexically) and was silently dropping most rows from
  // handleGetInvest — normalize to ISO first so the comparison is actually valid.
  function parseAnyDateToISO(val) {
    // Delegates to parseDateInfo() — the same parser already trusted for the entire
    // Opex ledger — instead of maintaining a second, narrower ad-hoc parser. This gives
    // every caller parseDateInfo's wider format coverage (dot/dash separators, 2-digit
    // years, "YYYY/MM/DD") AND its full range validation (day 1-31, month 1-12, year
    // 2000-2100), which the old inline regexes here lacked: an out-of-range value like
    // "13/13/2026" used to silently produce a garbage-but-truthy ISO string with an
    // invalid month, which then sorts, as a string, after every real month — making
    // that row look permanently "in the future" no matter what cutoff is compared
    // against it (this is exactly what happened with the CIMB IDR Invest-date bug).
    // parseDateInfo() already includes the day/month swap heuristic for the ambiguous
    // DD/MM vs MM/DD case, so that fix is preserved here too.
    const parsed = parseDateInfo(val, null);
    if (!parsed) return '';
    return `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
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
    const id = generateId();
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
    if (data.action === 'edit') {
      const rowIndices = await findOpexRowsByTxId(data.id);
      if (rowIndices.length < 2) return { status: 'error', message: 'Transfer rows not found' };
      const { date, month, fromPm, toPm, amount, notes } = data;
      const [rowA, rowB] = [...rowIndices].sort((a, b) => a - b);
      await SheetsClient.updateValues(spreadsheetId, `Opex!A${rowA}:J${rowA}`, [[
        formatDateStr(date), month, 'Transfer', 'Transfer', fromPm, '', amount, notes || '', '', 0,
      ]]);
      await SheetsClient.updateValues(spreadsheetId, `Opex!A${rowB}:J${rowB}`, [[
        formatDateStr(date), month, 'Transfer', 'Transfer', toPm, amount, '', notes || '', '', 0,
      ]]);
      return { status: 'ok' };
    }
    if (data.action === 'delete') {
      const rowIndices = await findOpexRowsByTxId(data.id);
      if (!rowIndices.length) return { status: 'error', message: 'Transfer rows not found' };
      // Sort descending so higher-index rows are deleted first — deleting a lower row
      // first shifts subsequent row numbers, invalidating the remaining indices.
      // All deletes are sent in a single batchUpdate to save one API call per extra row.
      const sorted = [...rowIndices].sort((a, b) => b - a);
      await SheetsClient.batchUpdate(spreadsheetId, sorted.map(rowIndex => ({
        deleteDimension: {
          range: { sheetId: opexGid, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
        },
      })));
      return { status: 'ok' };
    }
    const { date, month, fromPm, toPm, amount, notes } = data;
    const groupId = generateId();
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
    const targetY = Number(y);
    const targetM = Number(m); // 1-12
    const rows = [];
    data.forEach((row, idx) => {
      if (isDeletedFlag(row[8])) return;
      const parsed = parseDateInfo(row[0], row[1]);
      if (!parsed) return;
      if (parsed.year !== targetY || parsed.month !== targetM) return;
      const r = { d: parsed.day, cat: String(row[2] || '').trim(), tx: String(row[3] || '').trim(), pm: String(row[4] || '').trim(), rowIndex: idx + 2 };
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
  async function handleGetAllOpex() {
    const CACHE_KEY = `notapub_opex_cache_${spreadsheetId}`;
    const cachedStr = localStorage.getItem(CACHE_KEY);

    const fetchFresh = async () => {
      try {
        const res = await SheetsClient.getValues(spreadsheetId, 'Opex!A2:K');
        const data = res.values || [];
        const rows = [];
        data.forEach((row, idx) => {
          if (isDeletedFlag(row[8])) return;
          const parsed = parseDateInfo(row[0], row[1]);
          if (!parsed) return;
          const mIdx = parsed.month - 1; // 0-indexed month
          const y = parsed.year;
          const day = parsed.day;
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
        // Transaction name in the last 30 days, most-recent-first
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const recent = rows
          .filter(r => new Date(r.y, r.m, r.d) >= cutoff)
          .sort((a, b) => new Date(b.y, b.m, b.d) - new Date(a.y, a.m, a.d));
        const txCat = buildRecentMap(recent.map(r => ({ key: r.tx, value: r.cat })));
        const txPm = buildRecentMap(recent.map(r => ({ key: r.tx, value: r.pm })));

        const payload = { status: 'ok', rows, txCat, txPm };
        const newStr = JSON.stringify(payload);

        if (cachedStr !== newStr) {
          localStorage.setItem(CACHE_KEY, newStr);
          if (cachedStr) {
            window.dispatchEvent(new CustomEvent('notaOpexUpdated', { detail: payload }));
          }
        }
        window.dispatchEvent(new CustomEvent('notaBackgroundSyncComplete'));
        return payload;
      } catch (e) {
        console.warn('[data-store] Background fetch failed for allOpex', e);
        if (!cachedStr) throw e;
        return JSON.parse(cachedStr);
      }
    };

    if (cachedStr) {
      // Return immediately, update cache in background
      fetchFresh();
      return JSON.parse(cachedStr);
    }
    return await fetchFresh();
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

    const id = generateId();
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
    // Read a generous range, not just the original 7 rows — a hardcoded A2:B8 would
    // silently never even fetch a row a user adds beyond it (e.g. a new "EUR IDR"
    // row placed at row 9). Sheets API cost for the extra empty cells is negligible.
    const res = await SheetsClient.getValues(spreadsheetId, `${STOCK_PRICES_SHEET}!A2:B200`);
    const range = res.values || [];
    // A few legacy labels use a display name that differs from their internal key,
    // kept for backward compatibility with existing sheets/Goals references. Any
    // other label is resolved generically instead of requiring a hardcoded entry:
    // a currency pair shaped like "EUR IDR" or "EURIDR" normalizes to "EURIDR" (so
    // getCcyRate()'s stockPrices[ccy+'IDR'] lookup finds it for ANY currency, not
    // just USD/CHF); anything else passes through using its own trimmed text as the
    // key, so adding a brand-new ticker row also works with no code change.
    const NAMED_KEYS = { 'AAPL': 'AAPL', 'JNJ': 'JNJ', 'VYM': 'VYM', 'QQQ': 'QQQ', 'Star Stable': 'StarStable' };
    const prices = {};
    range.forEach(([label, price]) => {
      if (!label) return;
      const trimmed = String(label).trim();
      let key = NAMED_KEYS[trimmed];
      if (!key) {
        const ccyMatch = trimmed.toUpperCase().match(/^([A-Z]{3})\s*IDR$/);
        key = ccyMatch ? `${ccyMatch[1]}IDR` : trimmed;
      }
      if (key && price) {
        const num = parseFloat(String(price).replace(/[$Rp,\s]/g, ''));
        if (!isNaN(num)) prices[key] = num;
      }
    });
    const cashBalance = await getCashBalance();
    return { status: 'ok', prices, cashBalance, ts: new Date().toISOString() };
  }

  // ── GOALS (Goals!A2:H) ─────────────────────────────────────────
  async function handleGetGoals() {
    const res = await SheetsClient.getValues(spreadsheetId, `${GOALS_SHEET}!A${GOALS_START_ROW}:I`);
    const data = res.values || [];
    const goals = [];
    for (let idx = 0; idx < data.length; idx++) {
      const row = data[idx];
      const name = String(row[0] || '').trim();
      if (!name) continue;
      let id = String(row[7] || '').trim();
      if (!id) {
        // Legacy row with no persisted ID — generate one and write it back so
        // future lookups (edits/deletes) match this row instead of regenerating
        // a different random ID every read and silently appending a duplicate row.
        id = 'g_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const rowNum = GOALS_START_ROW + idx;
        await SheetsClient.updateValues(spreadsheetId, `${GOALS_SHEET}!H${rowNum}`, [[id]]);
      }
      goals.push({
        id,
        rowNum: GOALS_START_ROW + idx,
        name,
        // Session 30: route through parseAnyDateToISO (validated, format-tolerant) instead of
        // the old bare cellToDateStr pass-through — a garbage/reformatted cell now normalizes
        // to a clean ISO date or safely comes back '' instead of silently carrying through
        // whatever Sheets happened to render, the same failure class as the Invest date bug.
        startDate: parseAnyDateToISO(row[1]) || cellToDateStr(row[1]),
        endDate: parseAnyDateToISO(row[2]) || cellToDateStr(row[2]),
        targetAmount: parseMoneyCell(row[3]),
        sources: row[4] ? String(row[4]).split(',').map(s => s.trim()).filter(Boolean) : [],
        completed: String(row[5] || '').toLowerCase() === 'true',
        completedDate: (parseAnyDateToISO(row[6]) || cellToDateStr(row[6])) || null,
        ccy: String(row[8] || '').trim() || 'IDR',
      });
    }
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
    const { action, id, name, startDate, endDate, targetAmount, sources, completed, completedDate, ccy } = data;
    
    // Fetch latest goals to find target row by matching ID
    const { goals } = await handleGetGoals();
    const existing = id ? goals.find(g => g.id === id) : null;

    if (action === 'delete') {
      if (!existing) return { status: 'error', message: 'Goal not found' };
      await SheetsClient.clearValues(spreadsheetId, `${GOALS_SHEET}!A${existing.rowNum}:I${existing.rowNum}`);
      return { status: 'ok' };
    }

    const goalId = id || 'g_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const sourcesStr = Array.isArray(sources) ? sources.join(', ') : (sources || '');
    const rowData = [
      name || '', startDate || '', endDate || '', Number(targetAmount) || 0,
      sourcesStr, completed ? 'TRUE' : 'FALSE', completedDate || '', goalId, ccy || 'IDR'
    ];

    const targetRow = existing ? existing.rowNum : await findNextGoalRow();
    await SheetsClient.updateValues(spreadsheetId, `${GOALS_SHEET}!A${targetRow}:I${targetRow}`, [rowData]);
    return { status: 'ok', id: goalId };
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
        // Same class of risk as the Invest/Config date bug: an unvalidated raw string can
        // get reformatted by Sheets if it's ever auto-detected as a date, and a corrupted
        // value here is worse than a missing one — it can (a) make an already-fired rule
        // look never-fired, re-prompting a transaction the user already recorded, and
        // (b) via the raw cross-format `>` compare against a clean local "YYYY-MM" value
        // elsewhere, let corrupted server data silently win over and overwrite a correct
        // local lastFired stamp. Validate the same way endMonth already is on the next line.
        lastFired: /^\d{4}-(0[1-9]|1[0-2])$/.test(String(row[9] || '').trim()) ? String(row[9] || '').trim() : '',
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

    const rows = rules.map(r => [
      Number(r.id) || 0, String(r.type || '').slice(0, 20), String(r.tx || '').slice(0, 100),
      String(r.cat || '').slice(0, 50), Number(r.amount) || 0, String(r.pm || '').slice(0, 30),
      String(r.notes || '').slice(0, 500), Number(r.dayOfMonth) || 1, r.active ? 'TRUE' : 'FALSE',
      String(r.lastFired || '').slice(0, 7), '', String(r.endMonth || '').slice(0, 7),
    ]);

    // Pad with empty rows to overwrite deleted rules in a single API request instead of sequential clear+update
    const emptyRow = Array(12).fill('');
    while (rows.length < 100) rows.push(emptyRow);

    await SheetsClient.updateValues(spreadsheetId, `${RECURRING_SHEET}!A${RECURRING_DATA_ROW}:L${RECURRING_DATA_ROW + rows.length - 1}`, rows);
    return { status: 'ok', count: rows.length };
  }

  // ── CONFIG (Categories / PMs / Assets / Accounts — "Config" tab) ──
  async function ensureConfigSheetExists() {
    const meta = await SheetsClient.getSpreadsheetMeta(spreadsheetId);
    const configSheet = (meta.sheets || []).find(s => s.properties.title === CONFIG_SHEET);
    if (!configSheet) {
      await SheetsClient.batchUpdate(spreadsheetId, [{ addSheet: { properties: { title: CONFIG_SHEET } } }]);
    } else {
      const colCount = configSheet.properties.gridProperties?.columnCount || 0;
      if (colCount < 11) {
        await SheetsClient.batchUpdate(spreadsheetId, [{
          updateSheetProperties: {
            properties: {
              sheetId: configSheet.properties.sheetId,
              gridProperties: { columnCount: 15 }
            },
            fields: 'gridProperties.columnCount'
          }
        }]);
      }
    }
    await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A1:N1`, [[
      'kind', 'name', 'color', 'ccy', 'assetType', 'archived', 'sortOrder', 'linkedPM', 'balance', 'balanceDate', 'showOnInsights', 'creditCard', 'billingDate', 'creditLimit'
    ]]);
    return !configSheet;
  }

  async function handleGetConfig() {
    const justCreated = await ensureConfigSheetExists();
    if (justCreated) {
      const rows = CONFIG_DEFAULTS.map((it, idx) => serializeConfigRow(it, idx));
      await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:N${CONFIG_DATA_ROW + rows.length - 1}`, rows);
      return { status: 'ok', items: CONFIG_DEFAULTS };
    }
    const res = await SheetsClient.getValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:N`);
    const rows = res.values || [];
    if (rows.length === 0) {
      // Header exists but no data rows — seed now.
      const seedRows = CONFIG_DEFAULTS.map(it => [
        it.kind, it.name, it.color, it.ccy, it.assetType, it.archived ? 'TRUE' : 'FALSE', it.sortOrder, it.linkedPM || '',
        (it.balance !== null && it.balance !== undefined && String(it.balance).trim() !== '') ? Number(it.balance) : '',
        String(it.balanceDate || '').slice(0, 10),
        it.showOnInsights === false ? 'FALSE' : 'TRUE',
        it.creditCard ? 'TRUE' : 'FALSE',
        '', ''
      ]);
      await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:N${CONFIG_DATA_ROW + seedRows.length - 1}`, seedRows);
      return { status: 'ok', items: CONFIG_DEFAULTS };
    }
    const items = rows
      .filter(r => r[1])
      .map((r, idx) => {
        let balVal = null;
        if (r[8] !== undefined && r[8] !== null && String(r[8]).trim() !== '') {
          if (typeof r[8] === 'number') {
            balVal = isNaN(r[8]) ? null : r[8];
          } else {
            let str = String(r[8]).trim().replace(/^(Rp|USD|\$)\s*/i, '');
            if (/^\d{1,3}(\.\d{3})+$/.test(str)) str = str.replace(/\./g, '');
            else str = str.replace(/,/g, '');
            const rawNum = Number(str);
            if (!isNaN(rawNum)) balVal = rawNum;
          }
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
          // Sheets values.get defaults to FORMATTED_VALUE, so a date cell can come back
          // locale-formatted (e.g. "02/08/2026") instead of ISO. computeAccountCurrentBalance()
          // compares this against ISO-constructed transaction dates with plain string <=/>,
          // so an unnormalized value silently fails to exclude any pre-cutoff row (same class
          // of bug fixed for Invest dates above — see parseAnyDateToISO/handleGetInvest).
          balanceDate: parseAnyDateToISO(r[9]) || String(r[9] || '').trim(),
          showOnInsights: (r[10] !== undefined && r[10] !== null && String(r[10]).trim() !== '') ? (String(r[10]).trim().toUpperCase() !== 'FALSE' && r[10] !== false) : true,
          creditCard: String(r[11] || '').trim().toUpperCase() === 'TRUE',
          billingDate: Number(r[12]) || 0,
          creditLimit: Number(r[13]) || 0,
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
    const rows = items.map((it, idx) => serializeConfigRow(it, idx));
    
    // Pad with empty rows to overwrite deleted configs in a single API request
    const emptyRow = Array(14).fill('');
    while (rows.length < 150) rows.push(emptyRow);

    await SheetsClient.updateValues(spreadsheetId, `${CONFIG_SHEET}!A${CONFIG_DATA_ROW}:N${CONFIG_DATA_ROW + rows.length - 1}`, rows);
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
      if (type === 'allOpex') return handleGetAllOpex();
      if (type === 'invest') return handleGetInvest(url.searchParams.get('since') || '2020-01-01');
      if (type === 'goals') return handleGetGoals();
      if (type === 'recurring') return handleGetRecurring();
      if (type === 'config') return handleGetConfig();
      return { status: 'error', message: 'Unknown type' };
    }

    const data = JSON.parse(opts.body);
    if (data.type === 'opex') return handleOpex(data);
    if (data.type === 'invest') return handleInvest(data);
    if (data.type === 'goals') return handleGoals(data);
    if (data.type === 'recurring') return handleRecurring(data);
    if (data.type === 'config') return handleConfig(data);
    if (data.type === 'transfer') return handleTransfer(data);
    return { status: 'error', message: 'Unknown type' };
  }

  async function listAvailableSpreadsheets() {
    const res = await SheetsClient.findFiles(
      "trashed=false and mimeType='application/vnd.google-apps.spreadsheet'"
    );
    const files = (res.files || []).filter(f => !f.trashed);
    const result = [];
    for (const f of files) {
      let opexCount = 0;
      let investCount = 0;
      try {
        const meta = await SheetsClient.getSpreadsheetMeta(f.id);
        const hasOpex = (meta.sheets || []).some(s => s.properties.title === 'Opex');
        if (hasOpex) {
          const [opexRes, investRes] = await Promise.all([
            SheetsClient.getValues(f.id, 'Opex!A2:A'),
            SheetsClient.getValues(f.id, 'Invest!A2:A'),
          ]);
          opexCount = (opexRes.values || []).filter(r => r && r[0]).length;
          investCount = (investRes.values || []).filter(r => r && r[0]).length;
        }
      } catch (e) {
        console.warn('Error checking file in listAvailableSpreadsheets', f.id, e);
      }
      result.push({ id: f.id, name: f.name, opexCount, investCount, createdTime: f.createdTime, isCurrent: f.id === spreadsheetId });
    }
    return result;
  }

  async function setSpreadsheetId(newId) {
    if (!newId) return;
    spreadsheetId = newId;
    localStorage.setItem(LS_SS_ID, spreadsheetId);
    try {
      const meta = await SheetsClient.getSpreadsheetMeta(spreadsheetId);
      const opexSheet = (meta.sheets || []).find(s => s.properties.title === 'Opex');
      const investSheet = (meta.sheets || []).find(s => s.properties.title === 'Invest');
      opexGid = opexSheet ? opexSheet.properties.sheetId : null;
      investGid = investSheet ? investSheet.properties.sheetId : null;
      if (opexGid != null) localStorage.setItem(LS_OPEX_GID, String(opexGid));
      if (investGid != null) localStorage.setItem(LS_INVEST_GID, String(investGid));
    } catch (e) {
      console.warn('Error fetching meta for new spreadsheetId', e);
    }
  }

  function getSpreadsheetId() { return spreadsheetId; }

  return { bootstrap, handleRequest, getSpreadsheetId, installLivePriceFormulas, listAvailableSpreadsheets, setSpreadsheetId, MONTHS, parseMoneyCell };
})();
