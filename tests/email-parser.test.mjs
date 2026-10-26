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
  assert.equal(r.amount, 63500);
  assert.equal(r.defaultTx, 'Flazz Top Up');
  assert.equal(r.sourceKey, '1234****56');
  assert.equal(r.ref, '1B5E1A09-46B3-4851-AC64-2BED20BDA9F7');
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

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
