// Dev-only browser-test stubs for Email Import. Load after tests/e2e-seed.html redirected to the
// app:  eval(await (await fetch('/tests/e2e-stubs.js')).text())
// Fakes Gmail + the Sheets-backed API so no Google sign-in is needed. Fake emails use made-up data.
(() => {
  const b64u = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const mk = (id, body, mime = 'text/plain', from = 'bca@bca.co.id', subject = 'Internet Transaction Journal') => ({ id, internalDate: String(Date.now()),
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }], mimeType: 'multipart/alternative', parts: [{ mimeType: mime, body: { data: b64u(body) } }] } });
  const qris = (ref) => `Status\t:\tSuccessful\nTransaction Date\t:\t26 Oct 2026 08:47:01\nTransaction Type\t:\tQRIS Payment\nPayment to\t:\tWARUNG MAKAN SEJAHTERA\nSource of Fund\t:\tTAHAPAN XPRESI - 1234****56\nTotal Payment\t:\tIDR 7,000.00\nReference No.\t:\t${ref}`;
  window.__msgs = {
    m1: mk('m1', qris('REFQRIS1')),
    m2: mk('m2', `Status\t:\tSuccessful\nTransaction Date\t:\t26 Oct 2026 09:30:56\nTransaction Type\t:\tFlazz Top Up\nFlazz Card Number\t:\t0145000000000001\nSource of Fund\t:\t1234****56\nTop Up Amount\t:\tIDR 63,500.00\nReference No.\t:\tREFFLAZZ1`),
    m3: mk('m3', `Nomor Kartu\t: \t472647XXXX4541\nMerchant / ATM\t: \tDANA Utilities\nJenis Transaksi\t: \tE-COMMERCE\nOtentikasi\t: \t\nTRANSAKSI TANPA OTP\n\nPada Tanggal\t:\t26-10-2026 08:26:09 WIB\nSejumlah\t:\tRp501.755,00`),
    m4: mk('m4', `<html><body><table><tr><td>Status</td><td>:</td><td>Successful</td></tr><tr><td>Transaction Date</td><td>:</td><td>09 Oct 2026 09:34:55</td></tr><tr><td>Transaction Type</td><td>:</td><td>Credit Card &amp; Paylater - BCA</td></tr><tr><td>Total Payment</td><td>:</td><td>IDR 14,382,668.00</td></tr><tr><td>Reference No.</td><td>:</td><td>REFBILL1</td></tr></table></body></html>`, 'text/html'),
    m5: mk('m5', 'Weekly promo from your bank! 20% off.'),
    m6: mk('m6', qris('REFQRIS1')),
    m7: mk('m7', `Tanggal Transaksi\t23/10/2026\nNo Rekening Penerima\t703100000000\nNominal\tRp. 601.149,00\nNama Pengirim\tACME SERVICES\npenerimaan dana melalui layanan BIFAST`),
    // Same payment as m7, reported by the sender's bank (Mandiri Cash Management) with a remark.
    m9: mk('m9', `We would like to inform you that your transaction for BI FAST Transfer - Mandiri Cash Management is successfully executed.\n\nDate/Time\t:\tOct 23, 2026 15:29:35 (GMT +7)\nCorporate Name\t:\tACME SERVICES\nTransaction Type\t:\tCredit\nFrom Account\t:\t1220000000000 - IDR - ACME SERVICES\nTo Account\t:\t703100000000 - IDR - JOHN DOE\nAmount\t:\tIDR 601,149.00\nReference No\t:\t-\nRemark\t:\tOktober fee\nExtended Payment Detail\t:\tOktober fee 2026`),
    m8: mk('m8', `Nomor Kartu\t: \t472647XXXX4541\nMerchant / ATM\t: \tWARUNG BAKSO PAK DE\nJenis Transaksi\t: \tCONTACTLESS DALAM NEGERI\nPada Tanggal\t:\t25-10-2026 17:24:26 WIB\nSejumlah\t:\tRp68.100,00`),
  };
  // Card bill payment in the "label / ': value' on separate lines" layout (becomes a Transfer).
  window.__msgs.m10 = mk('m10', `Status\n: Successful\nTransaction Date\n: 26 Oct 2026 15:20:25\nTransaction Type\n: Credit Card & Paylater - BCA\nSource of Fund\n: 1234****56\nCard No. / Customer No.\n: 0000000015****64\nName\n: JOHN **US ***DOE\nTotal Bill\n: IDR 17,908,449.00\nTotal Payment\n: IDR 1,000,000.00\nRemaining Bill\n: IDR 16,908,449.00\nReference No.\n: 9527120261026152025225TPP0000000004`);
  const setFrom = (id, from, subject) => { window.__msgs[id].payload.headers = [{ name: 'From', value: from }, { name: 'Subject', value: subject }]; };
  ['m3', 'm8'].forEach(id => setFrom(id, 'kartukreditbca@bca.co.id', 'Credit Card Transaction Notification'));
  setFrom('m7', 'BIFAST.NOREPLY@cimbniaga.co.id', 'Incoming BI FAST');
  setFrom('m9', 'mcm@bankmandiri.co.id', 'BI FAST Transfer - Mandiri Cash Management');
  // Receipt emails (made-up) for user-defined email types.
  window.__msgs.m11 = mk('m11', `Tanggal	:	19 Oct 2026
Tarif dasar	Rp40.000
Biaya layanan	Rp5.000
Diskon	-Rp10.000
Subtotal	Rp35.000
Total Bayar	Rp45.000
Saldo GoPay	Rp120.000`, 'text/plain', 'Gojek <no-reply@gojek.com>', 'Your Gojek receipt');
  window.__msgs.m12 = mk('m12', `Item A Rp10.000
Item B Rp20.000`, 'text/plain', 'Grab <no-reply@grab.com>', 'Grab receipt');
  // ---- receipts from other senders (made-up) + one with a PDF attachment ----
  const pdfBytes = (lines) => {   // a minimal one-page text PDF
    const content = 'BT /F1 12 Tf 16 TL 50 750 Td ' + lines.map(l => '(' + l.replace(/[()\\]/g, '') + ') Tj T*').join(' ') + ' ET';
    const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'];
    let out = '%PDF-1.4\n'; const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    const xref = out.length;
    out += 'xref\n0 6\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
      'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
    return out;
  };
  window.__pdfData = b64u(pdfBytes(['Booking No. 2000000002', 'Payment Date August 3, 2026', 'Hotel Name   Ozzy Hotel', 'Total Charge   IDR 2,365,873 (USD 131.28)']));
  const withPdf = (m) => { m.payload.parts.push({ filename: 'Receipt.pdf', mimeType: 'application/pdf', body: { attachmentId: 'att1', size: 52000 } }); return m; };
  window.__msgs.m13 = withPdf(mk('m13', 'Hi Sam,\nPlease find the PDF copy of your receipt for your Agoda booking 2000000002\nEnjoy your travels!', 'text/plain', 'Agoda Customer Service <no-reply@agoda.com>', 'Agoda - Customer Receipt from Booking ID: 2000000002'));
  window.__msgs.m14 = mk('m14', 'Your booking is now confirmed!\nPayment for this booking will be collected by the property.\nPayment details\nRooms\tRp 3,684,786\nTotal Charge\tRp 4,458,497\nPay at The Hotel\tRp 4,458,497', 'text/plain', 'Agoda Customer Service <no-reply@agoda.com>', 'Your booking is now confirmed!');
  window.__msgs.m15 = mk('m15', 'Jakarta\nID: 80000001\tMonday, 17 Jun 2024\nThank you for using Bluebird~\nCost\tRp194.000\nDiscount\n\nRp10.000\n\nTotal\n\nRp194.000\n\nPayment method\n\ngopay', 'text/plain', 'noreply@info.bluebirdgroup.com', 'MyBluebird Receipt');
  window.__msgs.m16 = mk('m16', 'Big sale this week! Pay only Rp50.000 for selected items. Total savings Rp120.000', 'text/plain', 'Shop <news@shop.com>', '50% OFF sale - voucher inside');
  window.__msgs.m17 = mk('m17', 'Senin, 15 Januari 2024\nID pesanan: RB-000000-0000001\nMakasih udah pesan GoRide\nTotal dibayar\tRp26.000\nDibayar pakai kartu debit/kredit\tRp26.000', 'text/plain', 'Gojek Receipts <no-reply@invoicing.gojek.com>', 'Perjalananmu bersama Gojek pada Senin, 15 Januari 2024');
  window.__listIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'];
  window.__gmailStatus = 200;
  window.__log = []; window.__posts = []; window.__opexPosts = [];
  window.__sheet = { exists: false, config: null, seen: [] };
  const real = window.fetch;
  window.fetch = function (url, opts) {
    const u = typeof url === 'string' ? url : url.url;
    const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status }));
    if (u.startsWith('https://gmail.googleapis.com')) {
      window.__log.push(u);
      if (/\/attachments\//.test(u)) return json({ data: window.__pdfData, size: 1000 });
      if (window.__gmailStatus !== 200) return json({ error: 'stub' }, window.__gmailStatus);
      if (u.includes('/profile')) return json({ emailAddress: 'tester@example.com' });
      if (u.includes('/messages?')) return json({ messages: window.__listIds.map(id => ({ id })) });
      return json(window.__msgs[u.match(/messages\/([^?]+)/)[1]]);
    }
    if (u.startsWith('https://notapublic.local/api')) {
      const q = new URL(u).searchParams.get('type');
      const method = (opts && opts.method) || 'GET';
      if (method === 'GET' && q === 'emailimport') return json({ status: 'ok', ...window.__sheet });
      if (method === 'POST') {
        const d = JSON.parse(opts.body);
        if (d.type === 'emailimport') { window.__posts.push(d); window.__sheet = { exists: true, config: d.config, seen: d.seen }; }
        if (d.type === 'opex') window.__opexPosts.push(d);
        if (d.type === 'transfer') (window.__xfrPosts = window.__xfrPosts || []).push(d);
        return json({ status: 'ok' });
      }
      return json({ status: 'ok', rows: [], rules: [], items: [] });
    }
    return real(url, opts);
  };
  Auth.hasGmailScope = () => true; Auth.hasValidToken = () => true; Auth.getAccessToken = async () => 'fake';
  return 'stubs installed';
})();
