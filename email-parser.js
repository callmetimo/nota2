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
    { id: 'ccrefund', label: 'Credit card refund / reversal', defaultAction: 'ask' },
    { id: 'bifast',   label: 'Incoming transfer (BI-FAST)', defaultAction: 'ask' },
    { id: 'ccbill',   label: 'Credit card bill payment (transfer)', defaultAction: 'ask' },
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
      // Paying the card from a bank account: money moves between two of the user's own
      // accounts, so it is a transfer (source account -> card), not spending.
      out.direction = 'transfer';
      out.merchant = typeLabel;
      out.targetKey = sourceKey(field(text, ['Card No. / Customer No.', 'Card No.', 'Customer No.']));
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
  function parse(rawBody, fallbackDate, subject) {
    const body = String(rawBody || '');
    const text = /<\s*(html|body|table|div|br|td|p)\b/i.test(body) ? htmlToText(body) : body.replace(/\r/g, '');
    // A Mandiri CM email is either an incoming credit or nothing: it also has a "Transaction
    // Type" line that parseBcaJournal would otherwise claim as an expense.
    const out = /Mandiri Cash Management/i.test(text)
      ? parseMandiriCm(text)
      : (parseBcaJournal(text) || parseCreditCardNotice(text) || parseBifast(text));
    if (!out) return null;
    // "Credit Card Reversal/Void Transaction Notification": same fields as a purchase, but the money
    // comes back — a purchase read as an expense would double the cost instead of cancelling it.
    if (out.typeId === 'cc' && (/reversal|void/i.test(subject || '') || /reversal|void|pembatalan|refund/i.test(out.rawType || ''))) {
      const t = TYPES.find(x => x.id === 'ccrefund');
      Object.assign(out, { typeId: 'ccrefund', typeLabel: t.label, direction: 'income',
        defaultTx: out.merchant ? 'Refund ' + titleCase(out.merchant) : 'Credit card refund' });
    }
    if (!out.date) out.date = fallbackDate || '';
    if (out.amount === undefined) out.amount = null;
    out.merchant = out.merchant || '';
    out.defaultTx = out.defaultTx || out.merchant || out.typeLabel;
    return out;
  }

  // ── generic receipt reader (user-defined email types) ──────────
  // For senders Nota has no template for (Gojek, Grab, ...): finds every Rp/IDR amount, scores each
  // by the label in front of it ("Total Bayar" up, "Subtotal"/"Diskon"/"Saldo" down) and takes the
  // best. `opts.amountLabel` (a label the user picked in the preview) overrides the scoring.
  // Returns null when no amount is found. `candidates` lets the UI offer the other amounts.
  const GOOD_LABEL = [
    [/grand total|total (bayar|pembayaran|dibayar|tagihan|belanja)|jumlah (bayar|pembayaran|dibayar)|amount paid|total paid|total charge(d)?/i, 10],
    [/\btotal\b|sejumlah|nominal|jumlah transaksi|transaction amount/i, 6],
    [/bayar|paid|pembayaran|tagihan|amount|charged/i, 3],
  ];
  const BAD_LABEL = /sub ?total|diskon|discount|promo|ongkir|biaya|fee|pajak|tax|ppn|saldo|balance|cashback|potongan|voucher|kembalian|\btip\b|harga dasar|base fare/i;
  const AMOUNT_RE = /(?:Rp\.?|IDR)\s*(\d[\d.,]*)/gi;
  const MERCHANT_LABELS = ['Merchant', 'Merchant Name', 'Nama Merchant', 'Nama Toko', 'Restoran', 'Restaurant', 'Toko', 'Store', 'Penjual',
    'Hotel Name', 'Dibayar ke', 'Paid to', 'Payment to', 'Pembayaran ke'];
  const DATE_LABELS = ['Transaction Date', 'Tanggal Transaksi', 'Payment Date', 'Order Date', 'Booking Date', 'Tanggal Pesanan',
    'Picked up on', 'Tanggal', 'Date', 'Waktu', 'Time'];
  // A purchase that is confirmed but not paid yet (pay at the hotel, awaiting transfer...): nothing
  // has left the account, so it is not a transaction. An explicit "paid" wording wins.
  const UNPAID_RE = /(collected|charged) by the (property|hotel)|pay at (the )?(property|hotel)|bayar di (hotel|tempat)|belum dibayar|menunggu pembayaran|awaiting payment|payment (is )?pending|pay later|\bunpaid\b|selesaikan pembayaran|complete your payment/i;
  const PAID_RE = /payment status\s*[:\t ]*paid|status pembayaran\s*[:\t ]*(lunas|berhasil)|pembayaran berhasil|payment (was )?successful|\blunas\b|total paid|total dibayar|\bpaid by\b|dibayar pakai/i;
  function looksUnpaid(text) { return UNPAID_RE.test(text) && !PAID_RE.test(text); }

  function labelKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

  // "BCA <bca@bca.co.id>" -> "BCA"; "noreply@info.bluebirdgroup.com" -> "Bluebirdgroup" (the main domain
  // name, not a subdomain like info / invoicing / mail).
  function senderName(from) {
    const f = String(from || '');
    const name = f.replace(/<[^>]*>/, '').replace(/["']/g, '').trim();
    if (name && !/@/.test(name)) return name;
    const host = (f.match(/@([a-z0-9.-]+)/i) || [])[1];
    if (!host) return '';
    const parts = host.toLowerCase().split('.').filter(Boolean);
    const sld = /^(co|com|net|org|ac|go|or|web)$/.test(parts[parts.length - 2] || '') ? 3 : 2;
    return titleCase(parts[Math.max(0, parts.length - sld)] || parts[0]);
  }

  function flatten(rawBody) {
    const body = String(rawBody || '');
    return /<\s*(html|body|table|div|br|td|p)\b/i.test(body) ? htmlToText(body) : body.replace(/\r/g, '');
  }

  // Every Rp / IDR amount in the text with the label in front of it and a "looks like the total" score.
  function scanAmounts(text) {
    const lines = text.split('\n');
    const found = [];
    lines.forEach((line, i) => {
      AMOUNT_RE.lastIndex = 0;
      let m;
      while ((m = AMOUNT_RE.exec(line))) {
        const value = parseAmount(m[0]).value;
        if (!(value > 0)) continue;
        let label = line.slice(0, m.index).replace(/[\t:]+/g, ' ').trim();
        // "Total\n Rp 45.000": the label sits on the previous non-blank line.
        for (let k = i - 1; !label && k >= 0 && k >= i - 2; k--) label = lines[k].replace(/[\t:]+/g, ' ').trim();
        let score = 0;
        for (const [re, pts] of GOOD_LABEL) if (re.test(label)) { score = Math.max(score, pts); }
        if (BAD_LABEL.test(label)) score -= 8;
        found.push({ label: label.slice(0, 60), key: labelKey(label), value, score, pos: found.length });
      }
    });
    return found;
  }

  // First date near the top of the text ("Senin, 15 Januari 2024"), for emails with no date label.
  function topDate(text) {
    const head = text.split('\n').slice(0, 25).join('\n');
    // Same-line only ([ \t], never a newline), and the first match that is a real date wins.
    const re = /\d{1,2}[ \t\-\/]+[A-Za-z]{3,9}[ \t\-\/,]+\d{4}|[A-Za-z]{3,9}[ \t]+\d{1,2},?[ \t]+\d{4}|\d{1,2}[\-\/.]\d{1,2}[\-\/.]\d{4}/g;
    let m;
    while ((m = re.exec(head))) { const d = parseDate(m[0]); if (d) return d; }
    return '';
  }

  function parseGeneric(rawBody, fallbackDate, opts) {
    opts = opts || {};
    const text = flatten(rawBody);
    // Booked but not paid yet: not a transaction. status 'failed' makes the importer drop it for good.
    if (looksUnpaid(text)) return { typeId: 'custom', typeLabel: opts.name || 'Email', status: 'failed', unpaid: true, amount: null };
    const found = scanAmounts(text);
    if (!found.length) return null;
    let pick = null;
    if (opts.amountLabel) {
      const want = labelKey(opts.amountLabel);
      const hits = found.filter(c => c.key === want);
      if (hits.length) pick = hits[hits.length - 1];
    }
    // Best score; on a tie the later one (receipts end with the total).
    if (!pick) pick = found.reduce((a, b) => (b.score >= a.score ? b : a));
    const seenC = new Set();
    const candidates = found.filter(c => { const k = c.key + '|' + c.value; if (seenC.has(k)) return false; seenC.add(k); return true; })
      .map(c => ({ label: c.label, value: c.value }));
    const merchant = cleanMerchant(field(text, MERCHANT_LABELS)) || senderName(opts.from) || cleanMerchant(opts.subject);
    const date = parseDate(field(text, DATE_LABELS)) || topDate(text) || fallbackDate || '';
    return {
      typeId: 'custom', typeLabel: opts.name || 'Email', direction: 'expense', status: 'ok', ccy: 'IDR', nativeAmount: null,
      date, amount: pick.value, merchant, defaultTx: merchant, sourceKey: '', ref: '',
      amountLabel: pick.label, candidates, ambiguous: candidates.length > 1 && !opts.amountLabel && pick.score <= 0,
    };
  }

  // How much an email looks like a paid receipt (the mailbox scan keeps 4 and above). Looks at the
  // body text plus anything read from an attached PDF, the subject, the attachment names and sender.
  //   +3 a total-style label with an amount   +2 an ID / order / reference line with a value
  //   +2 receipt wording in subject or file name   +1 a payment-method line   +1 a no-reply style sender
  //   -3 promo wording in the subject
  // Not paid yet (pay at the hotel...) is reported separately: those are never suggested.
  function receiptScore(rawBody, subject, from, filenames) {
    const text = flatten(rawBody);
    const out = { score: 0, amount: 0, unpaid: false };
    const found = scanAmounts(text);
    if (!found.length) return out;
    out.amount = found.reduce((a, b) => (b.score >= a.score ? b : a)).value;
    if (looksUnpaid(text)) { out.unpaid = true; return out; }
    const head = String(subject || '') + ' ' + String(filenames || '');
    let score = 0;
    if (found.some(c => c.score >= 6)) score += 3;
    if (/(^|\n)[ \t]*(order id|booking id|booking no\.?|id pesanan|no\.? ?pesanan|order no\.?|invoice (no|number)\.?|no\.? ?referensi|reference no\.?|ref(erence)? ?(no|number)\.?|transaction id|id transaksi|receipt no\.?|id)[ \t]*[:\t ][ \t:]*[A-Za-z0-9-]{5,}/i.test(text)) score += 2;
    if (/receipt|struk|invoice|bukti (pembayaran|transaksi)|pembayaran|payment|purchase|pesanan|order|transaksi|transaction|transfer|tagihan|perjalanan|booking|\bride\b|\btrip\b/i.test(head)) score += 2;
    if (/payment method|metode pembayaran|paid by|dibayar (pakai|dengan)|pay(ment)? with/i.test(text)) score += 1;
    if (/no-?reply|invoice|receipt|billing|notification/i.test(from || '')) score += 1;
    if (/promo|\bsale\b|voucher|cashback|% ?off|newsletter|diskon hingga|flash/i.test(head)) score -= 3;
    out.score = score;
    return out;
  }

  // The stable beginning of a subject whose later part varies per email (dates, ids, names):
  // "Agoda - Customer Receipt from Booking ID: 2038132945" -> "Agoda - Customer Receipt from Booking ID".
  // '' when too little is left to be a useful filter.
  const DATE_WORD = /(^|[^a-z])(mon(day)?|tue(s|sday)?|wed(nesday)?|thu(rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?|senin|selasa|rabu|kamis|jumat|sabtu|minggu|jan(uary|uari)?|feb(ruary|ruari)?|mar(ch|et)?|apr(il)?|may|mei|jun(e|i)?|jul(y|i)?|aug(ust)?|agu(stus)?|sept?(ember)?|oct(ober)?|okt(ober)?|nov(ember)?|dec(ember)?|des(ember)?)([^a-z]|$)/i;
  function subjectPattern(subject) {
    let t = String(subject || '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '').trim();
    const d = t.search(/\d/);
    if (d >= 0) t = t.slice(0, d);
    const m = DATE_WORD.exec(t);
    if (m) t = t.slice(0, m.index + m[1].length);
    t = t.replace(/[\s:,;#.\-–|]+$/, '').replace(/\s+(pada|on|at|untuk|for|from|dari)$/i, '').trim();
    return t.length >= 6 ? t.slice(0, 60) : '';
  }

  // Rebuilds readable lines from a PDF page's text items ({ str, x, y, w }): items on the same
  // baseline form a line, a wide gap becomes a tab, so "Total Charge   IDR 2,365,873" stays one line.
  function pdfItemsToText(items) {
    const rows = [];
    items.filter(it => String(it.str || '').trim()).forEach(it => {
      let row = rows.find(r => Math.abs(r.y - it.y) <= 2.5);
      if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
      row.items.push(it);
    });
    rows.sort((a, b) => b.y - a.y);
    return rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      r.items.forEach(it => {
        const gap = end === null ? 0 : it.x - end;
        out += (end === null ? '' : (gap > 12 ? '\t' : (gap > 1 ? ' ' : ''))) + it.str;
        end = it.x + (it.w || it.str.length * 5);
      });
      return out;
    }).join('\n');
  }

  // A short phrase that tells this kind of email apart from the sender's others, e.g. the value of
  // "Transaction Type" ("QRIS Payment"). '' when the email has no such line.
  function guessKeyword(rawBody) {
    const body = String(rawBody || '');
    const text = /<\s*(html|body|table|div|br|td|p)\b/i.test(body) ? htmlToText(body) : body.replace(/\r/g, '');
    // Only labels that name the kind of email. "Jenis Transaksi" on card notices is the purchase
    // category (E-COMMERCE...), and a bare "Credit" is just the direction: both would split one
    // kind of email into many types.
    const v = field(text, ['Transaction Type', 'Transfer Type']);
    return v && v.length <= 40 && !/\d{4,}/.test(v) && !/^(credit|debit|transfer|kredit)$/i.test(v) ? v : '';
  }

  // Bump whenever parsing improves: the importer re-reads emails it could not read under an older
  // version instead of treating them as "not a transaction" forever.
  const VERSION = 5;

  return { parse, parseGeneric, receiptScore, subjectPattern, pdfItemsToText, guessKeyword, senderName, parseAmount, parseDate, sourceKey, htmlToText, field, TYPES, VERSION };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EmailParser;
