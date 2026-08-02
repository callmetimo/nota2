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

## Recent Updates & Feature Additions (AI Studio Sessions Recap)

### Session 1: Multi-Tenant Architecture & Smart Autofill
- **Client-Side Google Sheets Backend**: Replaced shared Apps Script backend with `auth.js`, `sheets-client.js`, and `data-store.js` using OAuth `drive.file` scope.
- **Smart Autofill**: Auto-suggests **Category** & **Payment Method** (Expense/Income) and **Account** (Invest) based on rolling 30-day transaction history.
- **Resilient Offline Sync**: Background transaction retry queue (`retryPendingQueue`) and foreground re-fetch handlers.

### Session 2: Dual-Purpose Stock & Account Depletion Engine
- **Forex / Multi-Currency Asset Depletion**: Automated balance tracking for accounts that hold cash/forex *and* fund stock purchases (e.g., `USDIDR Pluang Febri`).
- **Shared Net Lot Calculation**: Implemented `computeInvestNetLots()` so Net Worth holdings and Financial Goals progress calculate exact remaining balances without drifting out of sync.

### Session 3: Weekly Insights View
- **Weekly Expense Analysis**: Added a **Weekly** mode filter on the Insights page, positioned to the left of **Monthly** (`Weekly`, `Monthly`, `Yearly`, `Category`).
- **Monday–Sunday Calendar Cycle**: Groups expenses into Monday–Sunday weeks.
- **Multi-Level Filters**:
  - **Payment Source Filter**: `All`, `Flazz`, `eWallet`, `Bank`, `CC`.
  - **Range Filter**: `4 Wk`, `8 Wk`, `12 Wk`, `YTD`.
- **Interactive Visual Analytics**: Week-over-week spending comparison, average weekly benchmarks, interactive weekly bar chart, and category donut breakdown with transaction-level drill-down.

### Session 4: Profile Navigation & Page Renaming
- **Financial Goals**: Renamed "Goals" to **Financial Goals** in the Profile / More menu.
- **Recurring Transactions**: Renamed "Recurring" to **Recurring Transactions** in the Profile / More menu.
- **Consistent Headers**: Updated the page title header on the Recurring screen to **Recurring Transactions**.

### Session 5: Custom Asset Type Configuration & Dynamic Net Worth Allocation
- **Configurable Account & Stock Asset Types**: Added **Asset Type** selection (`Cash`, `Reksa Dana`, `Forex`, `US Stock`, `JHT`, or `Custom...`) for Accounts and Stocks under Profile → Settings → Accounts / Stocks.
- **Google Sheets Config Sync**: Synchronized account and stock asset type configurations with Column E (`assetType`) in the Google Sheets `Config` sheet.
- **Stock Balance Inputs**: Enabled Balance and Balance Date settings for Stock items in the Config modal, allowing non-transactional asset holdings (e.g., JHT) to maintain a static balance.
- **Net Worth Holdings & Overview Unified Allocation Engine**:
  - Centralized portfolio allocation grouping in a single shared helper function `getNetWorthAllocations()` used by both `renderOverview()` and `renderHoldings()`.
  - Fixed account asset type resolution so items like `Pluang Timo USD` are mapped directly to configured asset types (`Forex`) or inferred from currency/name patterns.
  - Implemented smart FX deduplication (`isFxAccountMatch`) preventing duplicate account/holding entries for foreign currency accounts (`CIMB CHF`, `USD CIMB`) while preserving rich cost basis and lot size details.
  - Standardized theme colors and badge styling via `getTypeColor()` and `getHoldingTheme()` across both views.
  - Added live Market Price display from Google Sheets `Stock Prices` across US Stocks, Forex, and Reksa Dana with dual-currency equivalents.
  - Fixed account duplication (e.g. `BCA IDR` vs legacy `IDR BCA`) by replacing hardcoded default account names, adding token-sorted deduplication across active accounts and fallback raw balances, and auto-cleaning legacy key variations in `syncConfigToRawAccountBalances`.
  - Unified metrics calculation between `Overview` and `Holdings` so total Net Worth, Cash & Accounts, Investment totals, and Donut Chart allocations match 100%.

