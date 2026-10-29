// Run: node tests/email-parser.test.mjs
// Samples mirror the real BCA / CIMB templates but with made-up names, numbers and references.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, '..', 'email-parser.js'), 'utf8');
const EmailParser = new Function(src + '\nreturn EmailParser;')();

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

const qris = `Hello JOHN DOE,
You just made a transaction through myBCA.
Here are the details of your transaction :

Status	:	Successful
Transaction Date	:	26 Oct 2026 08:47:01
Transaction Type	:	QRIS Payment
Payment to	:	WARUNG MAKAN SEJAHTERA
Merchant Location	:	TANGERANG, 15334, ID
Acquirer	:	BCA
Merchant PAN	:	9360001430030713652
Terminal ID	:	A2FJ2423
Source of Fund	:	TAHAPAN XPRESI - 1234****56
Customer PAN	:	9360001410095894142
Total Payment	:	IDR 7,000.00
RRN	:	239384378
Reference No.	:	9527120261026084658014QRS0000000001`;

t('QRIS payment', () => {
  const r = EmailParser.parse(qris);
  assert.equal(r.typeId, 'qris');
  assert.equal(r.direction, 'expense');
  assert.equal(r.date, '2026-10-26');
  assert.equal(r.amount, 7000);
  assert.equal(r.merchant, 'WARUNG MAKAN SEJAHTERA');
  assert.equal(r.defaultTx, 'Warung Makan Sejahtera');
  assert.equal(r.sourceKey, '1234****56');
  assert.equal(r.ref, '9527120261026084658014QRS0000000001');
});

t('Flazz top up', () => {
  const r = EmailParser.parse(`Status	:	Successful
Transaction Date	:	26 Oct 2026 09:30:56
Transaction Type	:	Flazz Top Up
Flazz Card Number	:	0145000000000001
Source of Fund	:	1234****56
Top Up Amount	:	IDR 63,500.00
Reference No.	:	1B5E1A09-46B3-4851-AC64-2BED20BDA9F7`);
  assert.equal(r.typeId, 'flazz');
  assert.equal(r.direction, 'transfer');           // bank account -> Flazz card
  assert.equal(r.amount, 63500);
  assert.equal(r.defaultTx, 'Flazz Top Up');
  assert.equal(r.sourceKey, '1234****56');
  assert.equal(r.targetKey, '0145000000000001');   // tells several Flazz cards apart
  assert.equal(r.ref, '1B5E1A09-46B3-4851-AC64-2BED20BDA9F7');
});

t('Flazz top up without a card number line still parses (target unknown)', () => {
  const r = EmailParser.parse(`Status	:	Successful
Transaction Date	:	26 Oct 2026 09:30:56
Transaction Type	:	Flazz Top Up
Source of Fund	:	1234****56
Top Up Amount	:	IDR 10,000.00`);
  assert.equal(r.direction, 'transfer');
  assert.equal(r.targetKey, '');
  assert.equal(r.amount, 10000);
});

t('Transfer (source written with lowercase x)', () => {
  const r = EmailParser.parse(`Status	:	Successful
Transaction Date	:	24 Oct 2026 10:30:58
Transfer Type	:	Transfer to BCA Account
Source of Fund	:	1234xxxx56
Source Currency	:	IDR - Indonesian Rupiah
Beneficiary Account	:	8831000093
Transfer Currency	:	IDR - Indonesian Rupiah
Beneficiary Name	:	SITI AMINAH
Transfer Amount	:	IDR 5,000.00
Remarks	:	-
Reference No.	:	9527120261024103058893TRF0000000002`);
  assert.equal(r.typeId, 'transfer');
  assert.equal(r.amount, 5000);
  assert.equal(r.merchant, 'SITI AMINAH');
  assert.equal(r.defaultTx, 'Transfer Siti Aminah');
  assert.equal(r.sourceKey, '1234****56');
  assert.equal(r.notes, undefined);
});

t('Credit card bill payment is typed ccbill', () => {
  const r = EmailParser.parse(`Status	:	Successful
Transaction Date	:	09 Oct 2026 09:34:55
Transaction Type	:	Credit Card & Paylater - BCA
Source of Fund	:	1234****56
Card No. / Customer No.	:	0000000015****64
Name	:	JOHN **US ***DOE
Total Bill	:	IDR 14,382,668.00
Total Payment	:	IDR 14,382,668.00
Remaining Bill	:	IDR 0.00
Reference No.	:	9527120261009093455597TPP0000000003`);
  assert.equal(r.typeId, 'ccbill');
  assert.equal(r.amount, 14382668);
});

