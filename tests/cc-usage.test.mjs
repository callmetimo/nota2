// Run: node tests/cc-usage.test.mjs
// Worked examples come from PLAN_CC_USAGE.md section 3.5 (hand-calculated, made-up data).
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, '..', 'cc-usage-core.js'), 'utf8');
const C = new Function(src + '\nreturn CCUsageCore;')();

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}
const row = (date, pm, kind, tx, amount, notes = '') => ({ date, pm, kind, tx, amount, notes, cat: '' });

t('Ex 1: basic, installment, payment, admin fee', () => {
  const g = { pms: ['CC BCA', 'CC BCA Everyday'], permanentLimit: 20000000, pendingAuth: 0 };
  const bd = { 'cc bca': 25, 'cc bca everyday': 25 };
  const rows = [
    row('2026-10-10', 'CC BCA', 'charge', 'Tokopedia', 3000000),
    row('2026-10-20', 'CC BCA Everyday', 'charge', 'Grab', 500000),
    row('2026-10-25', 'CC BCA', 'charge', 'IPHONE CICILAN KE 1 DARI 12', 1000000),
    row('2026-10-25', 'CC BCA', 'charge', 'BIAYA ADMIN', 50000),
    row('2026-10-28', 'CC BCA', 'charge', 'Indomaret', 750000),
    row('2026-11-05', 'CC BCA', 'credit', 'transfer leg', 2000000),
    row('2026-11-15', 'CC BCA Everyday', 'charge', 'Netflix', 250000)
  ];
  const r = C.computeCCUsage(g, rows, '2026-11-20', bd);
  assert.equal(r.statementBalance, 2550000);
  assert.equal(r.unbilled, 1000000);
  assert.equal(r.cycleSpend, 1000000);
  assert.equal(r.installmentRemaining, 11000000);
  assert.equal(r.remaining, 5450000);
  assert.equal(r.overpayment, 0);
  assert.equal(r.overLimit, false);
  assert.equal(r.sameCycle, true);
  assert.deepEqual([r.cycles[0].start, r.cycles[0].end], ['2026-10-26', '2026-11-25']);
  const s = r.series[0];
  assert.deepEqual([s.key, s.xMax, s.amount, s.nextX, s.nextAmount], ['IPHONE|12', 1, 1000000, 2, 1000000]);
});

t('Ex 2: temp limit, anchor, overpayment, pending, legacy and tagged series', () => {
  const g = {
    pms: ['CC BCA'], permanentLimit: 15000000, tempLimit: 25000000, tempLimitExpiry: '2026-11-30',
    anchorDate: '2026-10-25', anchorOutstanding: 4000000, pendingAuth: 150000
  };
  const bd = { 'cc bca': 25 };
  const rows = [
    row('2026-10-20', 'CC BCA', 'charge', 'OLD STUFF', 9999999),
    row('2026-09-25', 'CC BCA', 'charge', 'LAPTOP (3/6)', 2000000),
    row('2026-10-25', 'CC BCA', 'charge', 'LAPTOP (4/6)', 2000000),
    row('2026-10-15', 'CC BCA', 'charge', 'KULKAS CICILAN KE 1 DARI 3', 333333, '[pokok:1000000]'),
    row('2026-11-15', 'CC BCA', 'charge', 'KULKAS CICILAN KE 2 DARI 3', 333333, '[pokok:1000000]'),
    row('2026-11-02', 'CC BCA', 'credit', 'transfer-in leg', 5000000),
    row('2026-11-10', 'CC BCA', 'charge', 'Shopee', 300000)
  ];
  const r = C.computeCCUsage(g, rows, '2026-11-20', bd);
  assert.equal(r.tempActive, true);
  assert.equal(r.activeLimit, 25000000);
  assert.equal(r.statementBalance, 0);
  assert.equal(r.unbilled, 0);
  assert.equal(r.overpayment, 366667);
  assert.equal(r.cycleSpend, 633333);
  const lap = r.series.find(s => s.key === 'LAPTOP|6');
  assert.deepEqual([lap.xMax, lap.remaining, lap.nextX, lap.nextAmount], [4, 4000000, 5, 2000000]);
  const kul = r.series.find(s => s.key === 'KULKAS|3');
  assert.deepEqual([kul.remaining, kul.nextX, kul.nextAmount], [333334, 3, 333334]);
  assert.equal(r.installmentRemaining, 4333334);
  assert.equal(r.remaining, 20883333);
});

