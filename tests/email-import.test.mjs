// Run: node tests/email-import.test.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const dir = path.dirname(fileURLToPath(import.meta.url));
const parserSrc = fs.readFileSync(path.join(dir, '..', 'email-parser.js'), 'utf8');
const importSrc = fs.readFileSync(path.join(dir, '..', 'email-import.js'), 'utf8');

const EP = new Function(parserSrc + '\nreturn EmailParser;')();

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

function createImportContext() {
  const sandbox = {
    console,
    setTimeout: () => {},
    clearTimeout: () => {},
    document: {
      readyState: 'loading',
      addEventListener: () => {},
      getElementById: () => null,
    },
    window: {},
    GmailClient: {
      MAX_FETCH: 10,
      gmailFetch: async () => {},
      messageBody: () => '',
      bodyWithPdf: async () => '',
      pdfParts: () => [],
      listMoneyEmails: async () => [],
    },
    Auth: {
      hasValidToken: () => false,
    },
    allCategories: ['Food & Drink', 'Transportation', 'Shopping', 'Utilities'],
    allPMs: ['BCA', 'Cash', 'CC BCA', 'GoPay', 'CIMB Niaga', 'USD CIMB'],
    getOpexPmCcy: pm => (pm === 'USD CIMB' ? 'USD' : 'IDR'),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(parserSrc + '\nthis.EmailParser = EmailParser;', sandbox);
  vm.runInContext(importSrc + '\nthis.EmailImport = EmailImport;', sandbox);
  return sandbox.EmailImport._internals;
}

// ── foreign-currency debit card on a USD account ─────────────
t('debit card in NZD on a USD account: amount left for the user; in USD it is filled in', () => {
  const i = createImportContext();
  i.config.accounts.push({ key: '557692********64', pm: 'USD CIMB' });
  const body = amt => `No. Kartu Debit\t:\t557692XXXXXXXX64\nNominal Transaksi\t:\t${amt}\nTanggal/Waktu Transaksi\t:\t2026-03-15\nLokasi Transaksi\t:\tMT COOK NZL\nKartu Debit CIMB Niaga`;
  const nzd = i.buildItem(EP.parse(body('92.37 NZD'), ''), 'g1', null);
  assert.equal(nzd.pm, 'USD CIMB');
  assert.equal(nzd.amount, 0);
  assert.equal(nzd.foreign, 'NZD 92.37');
  assert.equal(i.isComplete(nzd), false);
  const usd = i.buildItem(EP.parse(body('12.30 USD'), ''), 'g2', null);
  assert.equal(usd.amount, 12.3);
});

// ── buildQuery ───────────────────────────────────────────────
t('buildQuery: constructs Gmail search query from sources', () => {
  const internals = createImportContext();
  const sources = [
    { id: '1', senders: 'bca@bca.co.id', subject: 'Transaksi', action: 'ask' },
    { id: '2', senders: 'alert@bank.com', subject: 'Notice', action: 'ask' }
  ];
  const q = internals.buildQuery(sources);
  assert.equal(q, '((from:(bca@bca.co.id) subject:("Transaksi")) OR (from:(alert@bank.com) subject:("Notice")))');
});

t('buildQuery: supports multiple comma-separated senders and quotes subject tokens', () => {
  const internals = createImportContext();
  const sources = [
    { id: '1', senders: 'a@bank.com, b@bank.com', subject: 'Monthly "Statement"', action: 'ask' }
  ];
  const q = internals.buildQuery(sources);
  assert.equal(q, '((from:(a@bank.com OR b@bank.com) subject:("Monthly Statement")))');
});

t('buildQuery: returns empty string when all sources are ignored or list is empty', () => {
  const internals = createImportContext();
  assert.equal(internals.buildQuery([]), '');
  assert.equal(internals.buildQuery([
    { id: '1', senders: 'spam@bank.com', subject: 'Promo', action: 'ignore' }
  ]), '');
});

// ── sourceFor ────────────────────────────────────────────────
t('sourceFor: matches by exact email address, domain, or bare word', () => {
  const internals = createImportContext();
  const sources = [
    { id: 'bca-exact', senders: 'bca@bca.co.id', subject: '', keyword: '', action: 'ask' },
    { id: 'grab-domain', senders: '@grab.com', subject: '', keyword: '', action: 'ask' },
    { id: 'mandiri-word', senders: 'mandiri', subject: '', keyword: '', action: 'ask' }
  ];
  assert.equal(internals.sourceFor('bca@bca.co.id', 'Subj', 'Body', sources)?.id, 'bca-exact');
  assert.equal(internals.sourceFor('no-reply@grab.com', 'Subj', 'Body', sources)?.id, 'grab-domain');
  assert.equal(internals.sourceFor('Alerts <mcm@bankmandiri.co.id>', 'Subj', 'Body', sources)?.id, 'mandiri-word');
  assert.equal(internals.sourceFor('other@bank.com', 'Subj', 'Body', sources), null);
});

t('sourceFor: narrows match using subject and body keyword in list order', () => {
  const internals = createImportContext();
  const sources = [
    { id: 'qris', senders: 'bca@bca.co.id', subject: 'Transaksi', keyword: 'QRIS', action: 'ask' },
    { id: 'flazz', senders: 'bca@bca.co.id', subject: 'Transaksi', keyword: 'Flazz', action: 'ask' },
    { id: 'fallback', senders: 'bca@bca.co.id', subject: 'Transaksi', keyword: '', action: 'ask' }
  ];
  assert.equal(internals.sourceFor('bca@bca.co.id', 'Transaksi Berhasil', 'Pembayaran QRIS Rp 50.000', sources)?.id, 'qris');
  assert.equal(internals.sourceFor('bca@bca.co.id', 'Transaksi Berhasil', 'Top Up Flazz Rp 100.000', sources)?.id, 'flazz');
  assert.equal(internals.sourceFor('bca@bca.co.id', 'Transaksi Berhasil', 'Debit Rp 25.000', sources)?.id, 'fallback');
});

// ── normalizeConfig ──────────────────────────────────────────
t('normalizeConfig: sanitizes types, accounts, rules, and sources', () => {
  const internals = createImportContext();
  const raw = {
    types: { qris: 'ask', flazz: 'ignore', invalid: 'discard' },
    accounts: [
      { key: '1234567890', pm: 'BCA' },
      { key: '', pm: 'MissingKey' },
      { key: 'NoPM', pm: '' }
    ],
    rules: [
      { pattern: 'Grab', mode: 'starts', tx: 'Grab Transport', cat: 'Transportation', type: 'expense', pm: 'GoPay' },
      { pattern: '', tx: 'NoPattern' }
    ],
    sources: [
      { id: 's1', name: 'Receipts', senders: 'store@shop.com', reader: 'receipt', action: 'ask', kind: 'expense' },
      { name: 'MissingId' }
    ]
  };
  const norm = internals.normalizeConfig(raw);
  assert.equal(norm.types.qris, 'ask');
  assert.equal(norm.types.flazz, 'ignore');
  assert.equal(norm.types.invalid, undefined);

  assert.equal(norm.accounts.length, 1);
  assert.equal(norm.accounts[0].key, '1234567890');
  assert.equal(norm.accounts[0].pm, 'BCA');

  assert.equal(norm.rules.length, 1);
  assert.equal(norm.rules[0].pattern, 'Grab');
  assert.equal(norm.rules[0].mode, 'starts');
  assert.equal(norm.rules[0].tx, 'Grab Transport');

  assert.equal(norm.sources.length, 1);
  assert.equal(norm.sources[0].id, 's1');
  assert.equal(norm.sources[0].name, 'Receipts');
});

t('normalizeConfig: populates default sources for legacy config without sources array', () => {
  const internals = createImportContext();
  const legacy = {
    types: { qris: 'ask' },
    accounts: [{ key: '8831****14', pm: 'BCA' }]
  };
  const norm = internals.normalizeConfig(legacy);
  assert.ok(norm.sources.length > 0);
  assert.ok(norm.sources.some(s => s.id === 'bca-qris'));
});

// ── buildItem ────────────────────────────────────────────────
t('buildItem: applies merchant rule overrides for tx, category, and payment method', () => {
  const internals = createImportContext();
  internals.config.rules.push({
    pattern: 'Starbucks',
    mode: 'contains',
    tx: 'Starbucks Coffee',
    cat: 'Food & Drink',
    type: 'expense',
    pm: 'CC BCA'
  });
  internals.config.accounts.push({
    key: '8831****14',
    pm: 'BCA'
  });

  const parsed = {
    ref: 'REF987',
    typeId: 'qris',
    typeLabel: 'QRIS payment',
    direction: 'expense',
    date: '2026-10-26',
    amount: 55000,
    merchant: 'Starbucks Mall',
    sourceKey: '8831****14',
    defaultTx: 'Starbucks Mall',
    notes: 'Order #99',
    ccy: 'IDR',
    nativeAmount: null
  };

  const item = internals.buildItem(parsed, 'msg-123', { id: 'bca-qris', cat: 'Shopping', pm: 'BCA' });
  assert.equal(item.gmailId, 'msg-123');
  assert.equal(item.ref, 'REF987');
  assert.equal(item.amount, 55000);
  assert.equal(item.tx, 'Starbucks Coffee'); // from rule
  assert.equal(item.cat, 'Food & Drink');     // from rule
  assert.equal(item.pm, 'CC BCA');           // from rule overrides account PM
  assert.equal(item.notes, 'Order #99');
  assert.equal(item.checked, true);          // complete item is checked
});

t('buildItem: falls back to sourceKey account PM and source defaults when no rule matches', () => {
  const internals = createImportContext();
  internals.config.accounts.push({
    key: '8831****14',
    pm: 'BCA'
  });

  const parsed = {
    ref: '',
    typeId: 'cc',
    typeLabel: 'Credit card purchase',
    direction: 'expense',
    date: '2026-10-25',
    amount: 120000,
    merchant: 'Uniqlo',
    sourceKey: '8831****14',
    defaultTx: 'Uniqlo',
    notes: '',
    ccy: 'IDR',
    nativeAmount: null
  };

  const item = internals.buildItem(parsed, 'msg-456', { id: 'bca-card', cat: 'Shopping', pm: 'CC BCA' });
  assert.equal(item.tx, 'Uniqlo');
  assert.equal(item.cat, 'Shopping'); // from source default
  assert.equal(item.pm, 'BCA');      // from matched account key
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