t('Credit card notice (Indonesian, Rp501.755,00)', () => {
  const r = EmailParser.parse(`Yth. Pemegang Kartu Kredit BCA,

Terima kasih telah bertransaksi menggunakan Kartu Kredit BCA:

Nomor Customer	: 	0000000015000000
Nomor Kartu	: 	472647XXXX4541
Merchant / ATM	: 	DANA Utilities
Jenis Transaksi	: 	E-COMMERCE
Otentikasi	:
TRANSAKSI TANPA OTP

Pada Tanggal	:	26-10-2026 08:26:09 WIB
Sejumlah	:	Rp501.755,00`);
  assert.equal(r.typeId, 'cc');
  assert.equal(r.amount, 501755);
  assert.equal(r.date, '2026-10-26');
  assert.equal(r.merchant, 'DANA Utilities');
  assert.equal(r.sourceKey, '472647****4541');
  assert.equal(r.ref, '');
});

t('Credit card reversal/void notice is a refund (income), not a second expense', () => {
  const body = `Nomor Kartu	: 	472647XXXX4541
Merchant / ATM	: 	GOPAYLINKING
Jenis Transaksi	: 	E-COMMERCE
Pada Tanggal	:	26-10-2026 08:25:23 WIB
Sejumlah	:	Rp1.000,00`;
  const r = EmailParser.parse(body, '', 'Credit Card Reversal/Void Transaction Notification');
  assert.equal(r.typeId, 'ccrefund');
  assert.equal(r.direction, 'income');
  assert.equal(r.amount, 1000);
  assert.equal(r.defaultTx, 'Refund Gopaylinking');
  // the same body with a normal subject stays a purchase
  assert.equal(EmailParser.parse(body, '', 'Credit Card Transaction Notification').typeId, 'cc');
  // body-only detection (no subject available)
  assert.equal(EmailParser.parse(body.replace('E-COMMERCE', 'REVERSAL E-COMMERCE')).typeId, 'ccrefund');
});

t('Credit card notice: empty Otentikasi line does not swallow the next line', () => {
  const r = EmailParser.parse(`Nomor Kartu	: 	472647XXXX4541
Merchant / ATM	: 	GRAND LUCKY BSD
Jenis Transaksi	: 	CONTACTLESS DALAM NEGERI
Otentikasi	:
TRANSAKSI TANPA PIN

Pada Tanggal	:	25-10-2026 17:24:26 WIB
Sejumlah	:	Rp68.100,00`);
  assert.equal(r.amount, 68100);
  assert.equal(r.merchant, 'GRAND LUCKY BSD');
});

t('Credit card notice in foreign currency needs a manual IDR amount', () => {
  const r = EmailParser.parse(`Nomor Kartu	: 	472647XXXX4541
Merchant / ATM	: 	OPENAI SAN FRANCISCO
Jenis Transaksi	: 	E-COMMERCE LUAR NEGERI
Pada Tanggal	:	20-10-2026 01:02:03 WIB
Sejumlah	:	USD 20.00`);
  assert.equal(r.typeId, 'cc');
  assert.equal(r.amount, null);
  assert.equal(r.ccy, 'USD');
  assert.equal(r.nativeAmount, 20);
});

t('Incoming BI-FAST is income', () => {
  const r = EmailParser.parse(`Dengan hormat, kami informasikan bahwa telah terjadi penerimaan dana melalui layanan BIFAST dengan detail sebagai berikut:

Tanggal Transaksi	23/10/2026
Nama Penerima	JOHN DOE
No Rekening Penerima	703100000000
Nominal	Rp. 601.149,00
Nama Pengirim	ACME SERVICES
Bank Pengirim	PT. BANK MANDIRI (PERSERO), TBK`);
  assert.equal(r.typeId, 'bifast');
  assert.equal(r.direction, 'income');
  assert.equal(r.amount, 601149);
  assert.equal(r.date, '2026-10-23');
  assert.equal(r.merchant, 'ACME SERVICES');
  assert.equal(r.sourceKey, '703100000000');
});