t('Ex 3: expired temp, over limit, mixed billing days, Dec to Jan', () => {
  const g = { pms: ['CC A', 'CC B'], permanentLimit: 5000000, tempLimit: 8000000, tempLimitExpiry: '2026-12-31' };
  const bd = { 'cc a': 0, 'cc b': 28 };
  const rows = [
    row('2026-12-30', 'CC B', 'charge', 'Misc', 1200000),
    row('2026-12-31', 'CC A', 'charge', 'Misc', 2500000),
    row('2026-12-28', 'CC B', 'charge', 'TV CICILAN KE 3 DARI 3', 500000),
    row('2026-12-28', 'CC B', 'charge', 'Misc', 1800000),
    row('2027-01-02', 'CC A', 'charge', 'Misc', 400000),
    row('2027-01-05', 'CC A', 'charge', 'Future', 999)
  ];
  const r = C.computeCCUsage(g, rows, '2027-01-03', bd);
  assert.equal(r.tempExpired, true);
  assert.equal(r.tempActive, false);
  assert.equal(r.activeLimit, 5000000);
  assert.equal(r.statementBalance, 4800000);
  assert.equal(r.unbilled, 1600000);
  assert.equal(r.installmentRemaining, 0);
  assert.equal(r.remaining, -1400000);
  assert.equal(r.overLimit, true);
  const a = r.cycles.find(c => c.pm === 'CC A'), b = r.cycles.find(c => c.pm === 'CC B');
  assert.deepEqual([a.start, a.end], ['2027-01-01', '2027-01-31']);
  assert.deepEqual([b.start, b.end], ['2026-12-29', '2027-01-28']);
  assert.equal(r.sameCycle, false);
});

t('cycleRange: bd 30 in Feb, Mar and leap Feb', () => {
  assert.deepEqual(C.cycleRange(2027 * 12 + 1, 30), { start: '2027-01-31', end: '2027-02-28' });
  assert.deepEqual(C.cycleRange(2027 * 12 + 2, 30), { start: '2027-03-01', end: '2027-03-30' });
  assert.equal(C.cycleRange(2028 * 12 + 1, 30).end, '2028-02-29');
});

t('parseInstallment', () => {
  assert.deepEqual(C.parseInstallment('CICILAN BCA KE 01 DARI 12, TOKO'), { x: 1, y: 12, normName: 'TOKO' });
  assert.equal(C.parseInstallment('CICILAN KE 0 DARI 3'), null);
  assert.equal(C.parseInstallment('Groceries'), null);
});

t('duplicate X flags ambiguous; closedSeries zeroes remaining', () => {
  const g = { pms: ['CC'], permanentLimit: 1 };
  const rows = [
    row('2026-10-01', 'CC', 'charge', 'TV CICILAN KE 1 DARI 4', 100),
    row('2026-11-20', 'CC', 'charge', 'TV CICILAN KE 1 DARI 4', 100)
  ];
  const s = C.buildSeries(rows, g, '2026-11-25', { cc: 25 })[0];
  assert.equal(s.ambiguous, true);
  const c = C.buildSeries(rows, { ...g, closedSeries: ['TV|4'] }, '2026-11-25', { cc: 25 })[0];
  assert.equal(c.remaining, 0);
  assert.equal(c.closed, true);
});