### Session 6: Insights Transactions Subpage & Version Bump (v4.26)
- **Transactions Subpage Renaming**: Renamed the "Credit Card Usage" toggle subpage under Insights to **Transactions**.
- **Account Filter & Metric Labels**: Updated "Card Filter" label to **Account Filter** (with filter option **All Accounts**), "Total CC Usage" summary card to **Total Transactions**, and bottom transaction list header to **Transactions**.
- **Application Version**: Bumped application version to **v4.26**.

### Session 7: Per-Payment-Method Credit Card Billing Toggle
- **User-selectable CC accounting method**: Added a `creditCard` boolean flag on `kind: 'pm'` entries in `CONFIG_ITEMS`, editable via a **"Credit card (deferred billing)"** checkbox in the Payment Method config overlay (Profile → Settings → Payment Methods), plus an inline checkbox on each PM row in the settings list.
  - **Checked (Method 1 — deferred billing)**: charges on that payment method don't count as an expense until the bill is paid via a bank payment method. This matches how a real credit card works — the bank balance isn't touched until the statement is paid.
  - **Unchecked (default, Method 2 — real-time)**: charges count as an expense immediately, same as cash/bank/e-wallet.
- **No hardcoding**: replaced every hardcoded `r.pm !== 'CC BCA'` / `r.pm === 'CC BCA'` check (in `getRows()`, `calGetMonthData()`'s monthly total, and the Home Calendar's per-day totals) with a single `isCreditCardPM(pmName)` helper that reads the flag from `CONFIG_ITEMS`. Any payment method the user creates — not just "CC BCA" — can be marked as a credit card and the exclusion applies automatically everywhere expense totals are calculated (Home Calendar, Expense Insights "All"/"Bank" views). The Insights "CC" view still shows credit-card transactions for tracking, regardless of the billing method chosen.
- Balance calculation (`computeAccountCurrentBalance`) was already unaffected either way — it matches transactions by PM name, so a credit card PM never touches a bank account's balance directly; only a bill payment recorded against the bank PM does.
- **Data persistence**: The flag is persisted to Google Sheets `Config` sheet Column L (see Session 9 for implementation).

### Session 8: Fix Accounts Missing from Net Worth Holdings/Overview
- **Bug**: Accounts with "Show on Insights" unchecked (e.g. `CIMB IDR`, `JHT`) silently disappeared from both the Net Worth **Holdings** and **Overview** pages, not just the home page's Insights cards.
- **Root cause**: `renderHoldings()` and `renderOverview()` both filtered their account list with `showOnInsights !== false` — a flag meant only to control the home page's Insights account-balance cards (`renderAccountBalanceCards`). Once excluded there, the account was also blocked from `getNetWorthAllocations()`'s raw-balance fallback, since that fallback skips anything already present in `CONFIG_ITEMS`, leaving no path for the account to reappear.
- **Fix**: Removed the `showOnInsights` condition from both `renderHoldings()` and `renderOverview()`'s account filters so Net Worth always reflects every non-archived configured account, independent of the Insights-tab display preference. `renderAccountBalanceCards` keeps using `showOnInsights` as before.
- **Follow-up bug**: After the above fix, `CIMB IDR` (a plain IDR cash account) still didn't appear. Root cause: `isFxAccountMatch()` (`index.html:4641`) — used by `getNetWorthAllocations()` to avoid double-counting an FX funding account (e.g. `USD CIMB`) that's already represented by its linked Forex holding (e.g. `USDIDR CIMB`) — strips currency tokens like `"IDR"`/`"USD"` from both names before comparing. Stripping `"IDR"` off `"CIMB IDR"` also collapsed it to `"cimb"`, which then coincidentally matched the unrelated `USDIDR CIMB` Forex holding (also strips to `"cimb"`), so `CIMB IDR` was wrongly treated as a duplicate and dropped.
- **Fix**: Added a currency guard to `isFxAccountMatch()`'s token-normalization step — it only applies when the account's `ccy` is a real foreign currency (not `IDR`/blank), since a legitimate FX-linked account always carries a foreign `ccy` (per the "Dual-purpose stock/account entries" convention below), while a plain IDR cash account never should be. Also fixed the raw-balance fallback (`getNetWorthAllocations()` step 3) to look up each raw key's actual `ccy` from `CONFIG_ITEMS`/`ACCOUNT_CCY` instead of passing `null`, so the same guard applies consistently there.