t('Label and ": value" on separate lines (credit card bill payment)', () => {
  const r = EmailParser.parse(`Status
: Successful
Transaction Date
: 26 Oct 2026 15:20:25
Transaction Type
: Credit Card & Paylater - BCA
Source of Fund
: 1234****56
Card No. / Customer No.
: 0000000015****64
Name
: JOHN **US ***DOE
Total Bill
: IDR 17,908,449.00
Total Payment
: IDR 1,000,000.00
Remaining Bill
: IDR 16,908,449.00
Reference No.
: 9527120261026152025225TPP0000000004`);
  assert.equal(r.typeId, 'ccbill');
  assert.equal(r.direction, 'transfer');
  assert.equal(r.targetKey, '0000000015****64');
  assert.equal(r.amount, 1000000);
  assert.equal(r.date, '2026-10-26');
  assert.equal(r.sourceKey, '1234****56');
  assert.equal(r.ref, '9527120261026152025225TPP0000000004');
});

t('Separate-line layout also works for QRIS, and a blank value does not swallow the next row', () => {
  const r = EmailParser.parse(`Status
:
Successful
Transaction Date
: 26 Oct 2026 08:47:01
Transaction Type
: QRIS Payment
Payment to
: WARUNG MAKAN SEJAHTERA
Merchant Location
:
Source of Fund
: TAHAPAN XPRESI - 1234****56
Total Payment
: IDR 7,000.00
Reference No.
: REFX`);
  assert.equal(r.typeId, 'qris');
  assert.equal(r.merchant, 'WARUNG MAKAN SEJAHTERA');
  assert.equal(r.amount, 7000);
  assert.equal(EmailParser.field('Merchant Location\n:\nSource of Fund\n: X', ['Merchant Location']), '');
});

t('Mandiri Cash Management BI-FAST credit is income, with the remark as notes', () => {
  const r = EmailParser.parse(`Dear Valued Customer,

We would like to inform you that your transaction for BI FAST Transfer - Mandiri Cash Management is successfully executed.

Date/Time	:	Oct 23, 2026 15:29:35 (GMT +7)
Corporate Name	:	ACME SERVICES
Transaction Type	:	Credit
From Account	:	1220000000000 - IDR - ACME SERVICES
To Account	:	703100000000 - IDR - JOHN DOE
Beneficiary Bank	:	CIMB Niaga
Amount	:	IDR 601,149.00
Charge	:	2,500.00
Reference No	:	-
Remark	:	Oktober fee
Extended Payment Detail	:	Oktober fee 2026`);
  assert.equal(r.typeId, 'bifast');
  assert.equal(r.direction, 'income');
  assert.equal(r.amount, 601149);
  assert.equal(r.date, '2026-10-23');
  assert.equal(r.merchant, 'ACME SERVICES');
  assert.equal(r.sourceKey, '703100000000');
  assert.equal(r.ref, '');
  assert.equal(r.notes, 'Oktober fee 2026');
});

t('Mandiri CM debit notice is not imported', () => {
  assert.equal(EmailParser.parse(`BI FAST Transfer - Mandiri Cash Management is successfully executed.
Transaction Type	:	Debit
To Account	:	1 - IDR - X
Amount	:	IDR 1,000.00`), null);
});

t('HTML table body (label | colon | value cells)', () => {
  const html = `<html><body><p>Hello JOHN,</p><table>
  <tr><td>Status</td><td>:</td><td>Successful</td></tr>
  <tr><td>Transaction Date</td><td>:</td><td>26 Oct 2026 08:47:01</td></tr>
  <tr><td>Transaction Type</td><td>:</td><td>QRIS Payment</td></tr>
  <tr><td>Payment to</td><td>:</td><td>KOPI &amp; ROTI</td></tr>
  <tr><td>Source of Fund</td><td>:</td><td>TAHAPAN - 1234****56</td></tr>
  <tr><td>Total Payment</td><td>:</td><td>IDR 12,500.00</td></tr>
  <tr><td>Reference No.</td><td>:</td><td>REF123</td></tr></table></body></html>`;
  const r = EmailParser.parse(html);
  assert.equal(r.typeId, 'qris');
  assert.equal(r.merchant, 'KOPI & ROTI');
  assert.equal(r.amount, 12500);
  assert.equal(r.ref, 'REF123');
});

t('Failed status is flagged', () => {
  const r = EmailParser.parse(qris.replace('Successful', 'Failed'));
  assert.equal(r.status, 'failed');
});

t('Unrelated email returns null', () => {
  assert.equal(EmailParser.parse('Your monthly newsletter is here. Save 20% today!'), null);
  assert.equal(EmailParser.parse(''), null);
});