t('"(Installment)" rows from the old recurring system continue the numbered series', () => {
  const g = { pms: ['CC'], permanentLimit: 1 };
  const rows = [
    row('2026-08-27', 'CC', 'charge', 'GYM (1/3)', 3000),
    row('2026-09-27', 'CC', 'charge', 'GYM (Installment)', 3000),
    row('2026-10-27', 'CC', 'charge', 'GYM (Installment)', 3000)
  ];
  const s = C.buildSeries(rows, g, '2026-11-20', { cc: 25 });
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].xMax, s[0].remaining], [3, 0]);
  // only one "(Installment)" row so far: the series is at 2 of 3 and owes one more
  const s2 = C.buildSeries(rows.slice(0, 2), g, '2026-11-20', { cc: 25 });
  assert.deepEqual([s2[0].xMax, s2[0].remaining, s2[0].nextX], [2, 3000, 3]);
});

t('same-name purchases stay separate series; the monthly amount decides which one continues', () => {
  const g = { pms: ['CC'], permanentLimit: 1 };
  const rows = [
    row('2026-10-17', 'CC', 'charge', 'CAB (1/3)', 100),
    row('2026-10-30', 'CC', 'charge', 'CAB (1/3)', 200),
    row('2026-11-14', 'CC', 'charge', 'CAB (2/3)', 100),
    row('2026-11-17', 'CC', 'charge', 'CAB (1/3)', 300)
  ];
  const s = C.buildSeries(rows, g, '2026-11-20', { cc: 25 });
  assert.deepEqual(s.map(x => [x.key, x.xMax, x.remaining]), [['CAB|3', 2, 100], ['CAB|3#2', 1, 400], ['CAB|3#3', 1, 600]]);
  assert.ok(s.every(x => x.ambiguous));
});

t('series carries the latest transaction note (without the principal tag) so same-name purchases can be told apart', () => {
  const g = { pms: ['CC'], permanentLimit: 1 };
  const rows = [
    row('2026-10-17', 'CC', 'charge', 'CAB (1/3)', 100, 'Halle - Frankfurt [pokok:300]'),
    row('2026-10-30', 'CC', 'charge', 'CAB (1/3)', 200, 'Prague - Krakow')
  ];
  const s = C.buildSeries(rows, g, '2026-11-20', { cc: 25 });
  assert.deepEqual(s.map(x => x.note), ['Halle - Frankfurt', 'Prague - Krakow']);
});

t('series entries list every row of the series with its instalment number', () => {
  const g = { pms: ['CC'], permanentLimit: 1 };
  const rows = [
    row('2026-09-27', 'CC', 'charge', 'GYM (1/3)', 3000),
    row('2026-10-27', 'CC', 'charge', 'GYM (Installment)', 3000)
  ];
  const s = C.buildSeries(rows, g, '2026-11-20', { cc: 25 })[0];
  assert.deepEqual(s.entries.map(e => [e.x, e.row.date]), [[1, '2026-09-27'], [2, '2026-10-27']]);
  assert.equal(s.entries[1].row, rows[1]);
});

const keys = (rows, today = '2026-12-01') => C.buildSeries(rows, { pms: ['CC'], permanentLimit: 1 }, today, { cc: 25 }).map(s => [s.key, s.xMax, s.remaining]);

t('the same numbered row entered twice within days is one instalment, not a phantom series', () => {
  assert.deepEqual(keys([
    row('2026-09-01', 'CC', 'charge', 'TV (1/3)', 100), row('2026-09-02', 'CC', 'charge', 'TV (1/3)', 100),
    row('2026-10-01', 'CC', 'charge', 'TV (2/3)', 100), row('2026-11-01', 'CC', 'charge', 'TV (3/3)', 100)
  ]), [['TV|3', 3, 0]]);
});