### Session 9: Persist Credit Card Billing Flag to Config Sheet (Column L)
- **Bug**: The "Credit card (deferred billing)" checkbox on a Payment Method (Profile → Settings → Payment Methods) reverted back whenever the user left and returned to that settings page. The `creditCard` flag on `kind: 'pm'` items (added in Session 7) only ever lived in-memory/localStorage — it was never part of the Config sheet's read/write column mapping in `data-store.js`, so any fresh fetch of `CONFIG_ITEMS` from the Sheet wiped it out.
- **Fix**: Added `creditCard` as **Column L** in the `Config` sheet, matching the existing pattern used for `assetType` (Column E) and `showOnInsights` (Column K):
  - `data-store.js`: extended the header row (`A1:K1` → `A1:L1`, adding `'creditCard'`), the seed/bootstrap row builders, `handleGetConfig()`'s read mapping (`r[11]` → `creditCard: boolean`), and `handleConfig()`'s `saveAll` write mapping — all four Config sheet read/write sites now round-trip column L.
  - No `index.html` changes were needed — it already stored/read `creditCard` on `CONFIG_ITEMS` entries and called `saveConfigToServer()` on every toggle; the flag just wasn't surviving the backend round-trip.
- Column L was previously unused (grid already reserved up to column O via `gridProperties.columnCount: 15`), so no sheet resize was required.

### Session 10: Autocomplete-on-Tap, Forex Net Balance Fix, and Cold-Launch Connection Fixes
- **Autocomplete Not Showing on Empty Field Tap**: `showAC()` forced an empty suggestion list whenever the Category/Payment Method/Destination Account input was blank, so tapping the field before typing anything never showed suggestions. Now shows the full list on an empty tap while still substring-filtering as the user types.
- **Pluang USD Forex Holding Showing Gross Buys Instead of Net Balance**: `computeInvestNetLots()`'s FX depletion matched an Invest row's `Account` text against Config account names verbatim. When the Config account is named differently from the Invest sheet's `Account` text (e.g. Config `Pluang` vs Invest `Pluang USD`), depletion silently skipped, leaving the gross buy total instead of the balance net of stock-funding spend. Added a fallback to the existing `isFxAccountMatch()` helper so a fuzzy match still resolves the depletion instead of dropping it.
- **Intermittent Sign-In Failure & Empty Home Calendar on Cold Launch**: Two related bugs reported by multiple users, both caused by code assuming a script/fetch completes before it's used, with no retry when that assumption fails on a slow connection:
  - **"Can't find variable: google" on sign-in**: the GIS `<script>` tag was marked both `async` and `defer` (`async` wins per spec, so load order vs. the rest of the page was never guaranteed). `auth.js`'s `requestToken()` touched the bare `google` global with no readiness check, throwing a raw `ReferenceError` on a slow cold-launch network. Added `waitForGis()`, which polls for `google.accounts.oauth2` before any `google.*` reference, and removed the contradictory `async` from the script tag.
  - **Home calendar stuck on skeleton until visiting Net Worth**: the cold-load path's `fetchCurrentMonth()` call had no `.catch` and no retry — a transient failure (network hiccup, token refresh mid-flight, freshly-created Sheet still propagating) silently left the calendar empty. The only code path that ever retried was `switchTab('home')`, which doesn't run on first load since Home is already the active tab in markup — visiting another tab and returning "fixed" it only because that return trip finally triggered the retry. Added a bounded 2-attempt retry with backoff directly to the cold-load fetch so it self-heals without needing a tab switch.

## Config Persistence Pattern (Best Practice)

When adding new user-configurable features (checkboxes, toggles, flags, settings), always persist them to the Google Sheets `Config` sheet using an empty column, not hardcoded in `index.html` or stored only in memory/localStorage.

**Why:** The Google Sheet is the app's authoritative database — it survives page reloads, browser restarts, and multi-device access. In-memory/localStorage storage reverts, creating confusing UX where settings mysteriously revert on navigation. Hardcoding doesn't scale to user-customization.