t('Unknown BCA type falls back to other', () => {
  const r = EmailParser.parse(`Status	:	Successful
Transaction Date	:	12 Oct 2026 07:00:00
Transaction Type	:	Electricity Payment
Source of Fund	:	1234****56
Total Payment	:	IDR 250,000.00
Reference No.	:	X1`);
  assert.equal(r.typeId, 'other');
  assert.equal(r.amount, 250000);
  assert.equal(r.merchant, 'Electricity Payment');
});

t('parseAmount edge cases', () => {
  const p = s => EmailParser.parseAmount(s).value;
  assert.equal(p('IDR 7,000.00'), 7000);
  assert.equal(p('IDR 14,382,668.00'), 14382668);
  assert.equal(p('Rp501.755,00'), 501755);
  assert.equal(p('Rp. 601.149,00'), 601149);
  assert.equal(p('Rp68.100,00'), 68100);
  assert.equal(p('IDR 1,234'), 1234);
  assert.equal(p('Rp1.234.567'), 1234567);
  assert.equal(p(''), null);
  assert.equal(EmailParser.parseAmount('USD 12,50').value, 12.5);
});

t('parseDate formats', () => {
  assert.equal(EmailParser.parseDate('07 Oct 2026 10:04:11'), '2026-10-07');
  assert.equal(EmailParser.parseDate('25-10-2026 17:57:02 WIB'), '2026-10-25');
  assert.equal(EmailParser.parseDate('23/10/2026'), '2026-10-23');
  assert.equal(EmailParser.parseDate('12 Agu 2026'), '2026-08-12');
  assert.equal(EmailParser.parseDate('nonsense'), '');
});

// ── generic receipt reader (made-up receipt text) ─────────────
const ride = `Terima kasih sudah naik bersama kami
Tanggal\t:\t19 Oct 2026
Tarif dasar\tRp40.000
Biaya layanan\tRp5.000
Diskon\t-Rp10.000
Subtotal\tRp35.000
Total Bayar\tRp45.000
Saldo GoPay\tRp120.000`;

t('generic: picks the labelled total, not subtotal/discount/balance', () => {
  const r = EmailParser.parseGeneric(ride, '2026-10-20', { from: 'Gojek <no-reply@gojek.com>', subject: 'Your receipt' });
  assert.equal(r.amount, 45000);
  assert.equal(r.merchant, 'Gojek');
  assert.equal(r.date, '2026-10-19');
  assert.equal(r.ambiguous, false);
  assert.ok(r.candidates.length >= 5);
});

t('generic: label found on the line before the amount (HTML table)', () => {
  const html = '<table><tr><td>Merchant</td><td>Warung Bu Tini</td></tr><tr><td>Total</td></tr><tr><td>Rp 73.500</td></tr></table>';
  const r = EmailParser.parseGeneric(html, '2026-10-22', { from: 'GoFood <x@gojek.com>' });
  assert.equal(r.amount, 73500);
  assert.equal(r.merchant, 'Warung Bu Tini');
  assert.equal(r.date, '2026-10-22');
});

t('generic: user-chosen label overrides scoring; no amount -> null; sender fallback', () => {
  const r = EmailParser.parseGeneric(ride, '2026-10-20', { from: 'x@gojek.com', amountLabel: 'Subtotal' });
  assert.equal(r.amount, 35000);
  assert.equal(EmailParser.parseGeneric('Hello, no money here', '2026-10-20', {}), null);
  const noName = EmailParser.parseGeneric('Bayar Rp 9.000', '2026-10-20', { from: 'no-reply@grab.com' });
  assert.equal(noName.merchant, 'Grab');
});