t('rows entered out of order or late still join their series', () => {
  assert.deepEqual(keys([
    row('2026-10-01', 'CC', 'charge', 'TV CICILAN KE 2 DARI 3', 100), row('2026-10-01', 'CC', 'charge', 'TV CICILAN KE 1 DARI 3', 100)
  ]), [['TV|3', 2, 100]]);
  assert.deepEqual(keys([
    row('2026-08-05', 'CC', 'charge', 'TV (1/4)', 100), row('2026-10-05', 'CC', 'charge', 'TV (3/4)', 100), row('2026-10-06', 'CC', 'charge', 'TV (2/4)', 100)
  ]), [['TV|4', 3, 100]]);
});

t('identical purchases weeks apart stay two series; a skipped number is not invented', () => {
  assert.deepEqual(keys([row('2026-09-01', 'CC', 'charge', 'TV (1/3)', 100), row('2026-10-20', 'CC', 'charge', 'TV (1/3)', 100)]),
    [['TV|3', 1, 200], ['TV|3#2', 1, 200]]);
  assert.deepEqual(keys([row('2026-08-05', 'CC', 'charge', 'TV (1/4)', 100), row('2026-10-05', 'CC', 'charge', 'TV (3/4)', 100)]), [['TV|4', 3, 100]]);
});

t('guards: a group without a limit gives 0 not NaN; a tiny principal never goes negative', () => {
  const r = C.computeCCUsage({ pms: ['CC'] }, [], '2026-12-01', { cc: 25 });
  assert.equal(r.activeLimit, 0);
  assert.equal(r.remaining, 0);
  const s = C.buildSeries([row('2026-10-01', 'CC', 'charge', 'X (8/12)', 1, '[pokok:7]')], { pms: ['CC'] }, '2026-12-01', { cc: 25 })[0];
  assert.deepEqual([s.remaining, s.nextAmount], [0, 1]);
});

const TODAY = '2026-11-20';
const norm = (histOpex, txHistory, pms = ['cc']) => C.normalizeRows({ histOpex, txHistory, pmSet: new Set(pms), today: TODAY });
const hrow = (y, m0, d, pm, tx, exp, inc) => ({ y, m: m0, d, pm, tx, ...(exp ? { exp } : {}), ...(inc ? { inc } : {}) });
const local = (date, pm, tx, amount, extra = {}) => ({ id: 1, date, pm, tx, amount, type: 'expense', synced: false, ...extra });

t('normalizeRows: sheet rows become charges and credits with their source reference; other cards and future rows are left out', () => {
  const r = norm([hrow(2026, 9, 10, 'CC', 'Shop', 100), hrow(2026, 9, 11, 'CC', 'Refund', 0, 40), hrow(2026, 9, 12, 'Cash', 'Lunch', 5), hrow(2026, 11, 25, 'CC', 'Later', 9)], []);
  assert.deepEqual(r.map(x => [x.date, x.kind, x.amount, x.ref.source, x.ref.idx]), [['2026-10-10', 'charge', 100, 'hist-opex', 0], ['2026-10-11', 'credit', 40, 'hist-opex', 1]]);
});

t('normalizeRows: a synced local row for an earlier month still counts when the sheet data lacks it (and only once when it has it)', () => {
  const synced = local('2026-10-10', 'CC', 'Old buy', 500, { synced: true });
  assert.equal(norm([], [synced]).length, 1);
  assert.equal(norm([hrow(2026, 9, 10, 'CC', 'Old buy', 500)], [synced]).length, 1);
});

t('normalizeRows: the signature includes the card, so a row on another account never hides a card row', () => {
  const cc = local('2026-10-10', 'CC', 'Lunch', 50);
  assert.equal(norm([hrow(2026, 9, 10, 'Cash', 'Lunch', 50)], [cc]).length, 1);
  assert.equal(norm([hrow(2026, 9, 10, 'CC', 'Lunch', 50)], [cc]).length, 1);
  // two identical local rows, one twin in the sheet: one is a ghost, one is real
  assert.equal(norm([hrow(2026, 9, 10, 'CC', 'Lunch', 50)], [cc, { ...cc, id: 2 }]).filter(x => x.ref.source === 'local-opex').length, 1);
});