**How:** Use the `creditCard` flag (Session 9, Column L) as a template:
1. Pick an unused column in `Config` (grid already reserves space to column O).
2. Add the column to the header row in `data-store.js:ensureConfigSheetExists()` (`A1:K1` → `A1:L1`, add header string).
3. Include the field in all **four** Config sheet read/write sites in `data-store.js`:
   - Header row write (line ~872, `A1:L1`)
   - Seed/bootstrap builders (lines ~882, ~895, both CONFIG_DEFAULTS map, add `it.fieldName ? 'TRUE' : 'FALSE'`)
   - Read mapping in `handleGetConfig()` (line ~890 read range `A...L`, line ~918-930 item object add `fieldName: String(r[N] || '').trim().toUpperCase() === 'TRUE'`)
   - Write mapping in `handleConfig()`'s `saveAll` (line ~940 clearValues `A...L`, line ~943-956 write rows add `it.fieldName ? 'TRUE' : 'FALSE'`, line ~956 updateValues `A...L`)
4. On the frontend (`index.html`), store the value on `CONFIG_ITEMS` entries and call `saveConfigToServer()` when the user changes it — no special sync code needed if `saveConfigToServer()` is already being called (which it is for overlay Save buttons and inline checkboxes).
5. Document the column and feature in README.md under the session entry.

Existing users: sheet values default to empty on first load (treated as `false`/unchecked), no migration needed. Once the user toggles a setting, it writes to the sheet.

## How it works

- `auth.js` — Google Identity Services sign-in (OAuth `drive.file` scope:
  the app can only see files it creates itself, never anything else in the
  user's Drive).
- `sheets-client.js` — thin wrapper over the Google Sheets REST API.
- `data-store.js` — reimplements the old Apps Script backend's logic
  (Opex/Invest/Goals/Recurring reads & writes) directly against the Sheets
  API, using the exact same JSON shapes the frontend already expects.
- `index.html` — a fork of the original Nota's UI/calculation code. The only functional
  change is a small `fetch()` shim near the top of the inline script: calls
  that used to hit the shared Apps Script URL are now routed to
  `DataStore.handleRequest()` instead. Everything else — rendering,
  calculations, calendar, insights — is untouched.

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
via `computeInvestNetLots()` (defined in `index.html` ~line 3220) to prevent them
from drifting out of sync.

## Inherited frontend knowledge (from the original Nota)

`index.html` is a fork of the original Nota's UI/calculation code — rendering,
calculations, calendar, and insights are untouched. The notes below are hard-won
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

**Calendar progressive reveal:** `calOlderShown`, `calCollapsedShown`,
`calYearPillsShown` are one-way latches — never reset within a session.
`calRevealOlder()` no-ops after its first call; use `calRefreshOlderMonths()`
to update already-revealed content. `.cal-year-pill` has
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
- **Net Worth Fallback Aggregation (`renderNetWorthOverview`)**: Non-invest stock items and static account snapshots stored in `rawAccountBalances` or `CONFIG_ITEMS` (like JHT) must be included via the fallback pass in `renderNetWorthOverview()` step 3, ensuring assets without Opex/Invest sheet transaction rows are still counted in total net worth and donut visualization.

### Resilience & error handling patterns

- **`fetchWithTimeout(url, opts, ms = 8000)`:** all API calls use this to
  avoid hanging if the server is slow. Returns a `"timeout"` error if no
  response arrives in time. Callers check `e.message === 'timeout'` and show
  `"Server slow — try again"` instead of a generic error.
- **`isSyncing` flag:** guards `submitOpex()`/`submitInvest()` against
  double-submit — prevents duplicate transactions from repeated taps.
- **`visibilitychange` listener:** re-fetches the current month when the app
  returns to foreground (tabs, app switcher) — prevents stale data on iOS.
- **`window.onerror`:** logs runtime errors to console for debugging on
  mobile devices where DevTools aren't always available.
- **Service worker:** only registers on localhost/HTTPS. Opening `index.html`
  as a `file://` URL won't activate it — use `serve.py` instead.

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