// ── receipts in the layouts of real senders (made-up names, ids and amounts) ──
const bluebird = 'Jakarta\nID: 80000001\tMonday, 17 Jun 2024\nHi Sam\nThank you for using Bluebird~\nCost\tRp194.000\nRoute detail\t29,59 km\n\nTransaction Details\tPaid\nFare\n\nRp194.000\n\nDiscount\n\nRp10.000\n\nActual Fare\n\nRp184.000\n\nExtra Cost\n\nRp10.000\n\nTip\n\nRp0\n\nTotal\n\nRp194.000\n\nPayment method\n\ngopay';
const loket = 'Your ticket purchase was successful\nPayment Status\tPAID\nOrder ID\tABCD1234\nOrder Date\t17 Jun 2026 11:02 WIB\nPayment Method\tCredit / Debit Card\nTotal payment: 3.414.918\nSummary\tPrice per Ticket\tQuantity\tTotal\nCAT 2\tRp. 1.650.000\t2\tRp. 3.300.000\nPlatform Fee\nRp. 114.918\nGrand Total\tRp. 3.414.918';
const gojek = 'Senin, 15 Januari 2024\nID pesanan: RB-000000-0000001\nHai Sam,\nMakasih udah pesan GoRide\nTotal dibayar\tRp26.000\nRincian pembayaran\nBiaya perjalanan\t\tRp28.000\nBiaya jasa aplikasi\t\tRp3.000\nDiskon\t\t-Rp5.000\nTotal pembayaran\t\tRp26.000\nDibayar pakai kartu debit/kredit\t\tRp26.000';
const grab = 'Bike Hemat\nHope you enjoyed your ride!\nPicked up on 23 July 2026\nBooking ID: A-0AAAA0AAAA0AAAA\n\nTotal Paid\t\nRP 9.000\nBreakdown\nFare\t\n9.000\nTotal Paid\t\n9.000\nPaid by\nOVO\tOVO\t\n9.000';
const ovo = 'OVO\nwarteg contoh\nPembayaran Berhasil - Rp10.000\n\n23 Apr 2026, 08:33\n\nNama Acquirer\tBCA\nNama Toko\twarteg contoh\nNo. Referensi\tp01-260423-aaaaaaaa\nMetode Pembayaran\tOVO Cash\nPembayaran\tRp10.000\nTip\tRp0\nTotal\tRp10.000';
const agodaConfirm = 'Your booking is now confirmed!\nFor reference, your booking ID is 2000000001.\nPayment for this booking will be collected by the property.\nBooking Information\nPayment details\nRooms\tRp 3,684,786\nTaxes And Fees\tRp 773,711\nTotal Charge\tRp 4,458,497\nPay at The Hotel\tRp 4,458,497\nYou will be charged IDR 4,458,497 by the property in accordance with the cancellation policy.';
const agodaPdf = 'Booking No. 2000000002\nPayment Date August 3, 2026\nHotel Name\tOzzy Hotel\nUSD 131.28\nTotal Charge\nIDR 2,365,873 (USD 131.28)';

t('receipts: the five reference senders are read and score 4 or more', () => {
  const cases = [
    ['bluebird', bluebird, 'MyBluebird Receipt', 'noreply@info.bluebirdgroup.com', 194000, '2024-06-17', 'Bluebirdgroup'],
    ['loket', loket, 'Your ticket purchase was successful', 'Loket.com <noreply@loket.com>', 3414918, '2026-06-17', 'Loket.com'],
    ['gojek', gojek, 'Perjalananmu bersama Gojek pada Senin, 15 Januari 2024', 'Gojek Receipts <no-reply@invoicing.gojek.com>', 26000, '2024-01-15', 'Gojek Receipts'],
    ['grab', grab, 'Your Grab E-Receipt', 'Grab <no-reply@grab.com>', 9000, '2026-07-23', 'Grab'],
    ['ovo', ovo, 'OVO QR Payment Receipt', 'OVO <noreply@ovo.co.id>', 10000, '2026-04-23', 'warteg contoh'],
  ];
  for (const [name, body, subj, from, amount, date, merchant] of cases) {
    const r = EmailParser.parseGeneric(body, '2000-01-01', { from, subject: subj });
    assert.equal(r.amount, amount, name + ' amount');
    assert.equal(r.date, date, name + ' date');
    assert.equal(r.merchant, merchant, name + ' merchant');
    const sc = EmailParser.receiptScore(body, subj, from, '');
    assert.ok(sc.score >= 4 && !sc.unpaid, name + ' score ' + sc.score);
  }
});

t('receipts: booked-but-unpaid is dropped, a paid wording wins, no amount scores 0', () => {
  const r = EmailParser.parseGeneric(agodaConfirm, '2026-09-01', { from: 'Agoda <no-reply@agoda.com>' });
  assert.equal(r.status, 'failed');
  assert.equal(r.unpaid, true);
  assert.equal(EmailParser.receiptScore(agodaConfirm, 'Your booking is now confirmed!', 'no-reply@agoda.com', '').unpaid, true);
  assert.equal(EmailParser.parseGeneric(loket, '2026-06-17', {}).status, 'ok');   // "PAID" beats nothing
  assert.equal(EmailParser.receiptScore('Please find the PDF copy of your receipt', 'Agoda - Customer Receipt', 'no-reply@agoda.com', 'Receipt.pdf').score, 0);
  const promo = 'Big sale this week! Pay only Rp50.000 for selected items. Total savings Rp120.000';
  assert.ok(EmailParser.receiptScore(promo, '50% OFF sale - voucher inside', 'news@shop.com', '').score < 4);
});