t('normalizeRows: transfers use the From-card leg for dedup; a pending one always counts', () => {
  const xfr = { id: 3, date: '2026-10-12', tx: 'Transfer', amount: 200, fromPm: 'Bank', toPm: 'CC', type: 'transfer', synced: true };
  const legs = [hrow(2026, 9, 12, 'Bank', 'Transfer', 200), hrow(2026, 9, 12, 'CC', 'Transfer', 0, 200)];
  assert.equal(norm(legs, [xfr]).filter(x => x.kind === 'credit').length, 1);
  assert.equal(norm([], [{ ...xfr, synced: false }]).filter(x => x.kind === 'credit').length, 1);
  // an unrelated sheet transfer of the same amount from another account must not hide it
  const other = [hrow(2026, 9, 12, 'Cash', 'Transfer', 200), hrow(2026, 9, 12, 'eWallet', 'Transfer', 0, 200)];
  assert.equal(norm(other, [{ ...xfr, synced: false }]).filter(x => x.kind === 'credit').length, 1);
});

t('categoryTotals: charges only, installments get their own slice, no category = Uncategorized, largest first', () => {
  const rows = [
    { ...row('2026-11-01', 'CC', 'charge', 'A', 100), cat: 'Food' },
    { ...row('2026-11-02', 'CC', 'charge', 'B', 300), cat: 'Travel' },
    { ...row('2026-11-03', 'CC', 'charge', 'C', 50), cat: 'Food' },
    row('2026-11-04', 'CC', 'charge', 'D', 70),
    { ...row('2026-11-05', 'CC', 'charge', 'Laptop CICILAN KE 2 DARI 12', 200), cat: 'Shopping' },
    { ...row('2026-11-06', 'CC', 'credit', 'Payment', 900), cat: 'Food' }
  ];
  const out = C.categoryTotals(rows, r => r.tx.includes('CICILAN'));
  assert.deepEqual(out.map(x => [x.key, x.amount]), [['Travel', 300], [C.INST_KEY, 200], ['Food', 150], ['Uncategorized', 70]]);
  assert.deepEqual(C.categoryTotals([]), []);
});

// ── Estimated interest, checked against the real BCA statements of Oct and Nov 2026 (card statement day 25, due day 10).
// [transaction date, amount, 'c' = reversal credit]; the four rows dated 24/25 Oct belong to the October statement date
// in Nota, so they are not in the list (rows on/before the opening-balance date are ignored by design).
const NOV = [
  ['10-26',501755],['10-27',707543],['10-28',21000],['10-29',3500000],['10-30',235848],['10-30',707543,'c'],['10-31',45000],
  ['10-31',22000],['10-31',96000],['11-01',30000],['11-01',30000],['11-01',89200],['11-02',79224],['10-31',15000],['11-02',1420971],
  ['11-04',37000],['11-04',48000],['11-05',259740],['11-05',473657],['11-05',1420971,'c'],['11-05',34500],['11-05',49049],
  ['11-05',78924],['11-06',529760],['11-05',25000],['11-07',23200],['11-08',32780],['11-08',85250],['11-08',118000],['11-08',300000],
  ['11-08',142100],['11-07',37000],['11-10',965430],['11-10',1078542],['11-10',60200],['11-12',15000],['11-14',88310],['11-14',118000],
  ['11-14',272000],['11-14',839015],['11-15',28380],['11-15',103100],['11-15',85000],['11-14',42000],['11-15',120000],['11-16',94500],
  ['11-17',274018],['11-17',279672],['11-17',1478687],['11-17',839015,'c'],['11-19',220000],['11-20',1486165],['11-21',118000],
  ['11-21',22000],['11-21',49000],['11-22',18000],['11-22',39000],['11-22',246100],['11-23',129785]
];
const novRows = () => [
  ...NOV.map(([d, a, k]) => row('2026-' + d, 'CC', k ? 'credit' : 'charge', 'x', a)),
  row('2026-10-26', 'CC', 'credit', 'Payment', 1000000), row('2026-11-07', 'CC', 'credit', 'Payment', 11000000),
  row('2026-11-25', 'CC', 'credit', 'Payment', 11000000)
];
const bcaGroup = { pms: ['CC'], permanentLimit: 30000000, anchorDate: '2026-10-25', anchorOutstanding: 17908449, dueDay: 10, interestRate: 1.75 };

