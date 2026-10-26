// Dev-only browser-test stubs for Email Import. Load after tests/e2e-seed.html redirected to the
// app:  eval(await (await fetch('/tests/e2e-stubs.js')).text())
// Fakes Gmail + the Sheets-backed API so no Google sign-in is needed. Fake emails use made-up data.
(() => {
  const b64u = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const mk = (id, body, mime = 'text/plain') => ({ id, internalDate: String(Date.now()),
    payload: { mimeType: 'multipart/alternative', parts: [{ mimeType: mime, body: { data: b64u(body) } }] } });
  const qris = (ref) => `Status\t:\tSuccessful\nTransaction Date\t:\t26 Oct 2026 08:47:01\nTransaction Type\t:\tQRIS Payment\nPayment to\t:\tWARUNG MAKAN SEJAHTERA\nSource of Fund\t:\tTAHAPAN XPRESI - 1234****56\nTotal Payment\t:\tIDR 7,000.00\nReference No.\t:\t${ref}`;
  window.__msgs = {
    m1: mk('m1', qris('REFQRIS1')),
    m2: mk('m2', `Status\t:\tSuccessful\nTransaction Date\t:\t26 Oct 2026 09:30:56\nTransaction Type\t:\tFlazz Top Up\nSource of Fund\t:\t1234****56\nTop Up Amount\t:\tIDR 63,500.00\nReference No.\t:\tREFFLAZZ1`),
    m3: mk('m3', `Nomor Kartu\t: \t472647XXXX4541\nMerchant / ATM\t: \tDANA Utilities\nJenis Transaksi\t: \tE-COMMERCE\nOtentikasi\t: \t\nTRANSAKSI TANPA OTP\n\nPada Tanggal\t:\t26-10-2026 08:26:09 WIB\nSejumlah\t:\tRp501.755,00`),
    m4: mk('m4', `<html><body><table><tr><td>Status</td><td>:</td><td>Successful</td></tr><tr><td>Transaction Date</td><td>:</td><td>09 Oct 2026 09:34:55</td></tr><tr><td>Transaction Type</td><td>:</td><td>Credit Card &amp; Paylater - BCA</td></tr><tr><td>Total Payment</td><td>:</td><td>IDR 14,382,668.00</td></tr><tr><td>Reference No.</td><td>:</td><td>REFBILL1</td></tr></table></body></html>`, 'text/html'),
    m5: mk('m5', 'Weekly promo from your bank! 20% off.'),
    m6: mk('m6', qris('REFQRIS1')),
    m7: mk('m7', `Tanggal Transaksi\t23/10/2026\nNo Rekening Penerima\t703100000000\nNominal\tRp. 601.149,00\nNama Pengirim\tACME SERVICES\npenerimaan dana melalui layanan BIFAST`),
    m8: mk('m8', `Nomor Kartu\t: \t472647XXXX4541\nMerchant / ATM\t: \tWARUNG BAKSO PAK DE\nJenis Transaksi\t: \tCONTACTLESS DALAM NEGERI\nPada Tanggal\t:\t25-10-2026 17:24:26 WIB\nSejumlah\t:\tRp68.100,00`),
  };
  window.__listIds = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
  window.__gmailStatus = 200;
  window.__log = []; window.__posts = []; window.__opexPosts = [];
  window.__sheet = { exists: false, config: null, seen: [] };
  const real = window.fetch;
  window.fetch = function (url, opts) {
    const u = typeof url === 'string' ? url : url.url;
    const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status }));
    if (u.startsWith('https://gmail.googleapis.com')) {
      window.__log.push(u);
      if (window.__gmailStatus !== 200) return json({ error: 'stub' }, window.__gmailStatus);
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
        return json({ status: 'ok' });
      }
      return json({ status: 'ok', rows: [], rules: [], items: [] });
    }
    return real(url, opts);
  };
  Auth.hasGmailScope = () => true; Auth.hasValidToken = () => true; Auth.getAccessToken = async () => 'fake';
  return 'stubs installed';
})();
