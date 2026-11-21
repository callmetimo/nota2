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
    row('2026-10-02', 'CC', 'charge', 'TV CICILAN KE 1 DARI 4', 100)
  ];
  const s = C.buildSeries(rows, g, '2026-10-10', { cc: 25 })[0];
  assert.equal(s.ambiguous, true);
  const c = C.buildSeries(rows, { ...g, closedSeries: ['TV|4'] }, '2026-10-10', { cc: 25 })[0];
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

console.log(passed + ' passed');
