// Nota — bank email parser (pure functions, no DOM / network).
// Turns the body of a BCA / CIMB notification email into a plain transaction
// object. Loaded as a classic <script> in the app and via require() in the tests.
//
// Returned shape (or null when the email is not a recognised transaction):
//   { typeId, typeLabel, direction: 'expense'|'income', date: 'YYYY-MM-DD',
//     amount: number|null, ccy: 'IDR'|..., nativeAmount: number|null,
//     merchant, defaultTx, sourceKey, ref, status }

const EmailParser = (() => {
  const MONTHS = {
    jan: 1, january: 1, januari: 1, feb: 2, february: 2, februari: 2, mar: 3, march: 3, maret: 3,
    apr: 4, april: 4, may: 5, mei: 5, jun: 6, june: 6, juni: 6, jul: 7, july: 7, juli: 7,
    aug: 8, august: 8, agu: 8, agt: 8, agustus: 8, sep: 9, sept: 9, september: 9,
    oct: 10, october: 10, okt: 10, oktober: 10, nov: 11, november: 11,
    dec: 12, december: 12, des: 12, desember: 12,
  };

  // Types the app knows about. `id` is what Settings stores a per-type action under.
  const TYPES = [
    { id: 'qris',     label: 'QRIS payment',            defaultAction: 'ask' },
    { id: 'flazz',    label: 'Flazz top up',            defaultAction: 'ask' },
    { id: 'transfer', label: 'Transfer to account',     defaultAction: 'ask' },
    { id: 'cc',       label: 'Credit card purchase',    defaultAction: 'ask' },
    { id: 'bifast',   label: 'Incoming transfer (BI-FAST)', defaultAction: 'ask' },
    { id: 'ccbill',   label: 'Credit card bill payment', defaultAction: 'ignore' },
    { id: 'other',    label: 'Other bank transactions', defaultAction: 'ask' },
  ];

  // ── text helpers ────────────────────────────────────────────
  function decodeEntities(s) {
    return s
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
  }

  // Keeps table structure as tabs/newlines so "Label : Value" rows survive as lines.
  function htmlToText(html) {
    let s = String(html || '');
    s = s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '');
    s = s.replace(/<br\s*\/?>|<\/(p|div|tr|li|table|h\d)>/gi, '\n');
    s = s.replace(/<\/(td|th)>/gi, '\t');
    s = s.replace(/<[^>]+>/g, '');
    s = decodeEntities(s);
    return s.replace(/\r/g, '').replace(/[  ]+/g, ' ').replace(/ ?\t ?/g, '\t').replace(/\n[ \t]*/g, '\n');
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // First label that is present wins. Value = rest of that line after the colon (or, for
  // templates like BI-FAST that have no colon, after the tab separating the label cell).
  //
  // Layouts seen / expected (all must work, because which one a real email produces depends on
  // how the sender's HTML flattens):
  //   "Label<TAB>:<TAB>Value"      one line
  //   "Label<TAB>Value"            one line, no colon (BI-FAST)
  //   "Label\n: Value"             label and ": value" on separate lines
  //   "Label\n:\nValue"            label, colon and value each on their own line
  function field(text, labels) {
    for (const label of labels) {
      const lab = '(?:^|\\n)[ \\t]*' + escapeRe(label) + '[ \\t]*';
      // 1) same-line value (cannot run into the next row when a value is blank)
      let m = text.match(new RegExp(lab + '(?::|\\t)[ \\t:]*([^\\n]*)', 'i'));
      if (m && m[1].trim()) return m[1].replace(/\t+/g, ' ').trim();
      // 2) value on a following line. Reject it if it is really the next "Label : value" row.
      // The lookahead stops a blank value from taking the next row's label: a real value is never
      // followed by a line that starts with ":" (that line would be *its* value).
      m = text.match(new RegExp(lab + '\\n[ \\t]*:[ \\t]*(?:\\n[ \\t]*)?([^\\n]*)(?=\\n(?![ \\t]*:)|$)', 'i'));
      if (m) {
        const v = m[1].replace(/\t+/g, ' ').trim();
        if (v && !/:\s|:$/.test(v)) return v;
      }
    }
    return '';
  }

  // "IDR 63,500.00" (BCA) / "Rp501.755,00" / "Rp. 601.149,00" (Indonesian) -> { ccy, value }.
  function parseAmount(raw) {
    const s = String(raw || '').trim();
    if (!s) return { ccy: 'IDR', value: null };
    const ccyM = s.match(/^(IDR|Rp\.?|USD|SGD|EUR|JPY|AUD|GBP|MYR|CNY|HKD|THB|CHF|\$)/i);
    let ccy = 'IDR';
    if (ccyM) {
      const c = ccyM[1].toUpperCase();
      ccy = (c.startsWith('RP') || c === 'IDR') ? 'IDR' : (c === '$' ? 'USD' : c);
    }
    let num = s.replace(/^(IDR|Rp\.?|[A-Za-z]{3}|\$)/i, '').replace(/[^\d.,]/g, '');
    if (!num) return { ccy, value: null };
    const lastDot = num.lastIndexOf('.');
    const lastComma = num.lastIndexOf(',');
    if (lastDot !== -1 && lastComma !== -1) {
      const decSep = lastDot > lastComma ? '.' : ',';
      const thouSep = decSep === '.' ? ',' : '.';
      num = num.split(thouSep).join('').replace(decSep, '.');
    } else if (lastDot !== -1 || lastComma !== -1) {
      const sep = lastDot !== -1 ? '.' : ',';
      const parts = num.split(sep);
      const last = parts[parts.length - 1];
      // "7,000" / "501.755" / "1.234.567" are thousands groups; "12,50" is a decimal.
      const isThousands = parts.length > 2 || last.length === 3;
      num = isThousands ? parts.join('') : parts.join('') .slice(0, -last.length) + '.' + last;
    }
    const value = Number(num);
    if (!isFinite(value)) return { ccy, value: null };
    return { ccy, value: ccy === 'IDR' ? Math.round(value) : value };
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function iso(y, m, d) {
    if (!(y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
    return `${y}-${pad(m)}-${pad(d)}`;
  }

  // "26 Oct 2026 08:47:01", "26-10-2026 08:26:09 WIB", "23/10/2026"  ->  "YYYY-MM-DD"
  function parseDate(raw) {
    const s = String(raw || '').trim();
    let m = s.match(/(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/,]+(\d{4})/);
    if (m && MONTHS[m[2].toLowerCase()]) return iso(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    m = s.match(/(\d{1,2})[\-\/.](\d{1,2})[\-\/.](\d{4})/);
    if (m) return iso(+m[3], +m[2], +m[1]);
    m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return iso(+m[1], +m[2], +m[3]);
    m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);   // "Oct 23, 2026 15:29:35 (GMT +7)"
    if (m && MONTHS[m[1].toLowerCase()]) return iso(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    return '';
  }

  // "8831****14", "8831xxxx14", "TAHAPAN XPRESI - 8831****14", "472647XXXX4541"  ->  "8831****14"
  function sourceKey(raw) {
    const m = String(raw || '').match(/\d[\dxX*\s-]{3,}[\dxX*]/);
    if (!m) return '';
    return m[0].replace(/[\s-]/g, '').replace(/x/gi, '*');
  }

  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/(^|[\s\-\/(])([a-z])/g, (_, a, b) => a + b.toUpperCase());
  }

  function cleanMerchant(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  // ── per-template parsers ────────────────────────────────────
  function base(typeId, text) {
    const t = TYPES.find(x => x.id === typeId);
    return { typeId, typeLabel: t ? t.label : typeId, direction: 'expense', status: 'ok', ccy: 'IDR', nativeAmount: null };
  }

  function applyAmount(out, raw) {
    const a = parseAmount(raw);
    out.ccy = a.ccy;
    if (a.ccy === 'IDR') { out.amount = a.value; }
    else { out.amount = null; out.nativeAmount = a.value; }  // user must enter the IDR amount
  }

  function parseBcaJournal(text) {
    const typeLabel = field(text, ['Transaction Type', 'Transfer Type']);
    if (!typeLabel) return null;
    const status = field(text, ['Status']);
    const ref = field(text, ['Reference No.', 'Reference No', 'Reference Number']);
    const date = parseDate(field(text, ['Transaction Date']));
    const src = sourceKey(field(text, ['Source of Fund']));
    const lower = typeLabel.toLowerCase();

    let typeId = 'other';
    if (/qris/.test(lower)) typeId = 'qris';
    else if (/flazz/.test(lower)) typeId = 'flazz';
    else if (/credit card|paylater|kartu kredit/.test(lower)) typeId = 'ccbill';
    else if (/transfer/.test(lower)) typeId = 'transfer';

    const out = base(typeId, text);
    Object.assign(out, { ref, date, sourceKey: src, rawType: typeLabel });
    if (status && !/success|berhasil/i.test(status)) out.status = 'failed';

    if (typeId === 'qris') {
      out.merchant = cleanMerchant(field(text, ['Payment to', 'Merchant Name']));
      applyAmount(out, field(text, ['Total Payment', 'Amount']));
      out.defaultTx = titleCase(out.merchant) || 'QRIS payment';
    } else if (typeId === 'flazz') {
      out.merchant = 'Flazz Top Up';
      applyAmount(out, field(text, ['Top Up Amount', 'Total Payment', 'Amount']));
      out.defaultTx = 'Flazz Top Up';
    } else if (typeId === 'transfer') {
      out.merchant = cleanMerchant(field(text, ['Beneficiary Name']));
      applyAmount(out, field(text, ['Transfer Amount', 'Total Payment', 'Amount']));
      out.defaultTx = out.merchant ? 'Transfer ' + titleCase(out.merchant) : typeLabel;
      const remarks = field(text, ['Remarks']);
      if (remarks && remarks !== '-') out.notes = remarks;
    } else if (typeId === 'ccbill') {
      out.merchant = typeLabel;
      applyAmount(out, field(text, ['Total Payment', 'Amount']));
      out.defaultTx = 'Credit card payment';
    } else {
      out.merchant = cleanMerchant(field(text, ['Payment to', 'Beneficiary Name', 'Merchant Name', 'Company Name', 'Provider'])) || typeLabel;
      applyAmount(out, field(text, ['Total Payment', 'Transfer Amount', 'Top Up Amount', 'Total Amount', 'Amount']));
      out.defaultTx = titleCase(out.merchant);
    }
    return out;
  }

  function parseCreditCardNotice(text) {
    if (!/Merchant\s*\/\s*ATM/i.test(text) || !/Sejumlah/i.test(text)) return null;
    const out = base('cc', text);
    const merchant = cleanMerchant(field(text, ['Merchant / ATM', 'Merchant/ATM']));
    Object.assign(out, {
      merchant, ref: '', rawType: field(text, ['Jenis Transaksi']),
      date: parseDate(field(text, ['Pada Tanggal'])),
      sourceKey: sourceKey(field(text, ['Nomor Kartu'])),
      defaultTx: titleCase(merchant),
    });
    applyAmount(out, field(text, ['Sejumlah']));
    return out;
  }

  function parseBifast(text) {
    if (!/penerimaan dana/i.test(text) && !/BI-?FAST/i.test(text)) return null;
    const sender = cleanMerchant(field(text, ['Nama Pengirim']));
    if (!sender && !field(text, ['Nominal'])) return null;
    const out = base('bifast', text);
    Object.assign(out, {
      direction: 'income', merchant: sender, ref: '',
      date: parseDate(field(text, ['Tanggal Transaksi'])),
      sourceKey: sourceKey(field(text, ['No Rekening Penerima'])) || String(field(text, ['No Rekening Penerima'])).replace(/\D/g, ''),
      rawType: 'BI-FAST', defaultTx: sender ? titleCase(sender) : 'Incoming transfer',
      senderBank: field(text, ['Bank Pengirim']),
    });
    applyAmount(out, field(text, ['Nominal', 'Jumlah']));
    return out;
  }

  // "BI FAST Transfer - Mandiri Cash Management" notification: a company paying the user.
  // Same payment the CIMB BI-FAST email reports, so both map to typeId 'bifast' and the
  // importer collapses them (see signature dedup in email-import.js).
  function parseMandiriCm(text) {
    if (!/Mandiri Cash Management/i.test(text) || !/To Account/i.test(text)) return null;
    const direction = field(text, ['Transaction Type']);
    if (!/^credit/i.test(direction)) return null;           // only money coming in
    const toAcct = field(text, ['To Account']);
    const fromAcct = field(text, ['From Account']);
    const fromName = fromAcct.split(/\s-\s/).pop();
    const merchant = cleanMerchant(field(text, ['Corporate Name']) || fromName);
    const out = base('bifast', text);
    Object.assign(out, {
      direction: 'income', merchant, ref: '', rawType: 'BI-FAST (Mandiri CM)',
      date: parseDate(field(text, ['Date/Time', 'Date'])),
      sourceKey: sourceKey(toAcct) || toAcct.replace(/\D/g, ''),
      defaultTx: merchant ? titleCase(merchant) : 'Incoming transfer',
    });
    const remark = field(text, ['Extended Payment Detail', 'Remark']);
    if (remark && remark !== '-') out.notes = remark;
    applyAmount(out, field(text, ['Amount']));
    return out;
  }

  // Entry point. `text` may be HTML or plain text. `fallbackDate` is the email's own
  // arrival date (YYYY-MM-DD), used only when the body has no parsable date.
  function parse(rawBody, fallbackDate) {
    const body = String(rawBody || '');
    const text = /<\s*(html|body|table|div|br|td|p)\b/i.test(body) ? htmlToText(body) : body.replace(/\r/g, '');
    // A Mandiri CM email is either an incoming credit or nothing: it also has a "Transaction
    // Type" line that parseBcaJournal would otherwise claim as an expense.
    const out = /Mandiri Cash Management/i.test(text)
      ? parseMandiriCm(text)
      : (parseBcaJournal(text) || parseCreditCardNotice(text) || parseBifast(text));
    if (!out) return null;
    if (!out.date) out.date = fallbackDate || '';
    if (out.amount === undefined) out.amount = null;
    out.merchant = out.merchant || '';
    out.defaultTx = out.defaultTx || out.merchant || out.typeLabel;
    return out;
  }

  return { parse, parseAmount, parseDate, sourceKey, htmlToText, field, TYPES };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EmailParser;
