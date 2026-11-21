# Nota (public multi-tenant version)

This is a public, multi-tenant fork of the original Nota app (retired, its
last state archived in [Archive/README.md](Archive/README.md)) — both are
branded "Nota" to the end user, but this is a separate codebase/deployment.
The original was bound to one shared Google Sheet with a hardcoded API token;
this version lets each visitor sign in with their own Google account instead:
the app creates a private Google Sheet in *their* Drive and reads/writes it
directly via the Google Sheets API. There is no backend server and no Apps
Script deployment — everything runs client-side in the browser using the
signed-in user's own short-lived OAuth token.

## Project History & Timeline of Sessions

The full chronological history of development, audit, and refactoring passes has been moved to [CHANGELOG.md](CHANGELOG.md).

---

## Sign-In Flow — Do's and Don'ts (Read Before Touching Auth Code)

> [!IMPORTANT]
> The sign-in flow and auth code are frozen under strict guidelines. Before touching any auth or sign-in code, you must read the authoritative documentation in [docs/auth-signin.md](docs/auth-signin.md).

The complete rules, load-bearing files, Do's and Don'ts, and verification requirements are documented verbatim in [docs/auth-signin.md](docs/auth-signin.md).

---

## Architecture, Refactor Rules & Do's and Don'ts (Read Before Changing Code or Adding a Feature)

> [!IMPORTANT]
> This section is the distilled rulebook from the v4.79 → v4.123 architecture-review campaign (40 findings, ~45 commits, three assistants). The blow-by-blow history is in [CHANGELOG.md](CHANGELOG.md) (Session 69). The sign-in/auth rules are separate and stricter: [docs/auth-signin.md](docs/auth-signin.md). Where this section and an older note elsewhere in this README disagree, this section is current.

### File map and load order (as of v4.134)

`index.html` is **markup only** (plus 3 small inline scripts); all CSS is in `style.css`, all logic in separate files. Every `.js` file is a **classic script sharing one global scope** — no modules, no bundler, no build step.

| File | Owns |
|---|---|
| `config.js`, `sheets-client.js`, `data-store.js`, `auth.js` | OAuth client id (CI-injected), Sheets REST wrapper, the Apps-Script-emulating backend router (`handleRequest`), sign-in. **`auth.js` is FROZEN.** |
| `app-core.js` | State, API layer + `fetch` shim, `fetchWithTimeout`, escape helpers, tx entry/edit/delete, Search, boot. `APP_VERSION` lives here. |
| `data-networth.js` | Net-worth/asset math, `computeCCMonitor()` — pure, no DOM. |
| `config-settings.js` · `accounts.js` · `goals.js` · `recurring.js` | Config CRUD + load-time hydration (**must load first of the four**), account balances, goals, recurring rules. |
| `ui-settings.js` | Leftovers only (`switchTabFromMore`, `openFABAction`, global error listener). |
| `email-parser.js` · `gmail-client.js` · `email-import.js` | Pure parsing (own tests) → Gmail REST/MIME/PDF → rules, review popup, Settings page. |
| `ui-calendar.js` · `ui-insights.js` | Home calendar; Insights tabs + net-worth rendering. |
| `cc-usage-core.js` · `cc-usage.js` | CC Usage page: pure limit math (own tests) → UI + `CCGroups` tab persistence. |
| `sw.js` | Service worker; precaches everything, cache name keyed to the build id. |

Load order (matters — do not reorder without reading why):
```
config → sheets-client → data-store → auth
  → [first-tap sign-in inline script — DO NOT MOVE]
  → app-core → Chart.js (async CDN)
  → data-networth → config-settings → accounts → goals → recurring → ui-settings
  → email-parser → gmail-client → email-import
  → ui-calendar → ui-insights → cc-usage-core → cc-usage
  → [tail inline script: syncSideNav, Esc handler, pane resizer]
```

### Rules for every fix (the workflow that actually caught bugs)

**Do:**
1. **Re-locate before editing.** Line numbers in old notes are stale; `grep -n` the real current location.
2. **Reproduce the bug behaviorally first** — run the old code against a concrete scenario and watch it fail. Reading the code is not reproduction. (Several "cosmetic" findings were really data bugs: `setIT` storing `'all'` made Insights show **zero data**; `HIST.invest` never being assigned made synced Invest rows **unsearchable**.)
3. **Fix, re-run the same scenario, then run the exact old code as a negative control** to prove "before" was really broken and your test can actually fail.
4. **`node --check` every touched `.js`**, run `npm test`, and bump `APP_VERSION` (`v4.NNN`, stay in the v4.x series — never round up to `v5.00`) with every commit that changes shipped code.
5. **One commit per item**, and **push after each**. Commit message = bug mechanism + fix + *exactly* what was verified and how, so "verified" is distinguishable from "assumed".
6. **Test shared primitives with an adversarial mock, not a cooperative one.** `fetchWithTimeout`'s first rewrite dropped `Promise.race` and silently stopped timing out whenever `fetch()` ignored its abort signal; only a mock that ignores the signal caught it (commit `58d1bdb`). Keep `Promise.race` as the unconditional deadline and `AbortController` as best-effort cancellation.
7. **Treat a "confirmed dead" list as a hypothesis.** Only 4 of 9 functions listed as dead actually were. Before deleting, grep `*.js`, inline `onclick=`/`onchange=` in `index.html`, string-built handlers, and `tests/`.
8. **Add a self-test to any checker you write** that fails if the check matches nothing — a mis-escaped regex that matches nothing looks exactly like "0 problems found".

**Don't:**
- Don't touch `auth.js`, the first-tap `<script>`, or the stuck-sign-in banner without an explicit instruction **and** a real-device recording ([docs/auth-signin.md](docs/auth-signin.md)).
- Don't "fix in passing" something outside the item's scope; flag it instead.
- Don't batch commits or pushes.
- Don't trust a `typeof fn === 'function'` guard to mean the function exists — it also hides orphans (see open items).