t('interest: the November 2026 BCA statement (350,950 charged) is estimated within 2%', () => {
  const u = C.computeCCUsage(bcaGroup, novRows(), '2026-11-25', { cc: 25 });
  assert.equal(u.interest.state, 'lost');
  assert.equal(u.interest.due, '2026-11-10');
  // Without the 302,600 of 24/25 Oct rows (ignored by design) it is about 1.7% low; with them dated 26 Oct it is within 0.3%.
  assert.ok(Math.abs(u.interest.amount - 350950) < 7000, 'estimate ' + u.interest.amount);
  const full = [...novRows(), row('2026-10-26', 'CC', 'charge', 'x', 23500), row('2026-10-26', 'CC', 'charge', 'x', 68100),
    row('2026-10-26', 'CC', 'charge', 'x', 95500), row('2026-10-26', 'CC', 'charge', 'x', 115500)];
  const uf = C.computeCCUsage(bcaGroup, full, '2026-11-25', { cc: 25 });
  assert.ok(Math.abs(uf.interest.amount - 350950) < 1000, 'full estimate ' + uf.interest.amount);
  // it is part of what is used
  const plain = C.computeCCUsage({ ...bcaGroup, interestRate: 0 }, novRows(), '2026-11-25', { cc: 25 });
  assert.equal(plain.interest.state, 'off');
  assert.equal(plain.usedTotal + u.interest.amount, u.usedTotal);
});

t('interest: paying the whole previous statement by the due date means none; before the due date it is only pending', () => {
  const paid = [row('2026-11-09', 'CC', 'credit', 'Payment', 17908449), row('2026-11-12', 'CC', 'charge', 'Lunch', 50000)];
  assert.equal(C.computeCCUsage(bcaGroup, paid, '2026-11-20', { cc: 25 }).interest.state, 'ok');
  assert.equal(C.computeCCUsage(bcaGroup, paid, '2026-11-20', { cc: 25 }).interest.amount, 0);
  const early = C.computeCCUsage(bcaGroup, [row('2026-11-02', 'CC', 'credit', 'Payment', 1000000)], '2026-11-08', { cc: 25 });
  assert.equal(early.interest.state, 'pending');
  assert.equal(early.interest.amount, 0);
});

t('interest: the bank\'s own interest row switches the estimate off and is not part of the base; setup is optional', () => {
  const recorded = [...novRows(), row('2026-11-25', 'CC', 'charge', 'BIAYA BUNGA', 350950)];
  const u = C.computeCCUsage(bcaGroup, recorded, '2026-11-25', { cc: 25 });
  assert.equal(u.interest.state, 'recorded');
  assert.equal(u.interest.amount, 0);
  assert.equal(C.computeCCUsage({ pms: ['CC'], permanentLimit: 1 }, novRows(), '2026-11-25', { cc: 25 }).interest.state, 'off');
  // October: previous bill paid in full on 9 Oct, before the 10 Oct due date
  const oct = { pms: ['CC'], permanentLimit: 30000000, anchorDate: '2026-09-25', anchorOutstanding: 14382668, dueDay: 10, interestRate: 1.75 };
  const octRows = [row('2026-10-09', 'CC', 'credit', 'Payment', 14382668), row('2026-10-14', 'CC', 'charge', 'Buy', 4436060)];
  assert.equal(C.computeCCUsage(oct, octRows, '2026-10-25', { cc: 25 }).interest.state, 'ok');
});

console.log(passed + ' passed');
