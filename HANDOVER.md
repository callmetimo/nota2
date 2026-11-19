# Handover: Nota architecture-review fixes — Batch 3 continuation

**Written by:** Claude (Sonnet 5), 2026-11-19, because the user's Claude weekly usage ran out mid-batch.
**For:** whichever assistant picks this up next (expected: Antigravity / Gemini Flash 3.8).
**Repo:** `G:\My Drive\AI Tools\Claude Projects\Nota` — git repo, `main` branch, clean working tree as of this writing.
**Current app version:** `v4.106` (constant `APP_VERSION` in `app-core.js`).

Delete this file once the work it describes is finished and merged — it's a handoff note, not permanent project documentation.

---

## 1. What this project is

**Nota** is a vanilla-JS personal finance PWA, no build step, no bundler. Each user's data lives in a Google Sheet created by the app in their own Drive (`drive.file` OAuth scope). It deploys to GitHub Pages via `.github/workflows/pages.yml`. There is **no backend server** — `data-store.js` in the browser talks directly to the Google Sheets REST API and emulates what used to be an Apps Script backend.

### File layout (as of v4.87–v4.106 — this has changed recently, see §3)

```
index.html          — markup + CSS only now (2,034 lines). Inline <script> count: 2 (first-tap escalation, tiny tail script).
app-core.js          — the former ~3,400-line inline <script> from index.html. State, API layer, tx entry, search, boot.
data-networth.js     — net-worth/asset-classification math + computeCCMonitor() (pure functions, no DOM).
config-settings.js   — config CRUD, load-time hydration, Settings page, item overlay. MUST load first of the split-off ui-settings files.
accounts.js          — account-balance engine, balance cards, account page, CC billing helpers (getCCBillingDate etc.).
goals.js             — savings goals CRUD + asset valuation.
recurring.js         — recurring transactions: rules, due-check, push/merge, list/edit UI.
ui-settings.js       — LEFTOVERS only now (54 lines): switchTabFromMore, openFABAction, fetchCurrentMonthFresh, global error listener.
email-parser.js      — pure parsing (bank email templates + generic receipt reader). Has its own test suite.
gmail-client.js       — Gmail REST calls, MIME decoding, pdf.js-based PDF text extraction. Loads before email-import.js.
email-import.js      — Gmail rules/settings/state, review popup, Settings page for email import.
ui-calendar.js       — Home calendar rendering.
ui-insights.js       — Insights tabs (weekly/monthly/yearly/category), net-worth rendering, FX fetch.
auth.js              — Google Identity Services sign-in. FROZEN — see §5.
data-store.js        — Sheets REST wrapper emulating the old Apps Script router (handleRequest).
sheets-client.js     — thin fetch wrapper over the Sheets/Drive REST APIs, with its own AbortController timeout.
config.js            — OAuth client ID (injected by CI).
sw.js                — service worker. Precaches all local scripts; cache name keyed to a BUILD id.
tests/
  e2e-seed.html      — seeds localStorage as a "returning user", redirects to ../index.html. Dev-only.
  e2e-stubs.js       — stubs Gmail + the Sheets-backed API (window.fetch override) for browser testing with no real sign-in.
  (email-parser.test.mjs is in the repo root, not here — run with `node tests/email-parser.test.mjs`... actually check: `node tests/email-parser.test.mjs` from repo root)
```