### Rules for adding a new feature

**Checklist for a new `.js` file** (miss one and it fails silently or only offline):
- [ ] `<script src="./x.js?v=__BUILD__">` in `index.html`, **after** every file whose globals it reads at load time.
- [ ] Add it to `SCRIPTS` in `sw.js`, in the same order (a missing precache entry is an offline miss; `cache.addAll()` is atomic, so a *listed-but-missing* file kills the whole SW install).
- [ ] Keep it in the repo root so CI's `for f in *.js` `node --check` covers it.
- [ ] No top-level `const`/`let`/`function` name that already exists in another file — a duplicate top-level `const`/`let` across classic scripts is a hard `SyntaxError` that kills the second script.
- [ ] `__BUILD__` is substituted **only** in `index.html` and `sw.js`; never put the token anywhere else.
- [ ] Put testable logic in a pure `*-core.js` (no DOM, no clock — pass `now` in) with a `tests/*.test.mjs`, and add that test to both `package.json` and `.github/workflows/pages.yml`. Pattern: `email-parser.js`, `cc-usage-core.js`.

**Persistence:** a new setting normally gets a `Config` column (see *Config Persistence Pattern* above). The Config width is a **contract in five places** — header write, seed/bootstrap, `serializeConfigRow`, read range, and `ensureConfigSheetExists`'s `colCount` threshold + `columnCount` resize (currently A:N, threshold `< 14`). Widen all of them together. If old cached clients would rewrite `Config!A2:N` and clobber the new data, use a separate tab instead (the `CCGroups` exception).

**Data safety:**
- **Never delete a localStorage key that can hold unsynced data** (the inactivity timer used to wipe `notapub_invest_v2`). Prune only rows that are `synced` **and** confirmed present in the authoritative source (see `pruneStaleInvestHistory`).
- A synced local row also exists in the live fetch — **dedup on the shared TxID** when listing both, but don't blanket-skip `r.synced` (a row whose live copy hasn't arrived must still show).
- Search results hold `idx` positions into live arrays and re-read `array[idx]` on tap — **never mutate those arrays while results are on screen.**
- Every external `fetch()` goes through `fetchWithTimeout` (8–15 s); no raw `fetch()` to Google/Gmail/FX hosts.
- Verify a row's identity before any sheet edit/delete; batch multi-range writes.

**Correctness:**
- **Dates:** never `new Date().toISOString().slice(0,10)` — it's UTC, so "today" is wrong for 7 h/day in WIB. Use `todayISO()` or local-date parts.
- **Escaping has layers.** `esc()` for HTML text; `escJsAttr()` for a value inside an inline `onclick='…'` (the browser HTML-decodes the attribute *before* running the JS, so you need both). Never `esc(x).replace(/'/g, …)`. Highlight/split on **raw** text, then escape each piece; decode `&amp;` **last**.
- **Regex `\b` doesn't match plurals or `_`:** `\bfee\b` misses `fees` and `service_fee`.
- **Don't copy-paste a builder** (four `txJson` copies drifted until two were missing fields — now `calTxJson()`); **don't reuse a sentinel type** (`'all'` where `[]` is expected).
- **Every global needs a writer.** A `let`/`const` that is declared but never assigned is a silent no-op (`HIST.invest`, the `clientId` idempotency cache). `grep` for assignments when you add or audit state.
- **`const`/`let` globals aren't `window` properties.** Feature-detect with `typeof X !== 'undefined'`, never `window.X`.
- Don't read a later-loading script's global in a top-level statement — it throws `ReferenceError` and silently kills the rest of that script (see *Resilience* below).

### Testing and verification setup