t('receipts: PDF text (IDR charge next to a foreign amount) is read', () => {
  const r = EmailParser.parseGeneric(agodaPdf, '2026-08-03', { from: 'Agoda <no-reply@agoda.com>' });
  assert.equal(r.amount, 2365873);
  assert.equal(r.date, '2026-08-03');
  assert.equal(r.merchant, 'Ozzy Hotel');
  assert.ok(EmailParser.receiptScore('Booking No. 2000000002\nTotal Charge\nIDR 2,365,873', 'Agoda - Customer Receipt from Booking ID: 2000000002', 'no-reply@agoda.com', 'Receipt.pdf').score >= 4);
});

t('generic: date from a line with no colon, and never a "date" built across two lines', () => {
  const pdf = 'Address:\nAgoda Company Pte, Ltd.\n36 Robinson Road\nCity House #20-01\nSingapore 068877\nBooking No. 2000000002\nPayment Date August 3, 2026\nTotal Charge\tIDR 2,365,873 (USD 131.28)';
  const r = EmailParser.parseGeneric(pdf, '2026-10-27', { from: 'no-reply@agoda.com' });
  assert.equal(r.date, '2026-08-03');
  assert.equal(r.amount, 2365873);
});

t('subjectPattern keeps the stable start of a subject', () => {
  assert.equal(EmailParser.subjectPattern('Agoda - Customer Receipt from Booking ID: 2038132945'), 'Agoda - Customer Receipt from Booking ID');
  assert.equal(EmailParser.subjectPattern('Perjalananmu bersama Gojek pada Senin, 15 Januari 2024'), 'Perjalananmu bersama Gojek');
  assert.equal(EmailParser.subjectPattern('MyBluebird Receipt'), 'MyBluebird Receipt');
  assert.equal(EmailParser.subjectPattern('Your Grab E-Receipt'), 'Your Grab E-Receipt');
  assert.equal(EmailParser.subjectPattern('Money transfer receipt'), 'Money transfer receipt');
  assert.equal(EmailParser.subjectPattern('Order 12345'), '');
});

t('pdfItemsToText joins a row and tabs wide gaps', () => {
  const txt = EmailParser.pdfItemsToText([
    { str: 'Total', x: 10, y: 700, w: 25 }, { str: 'Charge', x: 38, y: 700, w: 30 }, { str: 'IDR 2,365,873', x: 300, y: 700, w: 70 },
    { str: 'Booking No. 2000000002', x: 10, y: 740, w: 110 },
  ]);
  assert.equal(txt, 'Booking No. 2000000002\nTotal Charge\tIDR 2,365,873');
});

t('senderName uses the main domain, not a subdomain', () => {
  assert.equal(EmailParser.senderName('noreply@info.bluebirdgroup.com'), 'Bluebirdgroup');
  assert.equal(EmailParser.senderName('no-reply@invoicing.gojek.com'), 'Gojek');
  assert.equal(EmailParser.senderName('no-reply@agoda.com'), 'Agoda');
  assert.equal(EmailParser.senderName('mcm@bankmandiri.co.id'), 'Bankmandiri');
});

t('guessKeyword: names the kind of email, not the direction or purchase category', () => {
  assert.equal(EmailParser.guessKeyword(qris), 'QRIS Payment');
  assert.equal(EmailParser.guessKeyword('Transaction Type\t:\tCredit\nAmount\t:\tIDR 1,000.00'), '');
  assert.equal(EmailParser.guessKeyword('Jenis Transaksi\t: \tE-COMMERCE\nSejumlah\t:\tRp1.000,00'), '');
  assert.equal(EmailParser.guessKeyword('no label here'), '');
  assert.equal(EmailParser.senderName('Gojek <no-reply@gojek.com>'), 'Gojek');
  assert.equal(EmailParser.senderName('bca@bca.co.id'), 'Bca');
});

t('generic: ambiguous when nothing looks like a total', () => {
  const r = EmailParser.parseGeneric('Item A Rp10.000\nItem B Rp20.000', '2026-10-20', { from: 'a@b.com' });
  assert.equal(r.ambiguous, true);
  assert.equal(r.candidates.length, 2);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