Script load order in `index.html` (this order matters, don't reorder without reading why):
```
config.js → sheets-client.js → data-store.js → auth.js
  → [first-tap sign-in escalation inline script — do not move]
  → app-core.js
  → Chart.js (async, from CDN)
  → data-networth.js → config-settings.js → accounts.js → goals.js → recurring.js → ui-settings.js
  → email-parser.js → gmail-client.js → email-import.js
  → ui-calendar.js → ui-insights.js
  → [tiny tail inline script]
```
All files are **classic scripts sharing one global scope** (no modules, no bundler). A `function foo(){}` or `let x` at the top level of any file is a plain global visible to every file loaded after it. `fetchWithTimeout`, `esc`, `apiGet`, `todayISO()`, etc. are all defined in `app-core.js` and used everywhere downstream.

---

## 2. How this review started, and the ground rules that have applied throughout

A prior session ran a full architecture review (6 parallel Sonnet readers, one per area) and produced a ranked list of ~40 findings across 5 "batches":

1. **Security and data loss** (items 1–10) — done.
2. **Resilience** (items 11–17) — done.
3. **Correctness** (items 19–28) — **in progress, this is where you're picking up.**
4. **Tooling and docs** (items 29–34) — not started (except item 33, done early as part of the v4.87/v4.88 refactor).
5. **Refactor** (items 35–40) — items 38, 39, 40 done (by a different session, Opus); 35, 36, 37 not started.

(Item 18 doesn't exist — the batch numbering has a gap; don't go looking for it.)

**Rules that were followed for every single fix in this review, and that you must keep following:**

1. **One commit per item.** Small, scoped, revertable.
2. **Bump `APP_VERSION` in `app-core.js` with every commit** (e.g. `v4.106` → `v4.107`). It's a plain string constant near the top of the file. Follow the existing `v4.NNN` format — do **not** round up to `v5.00`, this bit a previous session (see commit `0107177`'s fix-up).
3. **Re-read the actual current file before editing.** Files have moved and line numbers from the original review are stale. Always `grep`/re-locate the real current location before touching anything.
4. **`node --check <file>.js` after every edit**, before considering it done.
5. **Verify behaviorally, not just by reading.** This is the single most important habit in this whole review. For every fix:
   - Reproduce the bug for real first (run the old code against a concrete scenario and show it fail).
   - Apply the fix.
   - Re-run the same scenario and show it now passes.
   - Where practical, keep the *exact old code* around just long enough to run it in parallel as a negative control, proving the "before" state really was broken (not just assumed broken from reading).
   - Several fixes in this review turned out to be more (or differently) severe than the one-line description suggested, purely because of this habit — e.g. item 20 (`setIT`) looked like a cosmetic label bug ("shows '3 Accounts'") but actually made Insights silently show **zero data** by default; that was only caught by actually calling `getRows()` and checking the count.
   - One fix (`fetchWithTimeout`, item 13) went through two attempts: the first "obvious" rewrite quietly introduced a real regression (the timeout no longer fired if the underlying `fetch()` ignored its abort signal), caught only because the test used an adversarial mock instead of a cooperative one. Read that commit message (`58d1bdb`) before touching any shared primitive — it's the cautionary tale for this whole project.
6. **Commit messages are long and explain the bug mechanism, the fix, and exactly what was verified and how.** Look at any commit from `b495b10` onward for the expected shape. This isn't optional politeness — the next reader (possibly you, possibly someone auditing later) needs to be able to tell "verified" from "assumed" at a glance.
7. **Push after every commit** (`git push origin main`). Don't batch pushes.
8. **Don't touch `auth.js`, the first-tap escalation script in `index.html`, or the stuck-sign-in banner logic** without being explicitly asked and without a real-device recording to validate against. See §5. None of the remaining batch-3/4/5 items touch this area, but if you ever find yourself about to edit something in that zone, stop and ask the user first.

### The testing setup (how "verify behaviorally" actually works in this repo)

There's no real Google account available in this environment. The pattern used throughout:

1. Start the dev server: it's `python3 serve.py` (threaded — was fixed earlier because the original single-threaded version silently dropped scripts under load; see commit history around "v4.85" if curious). If you have a `preview_start`-style tool pointed at `.claude/launch.json`, the config name is `"notapublic-dev"`, port 8010. Otherwise just run `python3 serve.py` from the repo root (port defaults via `PORT` env var, see the file).
2. Navigate to `http://localhost:8010/tests/e2e-seed.html` — this seeds a fake "returning user" localStorage state and redirects to `index.html`. It refuses to run anywhere but localhost.
3. To stub Gmail + the Sheets-backed API (so you can exercise email-import flows, or `fetchCurrentMonth`, etc. without a real sign-in), `eval` the contents of `/tests/e2e-stubs.js` in the page: `eval(await (await fetch('/tests/e2e-stubs.js')).text())`. This overrides `window.fetch` for `gmail.googleapis.com` and `https://notapublic.local/api` (the fake Apps-Script-URL that `app-core.js`'s own `window.fetch` monkeypatch routes into `DataStore.handleRequest`).
4. For testing `data-store.js` functions directly (most of them are private closures, only `handleRequest` etc. are exported), the pattern used throughout this review is to **fetch the file fresh and `eval` it into an isolated global**, rebinding `Auth`/`SheetsClient` to stubs, e.g.:
   ```js
   const src = await (await fetch('/data-store.js?nocache=' + Math.random())).text();
   window.__FreshAuth = { ready: Promise.resolve(), getAccessToken: async () => 'fake' };
   window.__FreshSheetsClient = { getValues: async () => ({values:[]}), /* ...stub whatever you need... */ };
   const wrapped = src.replace('const DataStore = (() => {', 'window.FreshDataStore = (() => {')
                       .replace(/\bAuth\b/g, '__FreshAuth').replace(/\bSheetsClient\b/g, '__FreshSheetsClient');
   (0, eval)(wrapped);
   await window.FreshDataStore.setSpreadsheetId('TESTSHEET');
   ```
   This sidesteps the private-closure problem entirely and lets you call any internal function via `handleRequest`.
5. **Known gotcha, cost me real time twice:** `index.html`'s script tags are `<script src="./file.js?v=__BUILD__">`. In this dev/unbuilt environment, `__BUILD__` is never substituted (that only happens in the GitHub Actions deploy), so the URL is a **fixed literal string** on every page load. The *browser's own HTTP cache* (not just the Service Worker Cache API) can and does cache that exact URL across navigations, independent of anything you do with `caches.delete()` / `navigator.serviceWorker.unregister()`. Symptom: you edit a file, clear the SW cache, navigate again, and the live page is **still running the pre-edit code** — `someFunction.toString()` shows the old body. Fix: either (a) fetch the file fresh with `{cache:'no-store'}` and `(0, eval)()` it directly into the page to overwrite the stale definitions (this is what was done throughout), or (b) just always double-check with `yourFunction.toString()` or by fetching the file with a cache-busting query before trusting a test result. **Don't lose an hour to this like a previous session did — check first.**
6. Parser unit tests: `node tests/email-parser.test.mjs` from the repo root (or wherever it actually sits — verify with `find`/`ls`). 34 tests currently, all passing as of `v4.106`. Re-run after any change that touches `email-parser.js`.

---

## 3. Everything already done (so you don't redo it or get confused by line numbers that no longer match the original review)

Commits `ae725fc` through `9797c36` (v4.82 → v4.106), in order, each on `main`, already pushed:

- **Refactors (structure only, behavior-preserving, each verified byte-identical or behaviorally equivalent):** net-worth math → `data-networth.js`; CC-monitor math → `computeCCMonitor()`; `ui-settings.js` split 4 ways; `gmail-client.js` extracted from the email-import IIFE; the whole inline `<script>` core of `index.html` → `app-core.js`.
- **Security:** pdf.js bumped past CVE-2024-4367 (3.11.174 → 4.10.38, rewritten for the ESM-only 4.x build, hash-verified against the live CDN download); an email-triggered XSS in the amount-picker closed (missing `&`-escaping).
- **Cache-busting:** `index.html` script tags now carry `?v=<BUILD>`, `sw.js` derives its cache name from the same constant, CI substitutes the real commit SHA at deploy time.
- **Data-loss / race-condition fixes:** retry-queue double-POST guard; row-identity verification before every sheet edit/delete (`data-store.js`); sign-out now clears the whole `nota*` localStorage namespace with an unsynced-transactions warning; `_applyLocalEdit` no longer collapses identical sibling transactions; length caps on recurring/config sheet writes.
- **Resilience (batch 2, items 11–17, ALL DONE):** every remaining raw `fetch()` replaced with `fetchWithTimeout` (8 sites across 7 files); `fetchFxRates` no longer mistakes a total outage for success; `fetchWithTimeout` itself now clears its timer and actually cancels the request (two-attempt fix, see §2 point 5); `saveConfigToServer` now detects server-side save failures instead of assuming success; `showToast` no longer lets a stale timer clear a newer toast early; `notaSyncFailed` event now dispatched on background-refresh failure (infrastructure only, no UI consumer yet — that's a deliberate future item, not a bug); the dead cold-start retry-with-backoff is now reachable.
- **Correctness (batch 3, items 19–22 DONE, 23–28 REMAINING — see §4):**
  - **19 DONE:** 7 sites of `new Date().toISOString().slice(0,10)` (UTC) replaced with local-date logic (`todayISO()` or equivalent), across `ui-calendar.js`, `app-core.js`, `config-settings.js`, `accounts.js`. This was a real bug for users in WIB (UTC+7): "today" was wrong for 7 hours a day. Verified against the actual browser timezone, which happens to be `Asia/Jakarta` in this dev environment — useful, lean on it.
  - **20 DONE:** `setIT()` was setting the Insights account-filter variables to the *string* `'all'` instead of the empty array `[]` that every consumer expects. This silently made Weekly/Monthly/Yearly/Category show **zero data** by default (not just a wrong label) until the user manually touched a filter. Fixed.
  - **21 DONE:** 4 copy-pasted `txJson` builders in `ui-calendar.js` (one per rendering function) had drifted — two of four were missing the `'transfer'` type mapping, `future`, `synced`, and one of those two was also missing `nativeAmount`/`ccy`. Merged into one `calTxJson()` helper (defined right after `calIsPlainExpense` near the top of the file). Also fixed: the busiest of the four builders (`calBuildCurrentMonthHiddenWeeks` — it draws every week of the current month *except* the highlighted "current week" row, so it's the most commonly hit path) was computing its day total with a weaker filter that still counted Transfer/Investment/credit-card spend; now uses `calIsPlainExpense` like the other three.
  - **22 DONE:** `rescueMisread()` in `email-import.js` was re-offering (un-deduping) every already-handled `'cc'` (plain card purchase), `'ccrefund'`, and `'custom'` (generic receipt) email on every `EmailParser.VERSION` bump, because those three types always parse with an empty `ref` and the existing dedup check required one. Fixed by making those three types skip release instead of falling through to "not handled". `'ccbill'` (card bill payments) is deliberately unchanged — it's supposed to always release, per the existing comment, since those were historically silently ignored.

**Everything above is pushed to `origin/main`. Working tree is clean. `app-core.js`'s `APP_VERSION` is `'v4.106'`.**

---

## 4. What's left — do these next, in this order, one commit each

All of these were identified by the original architecture review. Line numbers below are from the **original pre-refactor review** (stale!) where given — always re-`grep` the current file to find the real location before editing. I was mid-investigation of item 23 when I had to stop; I'd located the function but made zero edits.

### Batch 3 remainder (correctness)

**23. `highlightMatches` breaks HTML entities when the search query matches entity text (e.g. searching "amp").**
Current location: `app-core.js`, function `highlightMatches(text, query)` — found via `grep -n "function highlightMatches" app-core.js` (was at line 2849 as of `v4.106`, will shift as you edit other things first).
```js
function highlightMatches(text, query) {
  const safe = esc(text);
  if (!query) return safe;
  const regex = new RegExp(`(${esc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return safe.replace(regex, '<span class="highlight">$1</span>');
}
```
**The bug:** it escapes `text` to HTML entities *first* (`esc(text)` turns `&` into `&amp;`, `<` into `&lt;`, etc.), *then* runs the highlight regex against the **already-escaped** string. If the user's search query is something like `"amp"`, `"lt"`, `"gt"`, `"quot"`, or `"39"`, the regex can match *inside* an entity that resulted from escaping a literal `&`, `<`, `>`, `"`, or `'` in the original text — e.g. if `text` contains a literal `&` character, `esc(text)` turns it into the 5 characters `&amp;`, and searching for `"amp"` would match and wrap just the `amp` portion in `<span class="highlight">`, producing `&<span class="highlight">amp</span>;` in the final HTML — which the browser would then try to parse as `&` + a highlighted span containing literal text "amp" + `;`, breaking the intended entity and corrupting the display (and potentially, depending on what's around it, something worse — verify what calls this and with what kind of text before concluding severity).
**The fix (per the original review's suggested shape):** highlight on the **raw** (unescaped) text first to find match boundaries, then escape each resulting piece (the before-match, the match itself, the after-match) *separately*, so escaping never happens after splitting has already happened, and a literal `&`/`<`/etc. in the source text is escaped exactly once, correctly, regardless of where the highlighted span boundaries fall. A workable approach: split `text` on the regex (using a capturing group so `.split()` keeps the matched pieces), then map each piece through `esc()`, escaping the matched pieces too, then wrap only the pieces that came from the capture group in the highlight span, then join.
**Verify it:** construct `highlightMatches("Pay & Save amp co", "amp")` (where `"amp"` appears both inside a real word *and* would appear if `&` got escaped) and confirm: (a) the real `&` renders as `&amp;` and is *not* itself highlighted or split, (b) the literal "amp" inside "Pay & Save" — wait, construct a cleaner test case: `text = "A & B"`, `query = "amp"`. Old code: `esc("A & B")` → `"A &amp; B"`, then regex `/amp/gi` matches inside `&amp;` → broken output. New code should produce `"A &amp; B"` with the ampersand intact and *not* highlighted (since "amp" only appears as an artifact of escaping, not in the real source text — the right behavior is that this string doesn't contain "amp" as real text, so nothing should be highlighted at all). Also test a query that legitimately appears in the raw text, with a `&` elsewhere in the same string, to confirm highlighting still works when it's supposed to.
Find callers of `highlightMatches` first (`grep -rn "highlightMatches(" *.js`) to understand what kind of text actually flows through this (search results in the transaction search page, most likely) so you know what a realistic test string looks like.

**24. `openSearchInvestEdit` doesn't handle the `'local-invest'` source.**
Current location: `app-core.js`, function `openSearchInvestEdit(source, idx)` — I'd just found it when interrupted:
```js
function openSearchInvestEdit(source, idx) {
  const row = source === 'live-invest' ? (liveInvest || [])[idx]
            : source === 'hist-invest' ? (HIST.invest || [])[idx]
            : null;
```
**The bug:** a search result item can be tagged with source `'local-invest'` (an unsynced, locally-queued investment — check where search results get their `source` field; likely in a `performSearch`/`renderSearchOrMonitor`-style function, grep for `'local-invest'` as a string literal to find where it's produced) but `openSearchInvestEdit` only knows about `'live-invest'` and `'hist-invest'`. Tapping a local-invest search result to edit it silently does nothing (`row` stays `null`, function presumably returns early or no-ops).
**The fix:** add a third branch: `source === 'local-invest' ? (investHistory || [])[idx] : null`. Confirm the variable name is `investHistory` (it is, per earlier work in this review — it's the array of locally-queued/unsynced investment rows, declared in `app-core.js`). Also check what `openEditInvestOverlay` (the function this presumably calls next) expects as the row shape for a local/unsynced row vs a synced one — a local row may be missing `rowIndex`/`id` that the synced-row code paths assume exist; read `openEditInvestOverlay` before assuming the one-line fix is sufficient.
**Verify it:** seed `investHistory` with an unsynced row, seed a search result referencing it with `source:'local-invest'`, call `openSearchInvestEdit('local-invest', 0)`, and confirm the edit overlay actually opens with that row's data (check `document.getElementById('inputOverlay').classList.contains('open')` and that the form fields got populated), instead of silently doing nothing.

**25. The inactivity timer wipes `notapub_invest_v2`, contradicting its own comment.**
Current location: `app-core.js`, inside the `DOMContentLoaded` boot handler, an inactivity-timeout IIFE. Grep for `notapub_invest_v2` to find it (there will be 2-3 hits — the `let investHistory = JSON.parse(localStorage.getItem('notapub_invest_v2')...)` declaration, `saveLocal()`'s `localStorage.setItem('notapub_invest_v2', ...)`, and the inactivity-wipe list).
```js
function onInactive() {
  // Clear sensitive cached data, then reload to fresh state.
  // nota_queue_v2 and nota_history_v2 are intentionally excluded: they hold
  // unsynced transactions that have not reached the server yet — deleting them
  // causes permanent data loss with no recovery path.
  [curMonthCacheKey(),
   'notapub_invest_v2', 'notapub_fx', 'notapub_prices']
    .forEach(k => localStorage.removeItem(k));
  location.reload();
}
```
**The bug:** the comment explicitly says unsynced data must never be wiped because it causes permanent data loss, and explicitly protects `nota_queue_v2`/`nota_history_v2` by name — but `notapub_invest_v2` (which is `investHistory`, the exact same *kind* of data for investments as `txHistory`/`notapub_history_v2` is for regular transactions — i.e., it can hold **unsynced** investment rows sitting in the queue) is wiped. This is the same data-loss bug class as `notapub_history_v2` would be if it were on that list — an unsynced Buy/Sell sitting in `investHistory` (and therefore also referenced from `queue`, per how `submitInvest`/`addAndSyncInvest` work — check `app-core.js`'s `submitInvest`) gets its *display* copy deleted on a 30-minute idle timeout, even though the actual pending sync attempt in `queue` survives. Depending on what reads `investHistory` vs `queue` after a reload, this could mean: the user's queued investment sync still happens in the background eventually, but the transaction *disappears from view* (e.g. from Search, from Account balances if those partly read `investHistory`) until it has fully synced and been re-merged from the sheet — which is confusing and looks like data loss even if it technically isn't fully lost. Confirm by reading how `investHistory` and `queue` interact (search for all reads of `investHistory`) before deciding exactly how severe this is — but regardless of exact severity, it directly contradicts the comment's own stated intent, which is reason enough to fix.
**The fix:** remove `'notapub_invest_v2'` from the wipe list. (Minimal, safe, matches the existing comment's clearly stated intent.)
**Verify it:** seed `investHistory` with an unsynced row (`synced:false`), simulate the inactivity timeout firing (you likely can't easily fast-forward the real 30-minute `setTimeout`, so instead either (a) extract the `onInactive` function body the same way item 17's fix was verified earlier in this review — fetch the live file, regex out the function body, eval it standalone with spied `localStorage`/`location.reload` — or (b) just directly test that the key is absent from the literal array in the source after your edit, plus a quick manual call to a refactored-out `onInactive`-equivalent if one exists). At minimum, grep the fixed file to confirm `'notapub_invest_v2'` no longer appears in that array literal, and run the real reload path if you can stub `location.reload` to not actually navigate away mid-test.

**26. New-sheet Config header/seed writes only `A:L` (12 columns) but rows are serialized with 14 columns.**
Current location: `data-store.js`. Grep for `ensureConfigSheetExists` and `serializeConfigRow`.
**The bug (from the original review, re-verify current line numbers and exact column letters before trusting this description — it may already be partially stale):** a brand-new user's Config sheet gets its header row and its initial seed written with a range like `A1:L1` / `A:L` (12 columns), but `serializeConfigRow()` (used elsewhere for ongoing writes) produces a 14-element array (through column `N`). The original review noted this "self-heals" the moment `ensureConfigSheetExists()` runs again on the first `handleGetConfig()` call (which apparently does correctly write `A1:N1`), but the *very first* write for a brand-new account may attempt to write a 14-wide array into a nominally 12-wide range, which the Sheets API may reject with a 400 error, or silently truncate — the original reviewer was not fully certain which, and flagged it as "worth a test with a fresh account."
**What to actually do:** first, re-read `ensureConfigSheetExists()` and the two Config-seeding call sites (`serializeConfigRow` is called from somewhere during initial bootstrap in addition to `handleConfig`'s `saveAll` — grep for all callers of `serializeConfigRow`) to confirm the *current* column counts on each side. The fix, if the bug is confirmed, is almost certainly just widening the literal range strings and/or the header-array literal from `L`/12-wide to `N`/14-wide, to match `serializeConfigRow`'s actual output width, wherever they currently disagree. **Do not guess at this one — read both sides carefully first, since the original reviewer themselves weren't 100% sure of the exact failure mode.**
**Verify it:** this is the one item in this batch that's hardest to verify without a real (or realistically faked) fresh Google Sheet. Use the "fresh isolated eval" technique from §2 point 4: stub `SheetsClient.updateValues`/`appendValues` to **actually check the width of the `values` array against the width implied by the `range` string you're being asked to write** (e.g. parse `A1:L1` → 12 columns, assert `values[0].length <= 12` and throw/log loudly if not), then run through the actual bootstrap-a-new-sheet code path and see whether your stub's assertion fires. If it does, you've reproduced the bug; widen the range to match, re-run, confirm the assertion no longer fires.

**27. Parser regex fixes in `email-parser.js` (small, one test each — can be one commit per sub-fix, or bundle all four into one commit with four verified cases, your call, but history in this review leans toward one commit per distinct behavior change where practical):**
- **`BAD_LABEL`'s `fee` match is unbounded** — it should be word-bounded (`\bfee\b`) so a merchant/label containing "fee" as part of a longer word (e.g. "Coffee") doesn't get incorrectly penalized/excluded by the generic receipt reader's scoring. Grep `BAD_LABEL` in `email-parser.js`.
- **`iso()`'s date parser accepts invalid dates** like 31 February — add a real days-in-month check (e.g. construct a `Date`, then verify `getDate()` still matches what was asked for, which is the standard trick for detecting JS's silent date-rollover behavior).
- **`parseAmount` ignores a leading minus sign** — so a refund or a discount line (which banks often show as a negative amount) gets read as positive. Grep `function parseAmount` in `email-parser.js`; the fix is almost certainly just not stripping/ignoring a leading `-` before parsing the digits, and propagating the sign through to the returned number.
- **Entity decoding order is wrong**: `decodeEntities` (or whatever the actual function is named — grep for where `&amp;`/`&lt;` get decoded in `email-parser.js`, likely in `htmlToText`) decodes `&amp;` *before* `&lt;`/`&gt;`/etc., which means a double-encoded `&amp;lt;` (which some mail clients produce) gets decoded in the wrong order and can produce wrong output, or conversely a literal `&lt;` meant to stay as text could get corrupted. Decode `&lt;`/`&gt;`/`&quot;`/`&#39;` etc. *first*, then `&amp;` *last*, so a literal ampersand that was itself part of an already-decoded entity reference doesn't get re-interpreted.

**Verify all four** by adding (or running mentally against, then formalizing as) a test case each in `tests/email-parser.test.mjs`, following the existing test file's style (34 tests currently, each a plain assertion with a descriptive name — `node tests/email-parser.test.mjs` to run). Add new test cases rather than just checking manually in the console, since this file is the actual regression-test surface for `email-parser.js` and the existing 34 tests must still all pass afterward.

**28. `escJsAttr` is missing at a flagged call site (originally cited as `ui-insights.js:1394`).**
This exact line number is almost certainly stale now (ui-insights.js has shrunk significantly since the original review, with CC-monitor math extracted to `data-networth.js`). **You need to re-find this.** The original finding was: an inline `onclick` handler does `esc(type).replace(/'/g,"\\'")` — which is a no-op/ineffective escape, because `esc()` already turns a literal `'` into the HTML entity `&#39;` before the `.replace(/'/g, "\\'")` regex ever runs (there's no literal `'` character left in the string for that regex to find — the browser only decodes `&#39;` back into `'` *after* HTML-parsing the attribute, which happens *before* the inline JS ever executes, so a value containing an apostrophe could still end up breaking the inline handler's JS string literal). The fix is to use `escJsAttr()` instead (defined in `app-core.js` — check its current exact name/behavior with `grep -n "function escJsAttr" app-core.js`; it's designed exactly for this situation: values that need to be safe both as an HTML attribute *and* as a JS string literal inside that attribute).
**To find the current location:** `grep -rn "esc(.*)\.replace(/'/g" *.js` across the whole repo — this exact anti-pattern (`esc(something).replace(/'/g, ...)`) is distinctive enough that it should only match the one real bug site (plus possibly nothing, if it's already been incidentally fixed by one of the refactors — check carefully, don't assume it's still there untouched).
**Verify it** the same way item 1 (the email-import XSS fix, commit `5bc72fd`) was verified earlier in this review: construct a string containing a literal `'` (or better, a string that exploits the exact double-escaping gap — read commit `5bc72fd`'s message for the precise technique, it's directly applicable here), build the actual HTML the real code would produce, parse it into a real DOM element (`div.innerHTML = ...`), read back `element.getAttribute('onclick')` (which gives you the real, HTML-entity-decoded string the browser would hand to its JS parser), and confirm the fixed version produces a syntactically safe single string argument while the old version would produce a string that breaks out early.

### Batch 4 (tooling and docs) — do after batch 3

**29.** Add a CI gate in `.github/workflows/pages.yml`: run `node --check *.js` (or equivalent — check all `.js` files individually, since `node --check` doesn't glob) and `node tests/email-parser.test.mjs` as steps *before* the existing deploy steps, so a syntax error or a parser regression can't reach production. Look at the existing `pages.yml` structure (steps: Checkout, Setup Pages, Inject Client ID, Inject build id, Upload artifact, Deploy) — add a new step after "Inject build id" (or before it, doesn't matter much) that fails the job if either check fails.

**30.** Add `"test": "node tests/email-parser.test.mjs"` to the `scripts` section of `package.json`.

**31.** Split `README.md` (it's ~231KB / ~963 lines, mostly a chronological session log). Pull the session-log portion out into a new `CHANGELOG.md`, and consider also pulling the sign-in "Do's and Don'ts" section into its own `docs/auth-signin.md` (keep a short pointer in the main README). **Caution:** the README's sign-in section is explicitly the authoritative source of truth for the auth-freeze rules mentioned in §5 below — when you move it, move it *verbatim*, don't summarize or "clean up" the wording, and keep a clear link from the main README so nobody misses it. This is a documentation-only change; verify by confirming nothing that used to read from `README.md` (if anything does — check, e.g., CI, or any script) breaks, and that the new file renders sensibly.

**32.** Delete the empty `bun.lock` file (0 bytes, no bun usage anywhere in the repo — confirm with `grep -r bun package.json .github/` first). Pick one dev server: `serve.py` and `server.js` (an Express server) both exist; `serve.py` is the one actually referenced by `.claude/launch.json` and used throughout this whole review for testing, so keep that one and remove (or clearly mark as deprecated/unused, if removing feels risky) `server.js`. Also check whether `metadata.json` and the `mockups/` directory are still unreferenced anywhere (they were flagged as likely dead in the original review) and remove or justify them.

**34.** (33 already done.) Add tests for `sourceFor`, `buildQuery`, `normalizeConfig`, `buildItem` — these are exposed via `EmailImport._internals` (see the `_internals` object definition near the bottom of `email-import.js`, around where `init`/`check`/etc. get returned). These currently have zero test coverage. Write a small new test file (or extend `tests/email-parser.test.mjs` if it makes sense, though these four functions live in `email-import.js` not `email-parser.js`, so a separate `tests/email-import.test.mjs` using the same plain-assertion style is probably cleaner) exercising each function's documented/observed behavior with a couple of cases each.

### Batch 5 (refactor) remainder — lowest priority, do last

**35.** Delete confirmed-dead code: `renderAllTransactions`, `renderAllTxPage`, `loadMoreAllTx`, `updateStatus` (check — it may already be a no-op per earlier work, grep `function updateStatus`), `updateFabBadge`, `calRevealOlder`, `calRevealCollapsed`, `calRevealYearPills`, `calRefreshOlderMonths_UNUSED`. **Grep every one of these names across the whole repo first** to confirm zero live callers before deleting each — some may have been referenced by code that's since moved or itself been deleted; don't trust the original review's "dead" labeling without re-verifying in the *current* codebase.

**36.** Extract a `refreshAfterWrite()` helper and a `toNativeIdr(pm, amount)` helper to deduplicate the "recompute balances, re-render calendar, re-render search" sequence and the FX-to-native-currency conversion block that are each pasted ~3-10 times across `app-core.js`. Also fold the `window.switchTab` wrapper (a tiny tail `<script>` in `index.html`) directly into the real `switchTab` function in `app-core.js`, removing the indirection. This is pure refactor — verify with the byte-identical-blocks technique used for the earlier structural refactors in this review (commits `ae725fc`, `aede691`, `7d479d6`, `50ecfc3`, `6ee2975` all show the exact verification pattern: confirm every moved/merged block is byte-identical to what it replaced, confirm no call site's behavior changed).

**37.** Move the ~680 lines of inline `<style>` CSS still in `index.html` out to a separate `style.css` file. Pure extraction — verify byte-for-byte, confirm the page still renders identically (take a screenshot before and after if you have a visual tool available, or at minimum diff computed styles on a few representative elements).

---

## 5. Hard constraints — read this before touching anything near auth or sign-in

**None of the remaining items above touch this area.** But if anything you do incidentally brushes against it, stop and ask the user first. This is restated from the project's own `README.md` (see its "Sign-In Flow — Do's and Don'ts" section) and from this review's own prior behavior:

- **Never touch `auth.js`'s `Auth.start()`, `_deferredMode`/`_tokenReady`, `triggerFirstTapSync()`, `Auth.silentRetry()`, `Auth.signIn()`, `Auth.hasValidToken()`, or `getAccessToken()`'s deferred-mode wait** without a real-device screen recording to validate against. This was debugged over 18+ sessions and is fragile in ways that don't show up in a desktop browser or this dev sandbox.
- **Never reintroduce `prompt:'select_account'`** or any interactive Google account-picker — tried and explicitly rejected twice.
- **Never call `Auth.signIn()` from a silent/background path** — it shows a full-screen "Reconnecting to Google" overlay and is meant only for the stuck-recovery banner's dedicated button.
- **Never move the first-tap-listener `<script>` in `index.html`** out of its position immediately after `auth.js`'s own `<script>` tag, or into the `DOMContentLoaded` handler. This was placed there specifically to close a ~5-second dead-tap window on cold start; confirmed via screen recording.
- **Never change the stuck-sign-in banner's interaction model** (dedicated "Retry sign-in" button only, no tap-anywhere).
- The banner's *detection* logic (`isStillStuck()`) must stay cause-agnostic — never gate detection itself on `!Auth.hasValidToken()`; only the banner's *copy/action* may branch on that.

None of batch 3/4/5's remaining items go anywhere near this, which is why they were left for a less-trusted model/session to pick up. Keep it that way — if you think one of them secretly requires touching this area, you've misread the item; re-read it, or ask.

---

## 6. Quick-start checklist for whoever picks this up

1. `cd` to the repo, `git status` — confirm it's still clean (if not, something changed after this handover was written; investigate before proceeding).
2. `git log --oneline -5` — confirm `9797c36` (or later) is at the tip.
3. Read §2 (ground rules) and §5 (hard constraints) fully before writing any code.
4. Start with item 23 (`highlightMatches`) — it's the one already investigated in §4, ready to implement.
5. For each item: re-locate current line numbers → read enough surrounding context to understand it → reproduce the bug behaviorally → fix → re-verify behaviorally → negative-control against old code where practical → `node --check` → bump `APP_VERSION` → write a commit message in the style of the existing history → commit → push.
6. Work through batch 3 (23–28), then batch 4 (29, 30, 31, 32, 34), then batch 5 (35, 36, 37), in that order, unless the user says otherwise.
7. If anything is ambiguous, under-specified above, or looks like it might touch auth/sign-in — ask the user rather than guessing.