- `npm test` (3 suites: `email-parser`, `email-import`, `cc-usage`). Before deploying, CI runs the `email-parser` and `email-import` suites, `node --check` on `*.js` and `tests/*.js`, and **parses each inline `<script>` in `index.html`** with `vm.Script`. **The `cc-usage` suite is not in `pages.yml` yet (see open items), so a `cc-usage-core.js` regression currently reaches deploy ungated.** `tests/` is removed from the Pages upload (dev-only).
- `app-core.js` has **no automated tests** — verify behavior with a throwaway `vm` harness (Proxy DOM, then read script-scope `let`/`const` by `vm.runInContext`, since they're not context properties) or in the browser.
- Browser: `python3 serve.py` (threaded — the old single-threaded server silently dropped scripts under load; `.claude/launch.json` name `notapublic-dev`, port 8010). Open `/tests/e2e-seed.html` (seeds a fake returning user, localhost-only), then `eval` `/tests/e2e-stubs.js` to stub Gmail + the Sheets API.
- **Stale-code trap:** in dev `?v=__BUILD__` is a fixed literal, so the *browser HTTP cache* and the service worker both serve pre-edit JS. Fetch with `{cache:'no-store'}` and `(0, eval)()` it, and confirm with `fn.toString()` before trusting a result.
- To exercise `data-store.js` internals, fetch it fresh and `eval` into an isolated global with `Auth`/`SheetsClient` rebound to stubs (note `handleRequest` awaits `Auth.ready`).
- The dev browser timezone is `Asia/Jakarta` (UTC+7) — lean on it to reproduce WIB date bugs.
- Test a page the way the user reaches it (`switchTabFromMore(...)`), not by calling its render function.
- Never let a verification step open a real Google sign-in popup — it blocks all JS and can't be driven or closed from tooling.

### Known open items (as of v4.134 — documented, not fixed)

- `syncOpex`/`syncInvest`/`syncTransfer` still send `clientId`, but `data-store.js` has no idempotency cache; comments still describe a "6 h TTL" that no longer exists.
- Editing a transaction while its create is still in flight loses the edit.
- `notaSyncFailed` is dispatched but nothing listens for it (no UI).
- `app-core.js` still calls `buildSmartPills()` (typeof-guarded) — the function no longer exists; the call is a harmless leftover.
- `calRefreshOlderMonths()` is a no-op stub kept for its callers.
- A legacy `investHistory` row with no `id` (pre-TxID) can't be opened for edit from Search.
- `pages.yml` runs only the `email-parser` and `email-import` suites; `tests/cc-usage.test.mjs` is in `npm test` but not in CI. Add `node tests/cc-usage.test.mjs` to the "Syntax and test checks" step.
- `HANDOVER.md` is a finished handoff note and says to delete itself — safe to remove.
- CC Usage: rows dated on/before the opening-balance date but labelled with the *next* Month in the sheet (posted after the statement cut-off) are ignored, because `HIST.opex` rows carry no sheet Month column. BCA counts them as used. See the **CC Usage page** section.
- CC Usage: `closedSeries` ("mark paid off") is still honoured by the core and stored in `CCGroups`, but the UI to set or clear it was removed in v4.133; `ambiguous` on a series is computed but no longer displayed.
- `PLAN_CC_USAGE.md` (the original design plan) is untracked in the repo root; the README section below supersedes it.

---

## CC Usage page (Profile → CC Usage, v4.124 – v4.134)

Tracks a BCA-style **combined credit limit** (several cards share one pool). Read this before touching `cc-usage-core.js`, `cc-usage.js`, the `CCGroups` tab, or how installments are entered.

### Files

| File | Role |
|---|---|
| `cc-usage-core.js` | `CCUsageCore` — **pure** (no DOM, no clock; `today` is passed in). Billing-cycle math, installment series, `computeCCUsage`. Tests: `tests/cc-usage.test.mjs` (in `npm test`). |
| `cc-usage.js` | Group persistence (`CC_GROUPS`, `fetchCCGroups`, `mutateCCGroups`, `normalizeCCGroups`), `collectCCRows`, page render (`renderCCUsage`), group overlay (`#ccGroupOverlay`). |
| `data-store.js` | `handleGetCCGroups` / `handleCCGroups`, router type `ccgroups`. |
| `app-core.js` | `fireTxTap` / `attachTxTapToEdit` (shared with Search), `renderTxItemHTML(item, query, {creditSet, hidePm})`, `updateInstallmentPreview`, the installment branch of `submitOpex`, `renderCCUsageIfActive()` hooks. |

### The formula

`Remaining = activeLimit − UnpaidStatement − CurrentSpending − RemainingInstallments − PendingHolds + Overpayment`

- **Active limit** = temporary limit while `today <= tempLimitExpiry` (inclusive), else the permanent limit.
- **Billing cycle** (per card): a charge on a day *after* the card's billing day belongs to the next cycle; `billingDate` 0/missing = calendar month; days 29–31 are clamped (Feb, leap years, Dec→Jan are covered by tests). Never `new Date('YYYY-MM-DD')` (UTC) — split the string.
- **Charges** in earlier cycles are *billed*, in the current cycle *unbilled*. **Credits** (every income/refund/transfer-in on a linked card) pay the billed balance first; any excess reduces unbilled; what is left is *Overpayment*.
- **Unpaid Statement** = billed charges (+ opening balance) − credits. It is *what is still owed on closed statements after payments*, **not** the sum of any visible list. **Current Spending** = everything charged in the current cycle, installment payments included (reduced only if a payment overflows the statement).
- **Opening balance** (group overlay): *As of* = the last statement date, *Outstanding* = that statement's **Tagihan Baru** (the installment ledger is *not* part of it). Rows dated on/before *As of* are ignored for the balance; installment *series* still read every row.
- **Pending holds**: manual number (authorised, not yet posted).

### Data model: the `CCGroups` tab (not Config)

One JSON cell `CCGroups!A2:B2` = `{v:1, groups:[…]}` (≤ 45,000 chars), created lazily on first save; a bad JSON cell is an **error, never "empty"**. It is **not** in Config because old cached clients rewrite `Config!A2:N` wholesale and would drop or misalign extra columns. Group: `id, name, pms[], permanentLimit, tempLimit, tempLimitExpiry, anchorDate, anchorOutstanding, pendingAuth, pendingAuthDate, closedSeries[], sortOrder, updatedAt`. A card belongs to at most one group (enforced in the UI **and** in `normalizeCCGroups`). `mutateCCGroups(fn)` is the only write path: it re-reads the sheet first, applies `fn` to a copy and saves; `fn` returning `null` means "no change" (no write, so the tab is never created needlessly). Renaming a payment method updates the groups via `ccGroupsRenamePM`.

### Rows the page reads

`collectCCRows(pmSet)`: synced rows from `HIST.opex` (date from the real `y/m/d`, **not** the sheet's Month column) + unsynced `txHistory` rows, with count-based ghost dedup (same idea as `_reconcileUnsyncedWithSheet`). Future-dated rows are ignored. All amounts are IDR; `kind` is `charge` or `credit`.

### Installments are plain rows — the conventions that matter

- Entering an installment on a card saves **one** row: `<name> CICILAN KE 1 DARI N` for `round(P/N)`, with `[pokok:P]` appended to the notes (the user's note is cut to fit 200 chars, never the tag). **No recurring rule is created.** The user never records `REVERSAL CICILAN`.
- The later months are recorded by hand (or are old rows): `CICILAN KE X DARI Y`, the legacy `Name (X/Y)`, and the legacy `Name (Installment)` the old recurring system wrote after the numbered ones.
- `buildSeries` places rows **chronologically into series instances**: a numbered row joins the instance of the same name whose last number is X−1 (same monthly amount wins a tie), else starts a new instance (`NAME|Y`, `NAME|Y#2`, …) — so two unrelated "Train (1/3)" purchases stay two series. An unnumbered `(Installment)` row is the next instalment of the open series of that name.
- **Remaining** of a series = `P − round(P/Y)·xMax` when `[pokok:P]` is known (the final instalment absorbs the rounding), else `amount × (Y − xMax)`. The highest number recorded counts as billed; missing earlier rows don't matter. Each series also returns its `note` (latest transaction note, tag stripped) and `entries` (every row with its number).
- **Old recurring installment rules** (`installmentTotal > 0`) are **hidden and no longer generate anything** (`isLegacyInstallmentRule`), but are never deleted or migrated; they expire on their own. Reverting v4.129 brings them back.

### What the page shows

Top card: *Remaining limit | Current spending* split headline (red *Over limit* when negative), note `of Rp… combined limit · this billing period 26 Oct – 25 Nov`, the stacked bar, then *Unpaid Statement*, *Remaining Installments*, *Pending Holds* and *Overpayment* (the last two only when > 0). Below: **Transactions** for the chosen cycle (‹ › navigation; every card uses its own cycle). Installment rows are **left out of that list** and shown in one expandable strip at its top, `Installments: Rp… paid · Rp… remaining`; expanded, each installment shows its note, *Paid* in the shown cycle and (current cycle only) *Remaining · next #n*, plus a reconciliation line (standalone + installments = Current Spending). Earlier cycles show *paid* only. The page re-renders (only while open) through `renderCCUsageIfActive()`.

### Decisions that were made on purpose (don't re-litigate without the user)

- The **Search monitor stays**. It is a monthly browser for *every* account (cash/bank too); only its per-card credit-limit bar and installment math moved to CC Usage. Tapping a CC-group card on Insights opens CC Usage (`tapAccountCard` → `ccGroupForPM`, from the cached groups); any other account opens the monitor.
- The per-card *Credit limit* input in the payment-method editor is **hidden, not removed**: the value (Config column N) still round-trips and prefills a new group's limit.
- Labels are English ("Unpaid Statement", "Remaining Installments"); the user thinks in BCA's statement terms, so keep them literal.
- A row the user labels with the *next* month on purpose (posted after the cut-off) is intentional — see the open item above.

### Pitfalls (each cost real time)

- **Never put anything tappable in the same `.form-group` as a hidden date input**: `.date-input-hidden` is `position:absolute; inset:0` inside a `position:relative` group and covers its siblings (the Outstanding field opened the calendar).
- Test against **real data**: a hand-checked formula passed all worked examples while the real ledger was off by Rp7.000.000 (finished installments never closing). Compare against a real statement's *Sisa Kredit Limit* when changing series logic.
- Browser testing: scripts load as `x.js?v=__BUILD__`, so refresh those **exact** URLs; the e2e seed's own failed history load overwrites a hand-seeded `HIST.opex`, so seed rows after `histLoaded` is true and test quickly.
- `cc-usage.js` (the UI) has **no automated tests** — only the pure core does. Verify page changes in the browser.

---

## Config Persistence Pattern (Best Practice)

When adding new user-configurable features (checkboxes, toggles, flags, settings), always persist them to the Google Sheets `Config` sheet using an empty column, not hardcoded in `index.html` or stored only in memory/localStorage.

**Why:** The Google Sheet is the app's authoritative database — it survives page reloads, browser restarts, and multi-device access. In-memory/localStorage storage reverts, creating confusing UX where settings mysteriously revert on navigation. Hardcoding doesn't scale to user-customization.

**How:** Use the `creditCard` flag (Session 9, Column L) as a template:
1. Pick an unused column in `Config` (grid already reserves space to column O).
2. Add the column to the header row in `data-store.js:ensureConfigSheetExists()` (`A1:K1` → `A1:L1`, add header string).
3. Include the field in all **four** Config sheet read/write sites in `data-store.js` (line numbers current as of this edit — `data-store.js` has grown since this pattern was first documented, so re-check with `grep -n` rather than trusting these forever):
   - Header row write in `ensureConfigSheetExists()` (line ~964, `A1:L1`)
   - Seed/bootstrap builders: the first site (line ~973) just calls the shared `serializeConfigRow(it, idx)` helper (line ~27-42, which already includes every field's ternary — add your field's ternary there); the second site (lines ~981-988) still has its own literal duplicate array needing the same `it.fieldName ? 'TRUE' : 'FALSE'` added by hand
   - Read mapping in `handleGetConfig()` (line ~977 read range `A...L`, line ~1006-1019 item object add `fieldName: String(r[N] || '').trim().toUpperCase() === 'TRUE'`)
   - Write mapping in `handleConfig()`'s `saveAll` (line ~1030 builds rows via `serializeConfigRow` — no separate `clearValues` step anymore, that was removed by Session 10's SYNC-3 optimization — then a single `updateValues` call at line ~1036)
4. On the frontend (`config-settings.js` / `app-core.js`), store the value on `CONFIG_ITEMS` entries and call `saveConfigToServer()` when the user changes it — no special sync code needed if `saveConfigToServer()` is already being called (which it is for overlay Save buttons and inline checkboxes).
5. Document the column and feature in README.md under the session entry.

**Width contract (bit us twice, v4.117 and v4.122):** the Config column count appears in *five* places that must widen together — the header write, the seed/bootstrap write, `serializeConfigRow`, the read range, and `ensureConfigSheetExists`'s `colCount < N` threshold with its `columnCount` resize. Today that is A:N and `colCount < 14`. A threshold lower than the real width means an existing sheet with a trimmed grid skips the resize and the write is rejected by the Sheets API.

Existing users: sheet values default to empty on first load (treated as `false`/unchecked), no migration needed. Once the user toggles a setting, it writes to the sheet.

**Exception — CC groups (CC Usage page):** they live in a separate `CCGroups` tab (one JSON cell, `A2:B2`), created lazily on first save like `EmailImport`.
Why: old cached clients rewrite `Config!A2:N` wholesale and drop or misalign anything past column N, and column H is capped at 50 chars.
Client code is `cc-usage.js` (`fetchCCGroups` / `mutateCCGroups`); every write re-reads the sheet first, and an unreadable JSON cell is an error, never "empty".

## How it works

- `auth.js` — Google Identity Services sign-in (OAuth `drive.file` scope:
  the app can only see files it creates itself, never anything else in the
  user's Drive).
- `sheets-client.js` — thin wrapper over the Google Sheets REST API.
- `data-store.js` — reimplements the old Apps Script backend's logic
  (Opex/Invest/Goals/Recurring reads & writes) directly against the Sheets
  API, using the exact same JSON shapes the frontend already expects.
- `index.html` + `app-core.js` and the `ui-*.js` / feature files — a fork of the original Nota's
  UI/calculation code. `index.html` is markup only now; the former inline script lives in
  `app-core.js`, which also holds the small `fetch()` shim: calls that used to hit the shared
  Apps Script URL are routed to `DataStore.handleRequest()` instead. See
  [Architecture, Refactor Rules & Do's and Don'ts](#architecture-refactor-rules--dos-and-donts-read-before-changing-code-or-adding-a-feature)
  for the full file map and load order.

## Smart autofill for transaction inputs

When entering an Expense/Income transaction, the **Category** and **Payment Method** fields auto-suggest based on what you used for that same transaction name in the last 30 days. Similarly, when entering an Invest transaction, the **Account** field auto-suggests based on the Asset (stock) name.

- **Server-side** (`data-store.js`): Computes `txCat`, `txPm` (Opex), and `txAccount` (Invest) maps from each user's own Sheet data, scoped to transactions from the last 30 days, ordered most-recent-first.
- **Client-side** (`index.html`): Stores these maps in localStorage so suggestions work on repeat visits, and powers the autocomplete dropdowns via `getSmartCats()`, `getSmartPms()`, and `getSmartAccounts()`.

This feature is per-user — each person signing in gets suggestions based only on their own Sheet data, not shared globally.

## Setup (before deploying)

1. **Google Cloud project**
   - Create a new project at [console.cloud.google.com](https://console.cloud.google.com/).
   - Enable the **Google Sheets API** and **Google Drive API**.
   - Configure the **OAuth consent screen**: app name/logo, support email,
     and add the `drive.file` scope only (this keeps verification simple —
     it's a non-sensitive scope).
   - Create an **OAuth 2.0 Client ID** (type: Web application). Under
     "Authorized JavaScript origins", add your GitHub Pages URL and
     `http://localhost:8000` for local dev.

2. **Configure the app**
   - Open [`config.js`](config.js) and paste your Client ID into
     `GOOGLE_CLIENT_ID`.

3. **Deploy**
   - Push to a GitHub repo and enable GitHub Pages (workflow already set up
     in `.github/workflows/pages.yml`).
   - Re-add your Pages URL to the OAuth Client's authorized origins once you
     know it.

## Local development

```bash
python3 serve.py
```

Then open `http://localhost:8000`.

## What's intentionally different from the original Nota

- No `appsscript_*.js`, no `data.json` (the original's personal financial
  history), no shared `API_TOKEN` — none of that carries over to a public app.
- Each user's Sheet is bootstrapped fresh on first sign-in with the same
  column layout the original's Apps Script backend used (see `data-store.js`
  for the exact schema), so the porting between the two stays 1:1 where it matters.

## Dual-purpose stock/account entries (e.g. USDIDR Pluang Febri)

Some assets in the Invest sheet function as both a stock that holds a balance AND
an account that funds other purchases. Example: `USDIDR Pluang Febri` is a Forex
account where you buy USD, then spend that USD to buy US stocks (QQQ, JNJ) *from*
that same account, which depletes the USD balance.

**How it works:**
- In the Invest sheet, each "Buy USD" transaction increases the balance (e.g. 240.36 USD).
- Each "Buy US Stock" with `Account = USDIDR Pluang Febri` spends USD from that account.
- The app tracks this by checking if an account is tagged `ccy = 'USD'` in the Config sheet.
- If so, `renderNetWorth()` and `getGoalCurrentValue()` both call `computeInvestNetLots()`
  to compute: `netLot[USDIDR Pluang Febri] = total USD bought − total USD spent on stocks`.

**The math:** if you buy 3,365 USD total and spend 2,932 USD on stocks, the balance
is 3,365 − 2,932 = 433 USD. If the USD account is *not* tagged `ccy = 'USD'`, the
spending is invisible and the balance looks like 3,365 (wrong). So for any account
you use this way, add `ccy = USD` in the Config sheet so the depletion logic kicks in.

Both `renderNetWorth()` and `getGoalCurrentValue()` share the aggregation logic
via `computeInvestNetLots()` (moved to `ui-insights.js:724` by the Session 15 script
split) to prevent them from drifting out of sync.

## Invest ↔ Opex dual-write (avoiding double-counting)

Every Invest **Buy or Sell** writes to **two sheets, not one**: `handleInvest()`
(`data-store.js`) appends the Invest row itself, and also appends a linked
`Opex` row (`cat = 'Investment'`, `pm` = the funding/receiving account,
`exp = totalIdr` for a Buy, `inc = totalIdr` for a Sell), joining the two via
an `opexTxId`/`opexId` column. This is deliberate — it's what makes an
investment show up as an "Investment" expense/income in the ledger and on the
Home Calendar — but it means **the same real-world cash flow now exists as two
rows**, and any balance/valuation calculation that reads both sheets for the
same account has to count it exactly once, not twice.
Session 31 fixed two variants of this exact mistake for Buy (see above) — both
were `computeAccountCurrentBalance()` (`ui-settings.js`) summing the linked
Opex row *and* the Invest row for the same Buy. A later fix (2026-09-24)
extended the dual-write to Sell (previously Sell only existed on the Invest
side, which is why a Sell never showed on the Home Calendar and its inflow
raced with cross-device sync) and extended the same `opexTxId` de-dupe guard
to Sell rows.

**Do:**
- When writing a calculation that reads **both** `HIST.opex` and Invest rows
  (`getAllInvestRows()`) for the same account, decide up front which sheet is
  the "source of truth" for a linked Buy/Sell's cash flow, and explicitly skip
  that same event on the other side.
- Use the row's `opexTxId` (Invest side) as the de-dupe key — a truthy
  `opexTxId` on a Buy *or* Sell row means its cash flow is already represented
  as an Opex row somewhere.
- On an Invest edit (`op:'edit'`), update the existing linked Opex row in place
  when switching between Buy and Sell (flip expense↔income on the same row)
  rather than deleting/recreating it — see `handleInvest()`'s edit branch.
- Remember a linked Opex row's amount (`exp`/`totalIdr`) is **always
  IDR-denominated**, even when the funding account's own currency isn't IDR.
  If a calculation is working in an account's native currency (as the FX
  branch of `buildAccountBalances()` does), including that row isn't just a
  double-count — it's also unit-mismatched (IDR treated as native currency).
- Trace a concrete example (a specific Buy amount, from a specific account)
  through the *entire* calculation path — both sheets, all branches — before
  trusting a fix. The Session 31 bug had an IDR-account version and a worse
  FX-account version; fixing only the first one you find isn't enough.
- After changing this logic, audit every other function that reads Invest
  rows for balance/valuation math (grep for `getAllInvestRows`, `HIST.invest`,
  `liveInvest`, `totalIdr`, `opexTxId`) — not just the one you were asked to
  fix — for the same exposure.

**Don't:**
- Don't sum `HIST.opex` deltas for an account without checking whether any of
  those rows are `cat === 'Investment'` — they may already be represented on
  the Invest side too.
- Don't assume a fix that works for IDR accounts also covers FX/non-IDR
  accounts — they run through different branches (`includeInvestIdr` in
  `computeAccountCurrentBalance()`) with different assumptions about which
  sheet already handled the outflow.
- Don't treat `totalIdr` as native-currency for a non-IDR account — it's
  always IDR. Native-currency depletion for FX accounts comes from
  `lot × price` inside `computeInvestNetLots()`, never from `totalIdr`.
- Don't add a new balance-affecting calculation that reads Invest rows
  without first checking this section and Session 31's fix in
  `computeAccountCurrentBalance()` (`ui-settings.js`) as the reference
  pattern for how to de-dupe correctly.

## Inherited frontend knowledge (from the original Nota)

The UI/calculation code (formerly all inline in `index.html`, now `app-core.js` and the `ui-*.js` /
feature files) is a fork of the original Nota's — rendering,
calculations, calendar, and insights are largely untouched. The notes below are hard-won
knowledge from that original project's history that still applies here. (The
original's backend-specific notes — Apps Script deployment, `API_TOKEN` rotation,
`data.json` — don't apply to this fork and are omitted.)

### Critical rules

- **`HIST.opex[].m` is 0-indexed** (Jan = 0). Functions that take a 1-indexed
  month convert with `month - 1`. Mixing these causes months to silently show
  no data.
- **Always set `calInited = false` before `initCalendar()`** or the calendar
  won't re-render.
- **Never remove by date range in `_applyCurrentMonthRows`.** It removes only
  days the live source actually returned (`liveDays` set), then appends live
  rows. The live source may not return the full month — range removal would
  wipe rows that had no live replacement.
- **`body { overflow: hidden }`** — never remove. The only scrollable elements
  are `.cal-scroll` and non-home pages.
- **`rowIndex` only exists on rows fetched live from the Sheet.** Rows without
  a `rowIndex` (stale cache, first load) are still editable — `openEditOverlay`
  stores `overlayEditOrig*` fields so the backend can find the correct row by
  content if `rowIndex` isn't available. Edit/delete always apply locally
  first, then attempt the write.
- **Version label in the UI** (`#appVersionLabel`, top-left next to logo) is
  set dynamically from the `APP_VERSION` JS constant. Never edit the HTML
  fallback text directly — it's stale by design; only the JS constant matters.
- **Touch events on `.cal-tx-item` need `touch-action: manipulation`** to
  register reliably in scrollable containers on mobile.
- **Swipe-down gesture listeners must be attached directly** (not inside
  `DOMContentLoaded`) — the script runs after the DOM is already parsed.
- **Use `100dvh`, not `100vh`** — accounts for the mobile browser address bar.

### Architecture

**Home layout:** `#page-home` is
`display:flex; flex-direction:column; height:calc(100dvh - header - nav); overflow:hidden`.
`.cal-scroll` → `flex: 54 54 0` (top 54%). `.cal-tx-panel` → `flex: 46 46 0`
(bottom 46%). Don't add `height` to their children without understanding this split.

**Calendar progressive reveal:** `calOlderShown` is a one-way latch — reset only by
`calReinit()`. `calRevealOlder()` no-ops after its first call (`calRefreshOlderMonths()`
is now an empty stub). The `calCollapsedShown` / `calYearPillsShown` latches and
`calRevealCollapsed` / `calRevealYearPills` were write-only dead code and were deleted
in v4.119/v4.123 — don't resurrect them. `.cal-year-pill` has
`scroll-snap-align: start` (each pill is a snap target).
`calInjectSnapSentinels()` always runs via `requestAnimationFrame`.

**Input overlay:** `position:fixed; inset:0; z-index:400`. Not a page — always
in the DOM. `switchTab()` always calls `closeInputOverlay()` first. Edit-mode
state (all reset in `closeInputOverlay`/`openInputOverlay`):
- `overlayEditMode` — `true` while editing an existing transaction.
  `submitOpex()` checks this flag (not `overlayEditRowIndex`) to decide
  between "update" and "add new".
- `overlayEditRowIndex` — row number if known from cache, `null` otherwise.
- `overlayEditOrigDate/Month/Tx/Amt/Inc` — original transaction fingerprint,
  used by `_applyLocalDelete`/`_applyLocalEdit` and sent to the backend as a
  fallback for locating the row.

**`HIST` object shape** (the shape `data-store.js` targets):
```js
{
  opex:    [{y, m, d, mk, cat, tx, pm, exp?, inc?, notes?, rowIndex?}],  // m = 0-indexed
  invest:  [{y, m, d, mk, stock, type, action, lot, price, totalIdr, account?}],
  txCat:   { "Indomaret": ["Groceries", "Household"] },  // rolling 3-month
  txPm:    { "Indomaret": ["BCA", "eWallet"] },
  stockType: { "QQQ": "US Stock" },
  cashBalance: 6310051,
  cashBalanceAsOf: "2026-06-30",  // cutoff date; post-cutoff transactions delta the balance
  jhtBase: { date, amount, monthlyAddition }  // date is 13th (base), contributions fire on 25th
}
```

### Known gotchas

- **`_applyCurrentMonthRows`:** removes `HIST.opex` rows only for `liveDays`
  (days the live source returned), then appends live rows. Never change this
  to remove by date range.
- **`cashBalance`:** treat any stored/seeded value as authoritative over a
  freshly-fetched live value — live is a fallback only.
- **Single quotes in tx names** (`D'Cost`) must be escaped as `D\'Cost` in
  `txCat`/`txPm` — used inside JS template literals.
- **`calToggle2026()` hides ALL 2026 content.** Wire any new calendar sections
  into it.
- **Chart.js from CDN** — no offline fallback for Insights charts.
- **`mk` field** (e.g. `"Jan 2026"`) is a display string used as a key. Don't
  change its format.
- **`scroll-snap-type: y mandatory`** — don't add elements inside
  `.cal-scroll` that aren't snap targets; they may become unreachable.
- **`retryPendingQueue()` is safe to call repeatedly** — items are removed
  from the queue before the next retry.
- **Config Balance Parsing (`parseConfigBalance` & `data-store.js`)**: Config balance strings formatted like `Rp 150.000.000` or `150,000,000` MUST NOT be parsed with naive `replace(/[^\d.-]/g, '')`. In dot-separated formats, `Number("150.000.000")` turns into `150` or `NaN`. Use `parseConfigBalance()` which handles currency prefixes, thousand dots, and commas before numeric conversion.
- **Asset Type Fallback Priority**: Always perform keyword-based asset identification (e.g. `sUpper.includes('JHT')`) BEFORE testing generic fallbacks (`!type || type === 'Other'`). Otherwise, items configured with `Other` or missing asset types will fall back to `Cash` or `US Stock` instead of `JHT`.
- **Net Worth Fallback Aggregation (`getNetWorthAllocations` step 3, `ui-insights.js`)**: Non-invest stock items and static account snapshots stored in `rawAccountBalances` or `CONFIG_ITEMS` (like JHT) must be included via the fallback pass inside `getNetWorthAllocations()` (called by `renderOverview()`, `ui-insights.js:952-1040`, the fallback block at line ~999), ensuring assets without Opex/Invest sheet transaction rows are still counted in total net worth and donut visualization. (There is no function literally named `renderNetWorthOverview` — that name never existed in the codebase; this bullet previously cited it in error.)
- **Invest Buy and Sell transactions dual-write to Opex** (`handleInvest`, `data-store.js`) — a linked `cat='Investment'` row (expense for Buy, income for Sell), joined via `opexTxId`. Any balance calculation reading both `HIST.opex` and Invest rows for the same account must count that cash flow exactly once — see **[Invest ↔ Opex dual-write](#invest--opex-dual-write-avoiding-double-counting)** for the do's/don'ts, Session 31 for the two variants of this bug (IDR and FX accounts) already found and fixed for Buy, and Session 59 for extending the dual-write and the de-dupe guard to Sell.

### Resilience & error handling patterns

- **External API calls MUST have a timeout.** Stalled connections to external services (e.g., Google Sheets API) can leave a fetch pending forever with no error and no response. Every call to an external API (`sheets.googleapis.com`, `www.googleapis.com`, etc.) must wrap in `AbortController` with a bounded timeout (typically 15s for Sheets, 8s for user-visible calls). Without a timeout, a single stalled connection can hang the entire app's data-load chain with nothing left to catch or retry. See `sheets-client.js:authedFetch()` as a template.
- **Local DataStore calls don't need timeout.** Calls from the app to `DataStore.handleRequest()` (via the fetch shim near the top of `app-core.js`) are synchronous JS execution in the same thread — they can't stall. Add timeouts only to `fetch()` calls that cross the network boundary.
- **`fetchWithTimeout(url, opts, ms = 8000)`:** all user-facing API calls use this to
  avoid hanging if the server is slow. Returns a `"timeout"` error if no
  response arrives in time. Callers check `e.message === 'timeout'` and show
  `"Server slow — try again"` instead of a generic error.
- **`isSyncing` flag:** guards `submitOpex()`/`submitInvest()` against
  double-submit — prevents duplicate transactions from repeated taps.
- **`visibilitychange` listener:** re-fetches the current month when the app
  returns to foreground (tabs, app switcher) — prevents stale data on iOS.
- **Global runtime-error logging:** `window.addEventListener('error', ...)` (now at `ui-settings.js:62`, moved there by the Session 15 script split) logs uncaught runtime errors to console for debugging on mobile devices where DevTools aren't always available. (This has always been implemented via `addEventListener('error', ...)`, never the `window.onerror` property — an old wording mismatch, not a code change.)
- **Service worker:** only registers on localhost/HTTPS. Opening `index.html`
  as a `file://` URL won't activate it — use `serve.py` instead.
- **Cross-file top-level references need a deferred lookup, not a direct one.** The app is split across several `<script src>` files that all share one global scope (`app-core.js` first, then the files in the load order listed in *Architecture, Refactor Rules & Do's and Don'ts* above). Hoisting makes a function safely callable from anywhere *within the same file*, or from any file that loads *after* the file defining it — but a **top-level** (immediately-executed, not deferred to `DOMContentLoaded`) statement in an *earlier*-loading file can never directly reference a bare identifier defined only in a *later*-loading file. The reference is evaluated the instant that line runs, before the later file has even been fetched, and throws `ReferenceError`. This doesn't just fail that one line — it halts the rest of *that script's* top-level execution, silently skipping every subsequent top-level statement (though later `function` declarations in the same file are still hoisted and remain callable). If the skipped statement happens to be the one registering the `DOMContentLoaded` listener that calls `Auth.markAppReady()`, the sign-in overlay hangs forever with no console error and no network activity — see Sessions 21 and 22. Fixes: either move the call inside `DOMContentLoaded` (the file will have loaded by then), or — if it must run immediately, like `attachSwipeClose()`'s direct-attach calls, which need to bind their touch listeners as soon as the DOM parses — wrap the cross-file reference in a closure (`() => laterFileFn()`) so the identifier lookup happens at call time instead of script-load time.

### Code style guidelines (learned from a prior refactor)

**Do:**
- Extract repeated DOM patterns into helper functions — e.g. a
  `.forEach(b=>b.classList.remove(...); el.classList.add(...))` pattern
  repeated many times should become a `toggleActive(selector, el)` helper.
- Refactor near-duplicate functions that share structure rather than
  triplicating logic.
- Extract repeated string assembly (e.g. localStorage key building) into a
  helper instead of constructing the string inline at each call site.
- Escape user data when injecting into `onclick` attributes — use an
  attribute-escaping helper for the value plus a display-escaping helper for
  the text; don't rely on ad-hoc `.replace()` alone.
- Guard event listener attachment in render functions (e.g.
  `if (!listenerAttached) { ...; listenerAttached = true; }`) to prevent
  listeners stacking on re-renders.
- Use lookup objects instead of nested ternaries.
- Escape displayed text even from local/trusted-looking data — safe data
  structure doesn't mean safe to display.
- Comment the *why*, not the *what*.
- Follow the fix workflow and new-feature checklist in *Architecture, Refactor Rules & Do's and Don'ts* above (reproduce → fix → negative control → `node --check` → `APP_VERSION` bump → one commit → push).
- Use descriptive variable names in loops and helpers.

**Don't:**
- Don't nest ternary operators more than one level deep.
- Don't copy-paste handler code — extract to a parameterized function.
- Don't assemble storage/API keys manually in multiple places.
- Don't add event listeners directly in render functions without a guard.
- Don't use an underscore prefix on loop-/function-scope variables — that
  signals "private," which doesn't apply to local scope.
- Don't forget HTML escaping for user-facing data in `onclick` attributes —
  the browser decodes attributes before executing JS, so both layers matter.
- Don't keep unused functions "documented but never called" — delete them or
  mark clearly why they're kept.
- Don't comment obvious code.
- Don't `esc(x).replace(/'/g, ...)` for an inline-handler value — use `escJsAttr()`. Don't split-then-escape (or escape-then-highlight): split on raw text, then escape each piece.
- Don't wipe or prune a localStorage key that may hold unsynced data; prune only rows confirmed present in the authoritative source.
- Don't declare a global that nothing ever assigns, and don't delete "dead" code on a list's word alone — grep first, including inline handlers.
- **Don't leave `fetch()` calls to external APIs unbounded.** A stalled connection can hang forever with no error, leaving entire data-load chains pending indefinitely. Always wrap external API calls in `AbortController` with a timeout (15s for Sheets API, 8s for user-visible endpoints). See `sheets-client.js:authedFetch()` and `app-core.js:fetchWithTimeout()` as templates.
- **Don't pass a bare identifier from a later-loading script into a top-level (non-`DOMContentLoaded`) call.** It throws `ReferenceError` immediately and silently kills the rest of that script's top-level execution — no visible error unless DevTools happens to be open. See **Resilience & error handling patterns** above and Sessions 21/22. When splitting a monolith into multiple `<script src>` files, grep the file you're extracting *from* for every top-level (non-function-body) statement and check whether it references anything you just moved *out* of it into a later-loading file.

### Brand Guidelines & Design

- **App Name**: Nota
- **Design Philosophy**: Sleek, modern, and distraction-free mobile web application layout with a premium dark-mode aesthetic.
- **Typography**: Uses modern, clean sans-serif system fonts for optimum readability.
- **Color Palette & Theme**:
  - Employs soft gradients and distinct semantic colors for categories (e.g., `#60a0f0` for Transport, `#c8f060` for Meals, `#ff6b6b` for Entertainment).
  - Uses standard red/green for expense/income tracking to create immediate visual recognition.
  - Buttons and interactive elements use subtle hover/active states for feedback without layout shifting.
- **Layout Integrity**: The application structure depends on a fixed viewport height (`100dvh`) with `overflow: hidden` on the body, using specific flexbox sections and touch-optimized scrolling containers (`-webkit-overflow-scrolling:touch`) instead of document scrolling.

