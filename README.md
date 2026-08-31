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

This section provides the full chronological history of development, audit, and refactoring passes. Each session is tagged with the client used to conduct the changes: **Claude** or **AI Studio** (Antigravity/Gemini).

#### Session 1: Multi-Tenant Architecture & Smart Autofill (Claude)
- **Client-Side Google Sheets Backend**: Replaced shared Apps Script backend with `auth.js`, `sheets-client.js`, and `data-store.js` using OAuth `drive.file` scope.
- **Smart Autofill**: Auto-suggests **Category** & **Payment Method** (Expense/Income) and **Account** (Invest) based on rolling 30-day transaction history.
- **Resilient Offline Sync**: Background transaction retry queue (`retryPendingQueue`) and foreground re-fetch handlers.

#### Session 2: Dual-Purpose Stock & Account Depletion Engine (Claude)
- **Forex / Multi-Currency Asset Depletion**: Automated balance tracking for accounts that hold cash/forex *and* fund stock purchases (e.g., `USDIDR Pluang Febri`).
- **Shared Net Lot Calculation**: Implemented `computeInvestNetLots()` so Net Worth holdings and Financial Goals progress calculate exact remaining balances without drifting out of sync.

#### Session 3: Weekly Insights View (Claude)
- **Weekly Expense Analysis**: Added a **Weekly** mode filter on the Insights page, positioned to the left of **Monthly** (`Weekly`, `Monthly`, `Yearly`, `Category`).
- **Monday–Sunday Calendar Cycle**: Groups expenses into Monday–Sunday weeks.
- **Multi-Level Filters**:
  - **Payment Source Filter**: `All`, `Flazz`, `eWallet`, `Bank`, `CC`.
  - **Range Filter**: `4 Wk`, `8 Wk`, `12 Wk`, `YTD`.
- **Interactive Visual Analytics**: Week-over-week spending comparison, average weekly benchmarks, interactive weekly bar chart, and category donut breakdown with transaction-level drill-down.

#### Session 4: Profile Navigation & Page Renaming (Claude)
- **Financial Goals**: Renamed "Goals" to **Financial Goals** in the Profile / More menu.
- **Recurring Transactions**: Renamed "Recurring" to **Recurring Transactions** in the Profile / More menu.
- **Consistent Headers**: Updated the page title header on the Recurring screen to **Recurring Transactions**.

#### Session 5: Custom Asset Type Configuration & Dynamic Net Worth Allocation (Claude)
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

#### Session 6: Insights Transactions Subpage & Version Bump (v4.26) (Claude)
- **Transactions Subpage Renaming**: Renamed the "Credit Card Usage" toggle subpage under Insights to **Transactions**. *(Note: This subpage layout was subsequently removed and migrated to the main Search page in Session 19)*.
- **Account Filter & Metric Labels**: Updated "Card Filter" label to **Account Filter** (with filter option **All Accounts**), "Total CC Usage" summary card to **Total Transactions**, and bottom transaction list header to **Transactions**.
- **Application Version**: Bumped application version to **v4.26**.

#### Session 7: Per-Payment-Method Credit Card Billing Toggle (Claude)
- **User-selectable CC accounting method**: Added a `creditCard` boolean flag on `kind: 'pm'` entries in `CONFIG_ITEMS`, editable via a **"Credit card (deferred billing)"** checkbox in the Payment Method config overlay (Profile → Settings → Payment Methods), plus an inline checkbox on each PM row in the settings list.
  - **Checked (Method 1 — deferred billing)**: charges on that payment method don't count as an expense until the bill is paid via a bank payment method. This matches how a real credit card works — the bank balance isn't touched until the statement is paid.
  - **Unchecked (default, Method 2 — real-time)**: charges count as an expense immediately, same as cash/bank/e-wallet.
- **No hardcoding**: replaced every hardcoded `r.pm !== 'CC BCA'` / `r.pm === 'CC BCA'` check (in `getRows()`, `calGetMonthData()`'s monthly total, and the Home Calendar's per-day totals) with a single `isCreditCardPM(pmName)` helper that reads the flag from `CONFIG_ITEMS`. Any payment method the user creates — not just "CC BCA" — can be marked as a credit card and the exclusion applies automatically everywhere expense totals are calculated (Home Calendar, Expense Insights "All"/"Bank" views). The Insights "CC" view still shows credit-card transactions for tracking, regardless of the billing method chosen.
- Balance calculation (`computeAccountCurrentBalance`) was already unaffected either way — it matches transactions by PM name, so a credit card PM never touches a bank account's balance directly; only a bill payment recorded against the bank PM does.
- **Data persistence**: The flag is persisted to Google Sheets `Config` sheet Column L (see Session 9 for implementation).

#### Session 8: Fix Accounts Missing from Net Worth Holdings/Overview (Claude)
- **Bug**: Accounts with "Show on Insights" unchecked (e.g. `CIMB IDR`, `JHT`) silently disappeared from both the Net Worth **Holdings** and **Overview** pages, not just the home page's Insights cards.
- **Root cause**: `renderHoldings()` and `renderOverview()` both filtered their account list with `showOnInsights !== false` — a flag meant only to control the home page's Insights account-balance cards (`renderAccountBalanceCards`). Once excluded there, the account was also blocked from `getNetWorthAllocations()`'s raw-balance fallback, since that fallback skips anything already present in `CONFIG_ITEMS`, leaving no path for the account to reappear.
- **Fix**: Removed the `showOnInsights` condition from both `renderHoldings()` and `renderOverview()`'s account filters so Net Worth always reflects every non-archived configured account, independent of the Insights-tab display preference. `renderAccountBalanceCards` keeps using `showOnInsights` as before.
- **Follow-up bug**: After the above fix, `CIMB IDR` (a plain IDR cash account) still didn't appear. Root cause: `isFxAccountMatch()` (moved to `ui-insights.js:914` by the Session 15 script split) — used by `getNetWorthAllocations()` to avoid double-counting an FX funding account (e.g. `USD CIMB`) that's already represented by its linked Forex holding (e.g. `USDIDR CIMB`) — strips currency tokens like `"IDR"`/`"USD"` from both names before comparing. Stripping `"IDR"` off `"CIMB IDR"` also collapsed it to `"cimb"`, which then coincidentally matched the unrelated `USDIDR CIMB` Forex holding (also strips to `"cimb"`), so `CIMB IDR` was wrongly treated as a duplicate and dropped.
- **Fix**: Added a currency guard to `isFxAccountMatch()`'s token-normalization step — it only applies when the account's `ccy` is a real foreign currency (not `IDR`/blank), since a legitimate FX-linked account always carries a foreign `ccy` (per the "Dual-purpose stock/account entries" convention), while a plain IDR cash account never should be. Also fixed the raw-balance fallback (`getNetWorthAllocations()` step 3) to look up each raw key's actual `ccy` from `CONFIG_ITEMS`/`ACCOUNT_CCY` instead of passing `null`, so the same guard applies consistently there.

#### Session 9: Persist Credit Card Billing Flag to Config Sheet (Column L) (Claude)
- **Bug**: The "Credit card (deferred billing)" checkbox on a Payment Method (Profile → Settings → Payment Methods) reverted back whenever the user left and returned to that settings page. The `creditCard` flag on `kind: 'pm'` items (added in Session 7) only ever lived in-memory/localStorage — it was never part of the Config sheet's read/write column mapping in `data-store.js`, so any fresh fetch of `CONFIG_ITEMS` from the Sheet wiped it out.
- **Fix**: Added `creditCard` as **Column L** in the `Config` sheet, matching the existing pattern used for `assetType` (Column E) and `showOnInsights` (Column K):
  - `data-store.js`: extended the header row (`A1:K1` → `A1:L1`, adding `'creditCard'`), the seed/bootstrap row builders, `handleGetConfig()`'s read mapping (`r[11]` → `creditCard: boolean`), and `handleConfig()`'s `saveAll` write mapping — all four Config sheet read/write sites now round-trip column L.
  - No `index.html` changes were needed — it already stored/read `creditCard` on `CONFIG_ITEMS` entries and called `saveConfigToServer()` on every toggle; the flag just wasn't surviving the backend round-trip.
- Column L was previously unused (grid already reserved up to column O via `gridProperties.columnCount: 15`), so no sheet resize was required.

#### Session 10: Autocomplete-on-Tap, Forex Net Balance Fix, and Cold-Launch Connection Fixes (Claude)
- **Autocomplete Not Showing on Empty Field Tap**: `showAC()` forced an empty suggestion list whenever the Category/Payment Method/Destination Account input was blank, so tapping the field before typing anything never showed suggestions. Now shows the full list on an empty tap while still substring-filtering as the user types.
- **Pluang USD Forex Holding Showing Gross Buys Instead of Net Balance**: `computeInvestNetLots()`'s FX depletion matched an Invest row's `Account` text against Config account names verbatim. When the Config account is named differently from the Invest sheet's `Account` text (e.g. Config `Pluang` vs Invest `Pluang USD`), depletion silently skipped, leaving the gross buy total instead of the balance net of stock-funding spend. Added a fallback to the existing `isFxAccountMatch()` helper so a fuzzy match still resolves the depletion instead of dropping it.
- **Intermittent Sign-In Failure & Empty Home Calendar on Cold Launch**: Two related bugs reported by multiple users, both caused by code assuming a script/fetch completes before it's used, with no retry when that assumption fails on a slow connection:
  - **"Can't find variable: google" on sign-in**: the GIS `<script>` tag was marked both `async` and `defer` (`async` wins per spec, so load order vs. the rest of the page was never guaranteed). `auth.js`'s `requestToken()` touched the bare `google` global with no readiness check, throwing a raw `ReferenceError` on a slow cold-launch network. Added `waitForGis()`, which polls for `google.accounts.oauth2` before any `google.*` reference, and removed the contradictory `async` from the script tag.
  - **Home calendar stuck on skeleton until visiting Net Worth**: the cold-load path's `fetchCurrentMonth()` call had no `.catch` and no retry — a transient failure (network hiccup, token refresh mid-flight, freshly-created Sheet still propagating) silently left the calendar empty. The only code path that ever retried was `switchTab('home')`, which doesn't run on first load since Home is already the active tab in markup — visiting another tab and returning "fixed" it only because that return trip finally triggered the retry. Added a bounded 2-attempt retry with backoff directly to the cold-load fetch so it self-heals without needing a tab switch.

#### Session 11: Fix Sheets API Hang on Stalled Connection (Claude)
- **Bug**: App displayed a permanent skeleton calendar and "Loading…" states on Net Worth even after successful sign-in. The issue only occurred on slower or flaky network connections, appearing to correlate with visiting the Net Worth page.
- **Root cause**: `sheets-client.js`'s `authedFetch()` — the wrapper used for every Google Sheets/Drive API call — had no timeout. If the network connection to `sheets.googleapis.com` stalled or timed out on the server side (rare but possible), the fetch promise never resolved or rejected. Every chain built on top (e.g., `loadHistData()` awaiting `handleGetAllOpex()`) hung forever with nothing left to catch or retry. The Service Worker, `sw.js`, was correctly bypassing Google API hosts, ruling out cache as a cause.
- **Fix**: Wrapped `authedFetch()` in an `AbortController` with a 15-second timeout (`sheets-client.js:10-21`). A stalled connection now reliably throws `"Sheets API request timed out"` instead of hanging indefinitely, so the retry/fallback logic in `loadHistData()` actually triggers (showing "Couldn't load full history" toast and falling back to cached data).
- **Impact**: Sign-in now completes and calendar populates even on flaky networks. Net Worth page no longer spins indefinitely. Users on slow connections see a recoverable error instead of an unresponsive app.

#### Session 12: Code Audit — Quick-Win Refactoring Pass (AI Studio)
- **RED-2 — `generateId()` helper** (`data-store.js`): Replaced three identical inline `(crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random())` ternaries with a single `generateId()` function. Dropped the weak `Date.now()+Math.random()` fallback — `crypto.randomUUID` is supported in every browser that can run this app's OAuth flow.
- **PERF-2 — Single-call transfer deletion** (`data-store.js`): Transfer deletions now send all row-delete requests in one `batchUpdate` call instead of one call per row, halving the API quota cost for every transfer delete operation.
- **PERF-4 — Correct service-worker host bypass** (`sw.js`): Replaced `BYPASS_HOSTS.some(h => url.includes(h))` (which could false-positive on URL paths that happen to contain a hostname substring) with a proper `URL.hostname` check. Also converted `BYPASS_HOSTS` from an array to a `Set` for O(1) lookups.
- **QW-1 — Documented `fetchWithTimeout`** (`index.html`): Added an explanatory comment clarifying why `fetchWithTimeout` coexists with `SheetsClient.authedFetch`'s own `AbortController` timeout. They serve different purposes (HTTP abort vs. promise-chain deadline) and the named wrapper is intentionally kept as the shared call site for ~15 POST operations.
- **QW-2 — Empty global arrays** (`index.html`): Removed hardcoded seeds from `allCategories`, `allPMs`, `allStocks`, and `allAccounts`. These were overwritten by `applyConfigToGlobals()` within milliseconds of boot anyway. `CONFIG_DEFAULTS` in `data-store.js` is now the single source of truth for default names.
- **QW-3 — `APP_BUILD` surfaced in Account page** (`index.html`): Added a **Build** row to the Account info card displaying `APP_VERSION (APP_BUILD)`. The constant was previously defined but never shown anywhere, making remote support/diagnostics harder.
- **QW-4 — Migration flag cleared on sign-out** (`auth.js`): Added `localStorage.removeItem('notaPublic_splitMigratedV1')` to `signOut()` so the one-time sheet-split migration flag is reset when a user signs out, preventing it from silently blocking the migration if they sign in with a different Google account on the same browser.

#### Session 13: Code Audit — Quick Wins & Security Pass (AI Studio)
- **SEC-1 — GitHub Actions Secret Injection**: Moved the Google Client ID out of the public source code. The codebase now uses a placeholder (`___GOOGLE_CLIENT_ID___`) which is injected by GitHub Actions at deploy time.
- **Client ID Local Fallback (Guardrail)**: Built a dynamic hostname detection mechanism into `config.js`. If the app runs locally (`localhost`, `127.0.0.1`, `192.168.x.x`), it falls back to a locally-defined `GOOGLE_CLIENT_ID_LOCAL` so developers don't encounter OAuth errors, while production correctly enforces the secret.
- **Resilience Fix (`sw.js`)**: Wrapped `new URL()` in a `try...catch` inside the Service Worker fetch handler and hardened `BYPASS_HOSTS` matching. This prevents the Service Worker from crashing on non-standard request schemes (like `chrome-extension://`), which previously blocked the Google Sign-In script from loading.

#### Session 14: Code Audit — Medium Refactors Pass (AI Studio)
- **RED-1 / RED-4 / RED-5 — DataStore Cleanup**: Centralized duplicate code patterns. Merged `parseConfigBalance` into a shared utility, extracted `serializeConfigRow` to deduplicate config serialization, and moved the `MONTHS` array mapping strictly into `DataStore`.
- **RED-3 — Extracted `fetchAndCacheSheetGids`**: Eliminated redundant GID logic across bootstrap, settings, and initial fetch paths by centralizing the lookup.
- **SYNC-1 — Aggressive Sync Pruning**: Updated `pruneStaleHistory` to automatically prune synced history older than 60 days from `localStorage`, preventing long-term storage bloat on mobile browsers. Unsynced (pending) transactions are completely immune.
- **SYNC-3 — Optimized API Calls for Rules**: Replaced the sequential `clearValues` and `updateValues` API calls with a single `updateValues` request dynamically padded with empty rows. This cuts the network overhead of saving Config and Recurring rules by 50%.

#### Session 15: Architecture & `handleGetAllOpex` Caching (PERF-1 & ARCH-1) (AI Studio)
- **PERF-1 — `handleGetAllOpex` Caching**: Addressed the main application bottleneck by implementing a stale-while-revalidate caching pattern in `data-store.js`. Navigation to Insights and History is now instant, rendering from `localStorage`, while a background fetch checks Google Sheets for updates. If new data is found, a `notaOpexUpdated` event is fired to quietly refresh the UI without reloading.
- **ARCH-1 — Modularised `index.html`**: Extracted 4,500 lines of JavaScript from the massive `index.html` monolith into safe, domain-specific modules (`ui-insights.js`, `ui-calendar.js`, `ui-settings.js`). This significantly improves maintainability while preserving the existing top-to-bottom variable scoping.

#### Session 16: Search Page Tap-to-Edit for All Transaction Types (Claude)
- **Expense/Income & Investment Transactions**: Tapping a transaction in the Search page (or "All transactions" list) now opens the same edit/delete overlay as the home calendar. Previously, only a narrow set of synced live-investment rows were tappable; all other transaction types were inert.
  - Refactored `openEditOverlay()` → added `openEditOverlayFromRow(row, dateStr)` containing the shared core. `openEditOverlay()` now delegates to it, allowing Search-page calls from new `openSearchTxEdit()` resolver to work without coupling to the global `calCurrentTxns`/`calCurrentDateStr`.
  - Wired Search results (both query search and "All transactions") via new `openSearchTxEdit(source, idx)` and `openSearchInvestEdit(source, idx)` resolvers, using the same touch/click event delegation pattern already used on the home calendar's day panel (`#calTxList`) — necessary to avoid tap-to-edit being swallowed by iOS `-webkit-overflow-scrolling:touch` scroll layers.
  - Updated `renderTxItemHTML()` to emit `data-idx`/`data-source`/`data-type` attributes on tappable rows, replacing the old inline `onclick` for investments.
  - Date picker in the edit overlay now accepts an explicit date parameter, defaulting to the global `calCurrentDateStr` so calendar calls are unaffected. When editing from Search, the date is read from the transaction's own date rather than today's, and the bounds clamp is skipped if the transaction falls outside the current month (fixing a latent bug where editing an older expense's date would be wrongly blocked).
- **Transfer Transactions**: Transfers are stored as two linked rows in HIST.opex (an expense leg on the source PM, an income leg on the destination PM, sharing an `xfr_...` id). The home calendar already collapses these into a single display row ("PM A → PM B"); Search now does the same.
  - Added `mergeTransferPairs(results)` helper, reusing the exact grouping logic from the calendar's `calGetMonthData()` but operating on Search's flat result set, keyed globally by `row.id` (both legs always share the same `xfr_...` id per the server-side delete implementation).
  - Merged transfer rows are tagged `source: 'hist-transfer'`, rendered with a distinct purple 🔁 icon and `{fromPm} → {toPm}` arrow text, wired to `openEditTransferOverlay()` via a new `openSearchTransferEdit(xfrId)` resolver.
  - Pending/unsynced local transfers (created via `submitTransfer()` but not yet synced) now correctly display with transfer styling but remain non-tappable, consistent with the calendar's own constraint (they lack a `sheetId` until synced). This also fixes a latent bug where pending transfers were misdetected as editable plain expenses.
  - Modified `openEditTransferOverlay()` signature to accept an optional `dateStr` parameter, allowing Search calls to pass the transfer's own date instead of the global calendar date.

#### Session 17: Sign-In UX & Double-Click Prevention (Claude)
- **Disabled State for Sign-in Button**: Updated `auth.js` `signIn()` to visually disable the "Sign in with Google" button (`btn.disabled = true; btn.textContent = 'Connecting...'`) immediately upon click to prevent accidental double-clicks and confusion while the background auth and bootstrap process is running.
- **Error Recovery**: Automatically re-enables the button and restores its text if the Google authentication or bootstrap fails, allowing the user to try again safely.

#### Session 18: Credit Card Installment Options & Automatic Recurring Transactions (Claude)
- **Credit Card Installment Toggle**: Added a brand-consistent "Installment Option" row (`#installmentRow`) to the Expense input form which is dynamically revealed only when a configured Credit Card Payment Method is selected.
  - Features two active toggle pill buttons: **Full Payment** (default) and **Installment**.
  - Selecting **Installment** reveals an inline number input to let users type the installment period (`X`) in months.
- **Installment Splits & Automatic Recurring Rules**: 
  - On submission, if **Installment** is selected with period `X` (min 2 months), the app automatically divides the total amount by `X`.
  - Records the first payment immediately as a regular transaction, appending `(1/X)` to the name.
  - Automatically creates a recurring rule for the remaining `X-1` months, calculating the correct `endMonth` (Date + `X-1` months) and setting `lastFired` to the current month to prevent duplicate triggers.
  - Automatically syncs this new rule to the user's `Recurring` sheet in Google Sheets.
- **Dynamic Installment Index Naming**: Integrated dynamic name formatting (`getInstallmentName()`) into the recurring projection engine, calendar display, and recurring prompt popup, showing progressive indexes (e.g. `(2/3)`, `(3/3)`) for subsequent monthly installments.

#### Session 19: Search Page Redesign & Transactions Subpage Migration (Claude)
- **Migrated Transactions Subpage**: Moved the entire layout and functionality of the "Transactions" subpage of the Insights page into the main "Search" page under `#searchMonitorContainer`.
- **Deleted Original Subpage**: Deleted the "Transactions" button from the Insights subpage navigation bar and removed its layout element entirely from the Insights page.
- **Support for All Accounts (Not Just CC)**: Expanded the monthly transaction monitor to display transactions across *all* active Payment Methods (rather than being restricted to Credit Cards). The dropdown filter was updated to list all Payment Methods, and the summary cards were enhanced to display both **Total Expenses** (with Month-over-Month comparison) and **Total Income** side-by-side.
- **Removed Category Breakdown**: Strip-mined the Category Breakdown section from the transaction monitor to keep the list clean and compact, per user specifications.
- **Disabled Auto-Keyboard Popup**: Removed the `.focus()` call on the search input field during tab switches to prevent the virtual keyboard from automatically popping up when navigating to the Search page.
- **Integrated Global Search**: The Search page now behaves dynamically:
  - If the search bar is *empty*, it displays the monthly transactions monitor layout (month controls, account filter, summary cards, and transactions list matching the filters).
  - If the user *types* a query, it hides the monitor view and executes a global search across all history (including previous months/years), disregarding the month filter settings.
- **Tap-to-Edit Support**: Added event delegation and tap handlers on `#searchMonitorContainer` (supporting both `.detail-item` and `.tx-item` formats), making every transaction in the monitor list fully tappable/editable. Both optimistic (local) and server-synchronized updates and deletes correctly refresh the Search tab view if it is active.

#### Session 20: Goals Unique IDs, Account Colors & Redirections, Search card refinements, and Settings selector Grid (Claude)
- **Goals Unique IDs**: Upgraded the `Goals` sheet to support unique persistent IDs (Column H). Updated `handleGetGoals()` and `handleGoals()` in [`data-store.js`](file:///g:/My%20Drive/AI Tools/Claude Projects/Nota/data-store.js) to read/write Column H and target actions against this ID rather than fragile physical row indices. Refactored the frontend (`index.html`) client state `goalsEditId` and matching routines to fully utilize unique IDs.
- **Account Colors & Tap Redirections**: Enabled custom color selection for accounts under Profile -> Settings -> Accounts. Account balance cards on the Insights tab now render with their selected custom color as a border-color and translucent background highlight (matching active toggle active states). Tapping an account card automatically clears the active search bar query, sets the search tab's account filter to the account's corresponding payment method, and navigates the user directly to the Search page.
- **Search Card Refinements**: Replaced short value formatting (`fRpS`) with exact value formatting (`fRp`) on both **Total Expenses** and **Total Income** cards. Added a previous month income comparison calculation and replaced the average transaction statistics subtitle on the Total Income card with `"xx% vs prev month"` matching the Total Expenses card.
- **Settings Selector Grid**: Redesigned the settings selector navigation bar from a scrolling flex row into a neat, fully visible 2x2 grid, making tabs like "Payment Methods" and "Accounts" fit perfectly on mobile screens without truncation.
- **Expense Insights Account Filter**: Replaced the static, hardcoded payment source flex toggles ("All", "Flazz", "eWallet", "Bank", "CC") on the Expense Insights tab with a single dynamic **Account Filter** select dropdown at the very top of the section (matching the design in the Search tab). Synchronized all underlying chart view scopes (`wView`, `mView`, `yView`, `cView`) with the dropdown value and updated the chart summary labels dynamically. When set to "All Accounts", the scopes now correctly evaluate all transaction data, including credit cards.

#### Session 21: Resolve Bootstrap Hang Caused by Hoisting Order / ReferenceError (AI Studio)
- **Bug**: Upon launching the app, the UI would remain indefinitely stuck on the Google sign-in overlay showing "Setting up your Nota spreadsheet".
- **Root Cause**: The modularization refactor (Session 15) moved `updateHeaderHeight()` to `ui-insights.js`. However, `index.html` was invoking this function synchronously in the global scope during initial script load before the external `ui-insights.js` script tag (placed at the bottom of the body) was fetched and executed. This threw a synchronous `ReferenceError` that halted the main script before it registered the `DOMContentLoaded` listener, preventing the sign-in overlay from receiving the signal to hide (`Auth.markAppReady()`).
- **Fix**: Moved `updateHeaderHeight()` and date picker initialization functions inside the `DOMContentLoaded` event listener, guaranteeing that all deferred and synchronous modular sub-scripts (`ui-settings.js`, `ui-calendar.js`, and `ui-insights.js`) are fully loaded and defined before their contents are executed.

#### Session 22: Fix Persistent Login Hang — Another Cross-File Hoisting Casualty, Plus a Missed `ui-settings.js` Split Fix (AI Studio)
- **Bug**: Same symptom as Session 21 — the sign-in overlay stuck forever on "Setting up your Nota spreadsheet…" — specifically on the deployed iOS web app after a later refactor pass touched `ui-calendar.js`, `ui-insights.js`, and `ui-settings.js again.
- **Root cause**: `index.html`'s inline `<script>` block called `attachSwipeClose('goalsSheetHandle', closeGoalsOverlay)` and `attachSwipeClose('configItemSheetHandle', closeConfigItemOverlay)` at the top level, deliberately outside `DOMContentLoaded`. Both `closeGoalsOverlay` and `closeConfigItemOverlay` are defined in `ui-settings.js`, which loads *after* this inline script. Passing either identifier as a bare argument evaluated it immediately, throwing `ReferenceError: closeGoalsOverlay is not defined` — which halted the rest of the inline script's *top-level* execution, preventing the `DOMContentLoaded` listener where `Auth.markAppReady()` lives from ever registering.
- **Fix**: Wrapped both calls in arrow functions — `attachSwipeClose('goalsSheetHandle', () => closeGoalsOverlay())` — so the identifier lookup happens at swipe time, not script-load time.
- **Secondary bug**: `ui-settings.js` ended with stray leftover `</script>` + an unclosed `<script src="...chart.umd.js">` tag which threw a `SyntaxError: Unexpected token '<'` on page load, breaking `fetchConfig()`. Removed these tags and correctly moved the `Chart.js` CDN import to `index.html`. Hardened the `Chart.js` CDN `<script>` tag with `async` to prevent network blocks.

#### Session 23: Fix Net Worth Holdings / Insights Balance Inconsistency & Generalize FX Currency Handling (Claude)
- **Bug**: Net Worth **Holdings** page showed incorrect balances for dual-purpose FX accounts (e.g., `CIMB USD` showed incorrect values), while the Insights **Accounts** cards showed the correct value. The value changed depending on page load order, and both pages disagreed after Invest transactions.
- **Fixes**:
  - Skip synthetic holdings entries if a matching FX account already exists in `CONFIG_ITEMS`.
  - Skip Invest-transaction processing for non-IDR accounts inside `computeAccountCurrentBalance()` step 3.
  - Added `fetchLiveInvest()` alongside `fetchAccountBalances()` on Insights tab initial load.
  - Call `buildAccountBalances()` before constructing holdings and override each dual-purpose stock's value/quantity with its matched account's `accountBalances` entry.
  - Require both sides to contain the same currency's token in `isFxAccountMatch()` before normalising bank name to avoid collision across different currencies (e.g. `CIMB USD` vs `CIMB CHF` normalizing to cimb).
  - Generalized FX rate fetching generically for all 9 non-IDR currencies from `frankfurter.app` and `Stock Prices` parsed rows.

#### Session 24: Restructure & Audit README.md for Clarity (AI Studio)
- **Restructuring**: Audited the entire `README.md` to remove duplicated "AI Studio Sessions Recap" sections, consolidated all 24 sessions into a single, contiguous chronological timeline, and tagged each session with the conductor client (`Claude` or `AI Studio`).
- **Feature Auditing**: Removed obsolete feature paths (such as the legacy Insights "Transactions" subpage description which has been fully replaced by the Search page Transactions monitor) and verified all architecture details, guidelines, and `data-store.js` line mappings are accurate.

#### Session 25: Fix CIMB IDR Missing from Net Worth Holdings & Stale Insights Cutoff Balance (Claude)
- **Bug**: For some users (not all), a plain IDR account (e.g. `CIMB IDR`) with a cutoff Balance/"As of Date" set in Profile → Settings → Accounts (1) didn't appear at all on Net Worth **Holdings**, and (2) showed a stale, incorrect balance on **Insights** that never reflected transactions after the cutoff date. The current signed-in user's own data wasn't affected — this is a single-tenant, client-side app (each Google account only reads/writes its own private Sheet), so the bug was data-shape-dependent rather than a shared-state issue.
- **Root cause 1 (Holdings)**: Session 23's generalization of `isFxAccountMatch()` (`ui-insights.js`) replaced the old hardcoded currency dictionary with a generic `/^[A-Z]{3}$/` test on the account's `ccy`, but dropped the explicit `ccyUpper !== 'IDR'` guard added back in Session 8. Since `"IDR"` itself passes the 3-letter test, a plain IDR account's name could get its `"IDR"` token stripped and spuriously collide with any other Config/Invest item that also carries an IDR token and reduces to the same base name (e.g. the app's own default-seeded `IDR CIMB` account) — causing it to be wrongly treated as an already-represented FX holding and dropped from Holdings.
- **Root cause 2 (Insights)**: `getAccountMatchNames()` (`ui-settings.js`), which resolves which transaction `pm`/`account` strings count toward an account's post-cutoff balance delta in `computeAccountCurrentBalance()`, only stripped a currency token as a **prefix** (`/^(IDR|USD)\s+/i`). For a bank-name-first account like `CIMB IDR`, this never produced a bare `"cimb"` alias, so transactions recorded under just the bank name failed to match, and the cutoff balance never picked up any post-cutoff activity.
- **Fixes**:
  - Restored the `ccyUpper !== 'IDR'` guard in `isFxAccountMatch()` before deriving `tokenAlts`, so plain IDR accounts are never subjected to currency-token collision matching (Session 23's generic non-IDR currency support is unaffected).
  - Generalized `getAccountMatchNames()` to derive the currency token from the account's actual `ccy` (falling back to trying `IDR`/`USD` literally when no `ccy` is available) and strip it whether it appears as a prefix or a suffix, so bank-name-first accounts like `CIMB IDR` resolve a bare `"cimb"` alias just like prefix-ordered accounts (`USD CIMB`) already did.
  - Fixed unrelated breakage left over in an in-progress, uncommitted refactor (removal of the legacy `Balances` sheet): a duplicated `const CONFIG_DATA_ROW = 2;` in `data-store.js` (a fatal `SyntaxError` that prevented the whole `DataStore` module from loading) and a dangling `fetchAccountBalances()` call left in `ui-insights.js`'s `initNetWorth()` after the function's definition was removed from `ui-settings.js`.

#### Session 26: Fix Insights/Holdings Still Wrong After Session 25 — Locale-Formatted `balanceDate` Broke the Cutoff Comparison (Claude)
- **Bug**: After Session 25 shipped, a user who had just set `CIMB IDR`'s cutoff to a small balance as of a few days ago saw Insights show a wildly wrong, deeply negative balance instead — and Holdings still showed nothing for the account.
- **Root cause**: `handleGetConfig()` (`data-store.js`) read the `balanceDate` column straight off the Sheets API response with `String(r[9] || '').trim()` — no normalization. The Sheets API's `values.get` defaults to `FORMATTED_VALUE`, and `updateValues()` writes with `valueInputOption=USER_ENTERED`, so a date typed as ISO (`2026-08-02`) gets auto-converted to a real date cell and read back **locale-formatted** (e.g. `02/08/2026` for an Indonesian-locale spreadsheet) instead of ISO. `computeAccountCurrentBalance()` (`ui-settings.js`) compares this value against ISO-constructed transaction dates with plain string `<=`/`>` — comparing `"2024-01-15" <= "02/08/2026"` is `false` lexicographically (since `'2' > '0'`), so the cutoff exclusion never fired and *every* historical Opex/txHistory/Invest row matching the account was summed into the delta instead of just the days since the cutoff. This is the exact bug class already identified and fixed for Invest-sheet dates (see the `parseAnyDateToISO`/`handleGetInvest` comment further up in `data-store.js`) — it was simply never applied to the Config sheet's `balanceDate` column. It had been silently present all along; Session 25's `getAccountMatchNames()` fix is what first made transactions actually match this account's cutoff filter, exposing it. It went unnoticed on the reporting user's own data purely because their cutoff date happened to predate their transaction history, making the filtered and unfiltered sums coincide.
- **Fixes**:
  - `handleGetConfig()` now normalizes `balanceDate` through the existing `parseAnyDateToISO()` before storing it on `CONFIG_ITEMS`, falling back to the raw trimmed string only if it can't be parsed (mirroring the established `handleGetInvest` pattern — an unparseable date must never silently drop a real transaction).
  - `getAllInvestRows()` (`index.html`) was also missing a `.date` field on locally unsynced Invest rows (only `y`/`m`/`d` were set), so `computeAccountCurrentBalance()`'s `r.date &&` guard always skipped the cutoff check for those rows, always including them regardless of date. Added `date: r.date || ''` for consistency with the synced-row shape.

#### Session 27: Fix Insights Still Showing the Same Wrong Balance — Stale `rawAccountBalances` Cache Overrode Config (Claude)
- **Bug**: Even after Session 26 deployed (confirmed live in production via direct fetch of the deployed files), a user's Insights page kept showing the *exact same* wildly wrong negative `CIMB IDR` balance as before, byte-for-byte — despite the account's Settings → Accounts screen correctly displaying the freshly-set `192,412` balance as of `2 Aug 2026`.
- **Root cause**: `buildAccountBalances()` (`ui-settings.js`) sources an account's cutoff snapshot from **two** places: the Config sheet's `acct.balance`/`acct.balanceDate` (authoritative, shown/edited directly in Settings → Accounts), and `rawAccountBalances[acct.name]` — a separate, **local-only, localStorage-cached** snapshot originally fed by the now-removed legacy "Balances" sheet mechanism and by the "Set Balance" quick-entry overlay. The old code let `rawAccountBalances` win outright whenever it had any amount at all, and `syncConfigToRawAccountBalances()`'s own heuristic for refreshing that cache from Config (`bDate >= cur.date`) permanently fails to fire once the cached entry's `date` is later than the account's current Config cutoff (e.g. a prior "Set Balance" quick-entry dated after Aug 2, with a large/wrong amount and a non-`config_` txId) — so the correct, newly-set Config balance/date the user can see in Settings never actually reaches the calculation. Reproduced directly: replaying the old precedence logic against a synthetic stale cache entry (`{date:'2026-08-04', amount:-113565602}`) alongside the correct Config values (`192412`/`2026-08-02`) reproduces the exact reported `-113,565,602` figure.
- **Fix**: `buildAccountBalances()` now treats Config's `acct.balance`/`acct.balanceDate` as the sole authoritative source whenever it's set (which it now can be for any account, since the legacy Balances-sheet round trip that `rawAccountBalances` used to depend on has been removed), only falling back to `rawAccountBalances` when Config has no balance configured at all. Verified in-browser: the same synthetic stale-cache scenario now correctly resolves to `192412` regardless of the stale cached entry. **Note**: this was a real, worth-keeping hardening fix, but — as Session 28 found — it was not actually what was causing the user's persisting symptom.

#### Session 28: Actual Root Cause Found — `parseAnyDateToISO()` Silently Mis-swaps MM/DD Invest Dates, Making Them Permanently "In The Future" (Claude)
- **Bug**: After Sessions 25–27 all shipped and were independently confirmed correct (including a direct read of the raw Config sheet showing the exact right `balance`/`balanceDate`), the user's Insights page still showed the same wildly wrong `CIMB IDR` balance no matter what cutoff date was set, and Holdings still omitted the account. Caching, duplicate account entries, an over-broad "CIMB" match, and future-dated transactions were all directly ruled out with the user.
- **Diagnosis**: Rather than guess further, added a temporary opt-in diagnostic (`?debugAccount=<name>` — see the bottom of `index.html`) that wraps `computeAccountCurrentBalance()` to report exactly which rows are being matched and summed for a given account. Run against the user's real, live data, it revealed 5 Invest ("Pluang USD") rows matching `CIMB IDR` with dates `2026-29-06`, `2026-27-01`, `2026-25-02`, `2026-25-03`, `2026-27-07` — **invalid ISO dates with a "month" of 29, 27, or 25**.
- **Root cause**: `parseAnyDateToISO()` (`data-store.js`) has always unconditionally assumed slash-separated dates are `DD/MM/YYYY` (matching this app's Indonesian-locale convention), swapping the two fields to build the ISO string. But these 5 Invest rows were actually stored `MM/DD/YYYY` (e.g. `06/29/2026` = June 29) — a different write path/device than the rest of the user's data. The function blindly swapped them anyway, producing a garbage-but-non-empty ISO string with an out-of-range month. Critically, an invalid month like `"29"` still **sorts as a string** after every valid two-digit month (`"01"`–`"12"`), so `computeAccountCurrentBalance()`'s cutoff comparison (`rowDate <= baseDate`) always evaluated to `false` for these rows — they looked permanently "in the future" no matter what real 2026 cutoff date was set, which is why moving the cutoff around never excluded them.
- **Fix**: `parseAnyDateToISO()` now validates the assumed month; if it's out of range (`> 12`) but the day position is a plausible month (`<= 12`), it swaps the two fields and re-derives the ISO date instead of returning a broken one. Verified against the exact 5 raw values pulled from the live debug session — all now correctly parse to their true (and correctly cutoff-excluded) dates, with no change in behavior for unambiguous or already-ISO dates.
- **Process note**: this investigation took 4 rounds to nail down because each of the first three fixes (Sessions 25–27) was a real, independently-verified bug — none were red herrings — but none were the actual cause of the reported symptom. The lesson: when a fix is verified correct in isolation but the live symptom doesn't move, don't fix-and-hope again — add a live diagnostic and read the real data directly, as done here.
- **Confirmed fixed** by the reporting user against their live data. The temporary `?debugAccount=` diagnostic (`index.html`) has been removed.

#### Session 29: Codebase-Wide Audit for the Same Date-Parsing Bug Class, Plus Two Follow-On Fixes (Claude)
Following Session 28's fix, ran a full audit (all `.js` files and inline `<script>` blocks) asking: could this same failure mode — a locale/write-path date ambiguity silently producing a value that sorts wrong in a string comparison — affect any other account, asset, or feature? Findings, most to least severe:

- **Systemic root cause (not fixed this session)**: every date this app writes goes through `updateValues(..., valueInputOption='USER_ENTERED')` and is read back via `getValues()`'s default `FORMATTED_VALUE` — with no explicit `numberFormat` on any date column except `Opex!B` (see the `MMM yyyy` `repeatCell` request in `bootstrap()`). Google Sheets auto-detects date-shaped writes, converts them to a real date cell, and renders reads according to the *spreadsheet's own locale* — which is why the `Invest!A` rows behind Session 28's bug (originally written like `29 Jun 26`) came back as `6/29/2026` rather than the app's usual `DD/MM/YYYY` convention. This is a durable, generic risk, not specific to Invest. **Recommended future fix** (not implemented now — it needs a live spreadsheet to verify against, which wasn't available in this session): pin an explicit `numberFormat` (e.g. `yyyy-mm-dd`) on every date column — `Opex!A`, `Invest!A`, `Config!J`, `Goals!B/C/G`, `Recurring!J/L` — the same way `Opex!B` already has one, so `FORMATTED_VALUE` reads are always locale-independent ISO strings regardless of the spreadsheet's locale.
- **`Config!J` (`balanceDate`) — theoretically the same risk, not currently observed**: since `balanceDate` is a full day-level date exactly like the Invest dates that broke, it's exposed to the same locale-coercion risk in principle. However, direct evidence from this investigation (a raw-sheet screenshot of the user's real `Config!J` cell, and the confirmed-correct final balance calculation using that exact value) shows it currently round-trips as clean, unambiguous ISO (`2026-08-05`) rather than being locale-reformatted — unlike the Invest dates. Left as-is rather than risk an unverified Sheets-schema change; flagged here so a future ambiguous-date report against an account balance (not Invest) is recognized immediately rather than re-investigated from scratch.
- **Fixed — `parseAnyDateToISO()` lacked range validation and had narrower format coverage than `parseDateInfo()`** (`data-store.js`): the two functions were separate, hand-maintained date parsers that could disagree, and `parseAnyDateToISO()` had no equivalent of `parseDateInfo()`'s validation gate (`month 1-12, day 1-31, year 2000-2100`) — so a genuinely invalid input like `13/13/2026` would still silently produce a garbage-but-truthy ISO string (`"2026-13-13"`) that sorts wrong in every cutoff comparison, the same failure mode as Session 28's bug, just for a case the swap fix couldn't catch. **Fix**: `parseAnyDateToISO()` now delegates entirely to the already-proven `parseDateInfo()` (used for the whole Opex ledger) instead of maintaining separate logic — this gives it `parseDateInfo`'s full format coverage (dot/dash separators, 2-digit years, `YYYY/MM/DD`) and full range validation for free, and guarantees the two parsers can never disagree again. Verified against the 5 real dates from Session 28 plus a battery of edge cases (already-ISO, unambiguous DD/MM, month-name, genuinely invalid, out-of-range-even-after-swap, and the newly-supported formats).
- **Fixed — Recurring `lastFired` was unvalidated while the adjacent `endMonth` column already was** (`data-store.js`, `handleGetRecurring()`): a corrupted `lastFired` value could make an already-recorded recurring transaction look never-fired (re-prompting a duplicate), and — via a raw cross-format `>` string comparison against a clean local `"YYYY-MM"` value elsewhere in `ui-settings.js` — could let corrupted server data silently overwrite a correct local `lastFired` stamp. **Fix**: validate `lastFired` against the same `/^\d{4}-(0[1-9]|1[0-2])$/` pattern `endMonth` already uses on the next line, falling back to `''` (safe: "not yet fired") rather than trusting an unvalidated string.
- **Lower-priority, deferred**: Goals' `startDate`/`endDate`/`completedDate` go through an unvalidated pass-through (`cellToDateStr`) and can silently blank out when a goal is reopened and saved if Sheets ever reformats them — cosmetic, not a balance/calculation bug, since no goal logic compares against these dates. `getAllInvestRows()`'s `new Date(r.date)` conversion (`index.html`) would produce `NaN` fields for a date `parseAnyDateToISO()` still can't parse — now a much smaller residual risk after this session's parser fix. Both are real but non-critical; left for a future cleanup pass rather than expanding scope further in this session.

**Process note**: no code changes in this session touch the Google Sheets API/schema (no `numberFormat` changes) — every fix here is a pure client-side JS logic change, verified directly in-browser against real and synthetic inputs, precisely because a live spreadsheet to test schema changes against wasn't available. The systemic fix (explicit column formatting) is the durable cure and is recommended as the next session's starting point.

#### Session 30: Implemented Session 29's Recommended Systemic Fix — Explicit `numberFormat` on Every Date Column (Claude)
- **Change**: added `ensureDateColumnFormats()` (`data-store.js`) — a one-time-per-browser migration (same pattern as `LS_SPLIT_MIGRATED`) that issues a single `batchUpdate` pinning `numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' }` on every date column identified in Session 29's audit: `Opex!A`, `Invest!A`, `Config!J` (`balanceDate`), `Goals!B/C/G` (`StartDate`/`EndDate`/`CompletedDate`), `Recurring!J/L` (`lastFired`/`endMonth`). Wired into all three `bootstrap()` paths (cached spreadsheet, freshly-found existing spreadsheet, brand-new spreadsheet), guarded by a new `LS_DATE_FORMAT_MIGRATED` flag.
- **Verified against the live spreadsheet** (`Nota Data`, the reporting user's real Drive file): confirmed `Opex!A2` is a genuine date-typed cell with no explicit number format ("Automatic"), currently rendering as `23/04/2019 07:0...` (locale-dependent `DD/MM/YYYY HH:MM:SS`) — exactly the mechanism Session 28/29 diagnosed. The fix pins the format going forward; it will apply the next time this user's browser calls `bootstrap()` (next sign-in), since the migration flag lives in `localStorage`, not a hardcoded run against production during this session.
- **Note**: this only fixes the *read-back format*, matching Session 29's framing — it doesn't retroactively re-validate already-corrupted values (that's what Session 28/29's `parseAnyDateToISO()` hardening already covers).
- **Confirmed live**: the reporting user signed in with the updated app and the `Nota Data` spreadsheet's `Opex!A` column immediately rendered as `2026-04-23`-style ISO instead of the old locale `23/04/2019`; all other date columns (`Invest`, `Config`, `Goals`, `Recurring`) confirmed the same.
- **Also closed Session 29's two deferred, lower-priority items**:
  - **`handleGetGoals()` (`data-store.js`)**: `startDate`/`endDate`/`completedDate` now route through `parseAnyDateToISO()` first (falling back to the old bare `cellToDateStr()` pass-through only if that fails to parse), instead of trusting the raw cell string unconditionally — same validate-and-normalize treatment Session 28/29 already gave Invest dates, extended here defensively even though Goals dates aren't currently known to be corrupted.
  - **`getAllInvestRows()` (`index.html`)**: guarded the `new Date(r.date)` conversion for local unsynced Invest rows — an unparseable `r.date` used to silently produce `NaN` for `y`/`m`/`d`/`mk` (the same "NaN quietly poisons a downstream comparison" class as the core bug); now falls back to `0`/`''` with a `console.warn` instead of injecting `NaN`, and the row is no longer silently corrupted (still shown, just without a usable date/month key).

#### Session 31: Fixed Invest Buy Transactions Double-Subtracting the Funding Account's Balance (Claude)
- **Bug**: reported by a user — after buying stock/FX funded from `CIMB IDR`, Insights and Net Worth → Holdings showed `CIMB IDR`'s balance dropped by *twice* the invested amount (e.g. a 1,000,000 IDR Buy showed a 2,000,000 drop).
- **Root cause**: `handleInvest()` (`data-store.js`) intentionally dual-writes every Buy — an `Invest` sheet row *and* a linked `Opex` row (`cat='Investment'`, `pm`=funding account, `exp`=totalIdr), joined by `opexTxId`. `computeAccountCurrentBalance()` (`ui-settings.js`) summed **both**: Step 1 (`HIST.opex` deltas) counted the linked Opex row, and Step 3 (Invest-row deltas) counted the same Buy again — for any **IDR** account.
- **Fix**: Step 3 now skips a `Buy` row whenever it carries a truthy `opexTxId` (already counted via Step 1's linked Opex row); `Sell` rows and not-yet-synced local `Buy` rows (no Opex counterpart yet) are still counted, since they're not double-represented.
- **Follow-up audit**: checked every other function that reads Invest rows for balance/valuation math (`computeCashBalance`, `computeInvestNetLots`, `renderNetWorth`, `isFxAccountMatch`, `getAssetValue`, `getGoalCurrentValue`) for the same exposure — all safe except one: `buildAccountBalances()`'s **non-IDR/FX branch** had the same bug in a worse form. Step 1 has no category filter, so it counted the linked `cat='Investment'` Opex row *in addition to* the correct native-currency depletion already computed via `netLot`/`computeInvestNetLots` — and since that Opex row's amount (`totalIdr`) is always IDR-denominated even when the funding account is USD/other FX, it was being subtracted as if it were native-currency units (a ~16,500× unit-mismatch on top of the double-count). **Fix**: Step 1 now also skips `cat === 'Investment'` Opex rows whenever `includeInvestIdr` is `false` — the flag that, per its only two call sites, exactly identifies the FX/non-IDR branch.
- See **[Invest ↔ Opex dual-write](#invest--opex-dual-write-avoiding-double-counting)** below for the do's/don'ts this session's fix is codified into.

#### Session 32: Instant Launch & Deferred Sign-In UX (Antigravity/Gemini)
- **Problem**: iOS PWAs cannot perform silent background OAuth token refresh (`prompt: 'none'`) because Safari isolates cookie jars between PWAs and standard Safari, and blocks background popups without a direct user gesture. This resulted in returning users being blocked by the full-screen Google sign-in splash page on every app launch.
- **Fix**: Implemented a two-phase auth strategy for returning users (spreadsheet ID cached in localStorage):
  - **Phase 1 (Instant Launch)**: `Auth.ready` resolves immediately on load, completely bypassing the splash screen. The app paints instantly and loads the entire operational history from the local cache (`notapub_opex_cache_<spreadsheetId>` in localStorage, already implemented in Session 15).
  - **Phase 2 (Deferred Sign-In on First Tap)**: Actual Sheets API calls are blocked on a private `_tokenReady` promise. A capture-phase one-shot event listener (`touchstart` / `mousedown`) is registered globally. The user's very first interaction anywhere on the screen acts as the gesture that triggers `Auth.triggerFirstTapSync()`, opening the Google OAuth popup to silently refresh/verify the token and resolving `_tokenReady`.

#### Session 33: Credit Card Billing Cycles & Credit Limit Monitoring (Antigravity/Gemini)
- **Billing Cycles**: Added `billingDate` (1-28) to Credit Card Payment Methods in Settings, persisted in the Config sheet (Column M). `getRows()` now uses `applyBillingCycle(r)` to dynamically re-bucket CC transactions occurring after the billing date into the *next* calendar month for all Insights charts.
- **Search Monitor Re-Bucketing**: The Search Monitor also applies this billing cycle re-bucketing dynamically, but *only* when the dropdown filter is set to a specific Credit Card Payment Method that has a billing date configured. When viewing "All Accounts", transactions remain in their strict calendar month to prevent mixed bucketing. Added a dynamic subtitle (e.g., "Billing cycle: 26 Jul – 25 Aug") when billing cycle mode is active.
- **Credit Limit Progress Bar**: Added `creditLimit` to Credit Card PMs in Settings (Column N). When filtering the Search Monitor by a CC PM that has both a billing date and credit limit, a progress bar appears showing the current cycle's total credit usage vs. the limit.
- **Installment Credit Usage**: The credit usage calculation automatically detects active `(N/M)` installment rules from `RECURRING_RULES`, computes the number of remaining months, and adds the total outstanding principal to the current billing cycle's usage, giving a true picture of remaining credit limit.

#### Session 34: Fixed Home Calendar Permanently Stuck on Skeleton After Sign-In, Then a Same-Day Follow-On Regression (Claude)
- **Bug**: After signing in (web, iOS PWA, and mobile browser alike), the home calendar showed only the placeholder skeleton grid (`initCalendarSkeleton()`) forever — no transaction data for the current month or any previous month, no error, no retry. Third occurrence of this general bug class after Sessions 10 and 11.
- **Root cause**: `initCalendar()` only replaces the skeleton once `loadHistData()` resolves, but `loadHistData()` and `fetchCurrentMonth()` (`index.html`) called the raw monkey-patched `fetch()` directly instead of the codebase's own `fetchWithTimeout()` helper (already used at ~15 other call sites). That raw fetch routes through `requireReady()` → `Auth.ready` and `SheetsClient.authedFetch()` → `Auth.getAccessToken()` → `_tokenReady` (`auth.js`), and Session 32's two-phase auth rewrite left two real gaps where those promises can be **permanently unresolved** with no timeout anywhere above the network layer: (1) a fresh sign-in's `DataStore.bootstrap()` had two branches with no try/catch around one-time migration steps, so a transient hiccup threw out of `bootstrap()` and `signIn()`'s catch never resolved `Auth.ready`; (2) a returning user's first-tap token flow (`triggerFirstTapSync()`) never resolved `_tokenReady` on failure, so every subsequent Sheets call hung forever. Both `loadHistData()`/`fetchCurrentMonth()` also swallowed every error internally and never rejected, so the retry-with-backoff logic already written for this exact scenario was unreachable dead code.
- **Fix**: Routed both `loadHistData()` and `fetchCurrentMonth()` through `fetchWithTimeout()` so a stuck auth wait now surfaces as a bounded rejection instead of hanging forever, and wrapped `bootstrap()`'s remaining unprotected one-time migration calls (`migrateToSplitSheets`/`ensureDateColumnFormats`, all self-guarded by their own localStorage flags) in try/catch so a migration hiccup can't strand `Auth.ready`. Verified by reproducing the hang locally (blocked auth popup) and confirming `initCalendar()` now runs with a real, if degraded, calendar instead of the stuck skeleton.
- **Follow-on regression (same day)**: The 12s timeout first chosen for `loadHistData()`'s one-time full-history fetch (`type=allOpex`) was too tight for an account with years of transactions — the request could legitimately still be downloading past 12s with nothing actually wrong, so it got abandoned and `HIST.opex` fell back to `[]`. Current month kept working (fetched separately by `fetchCurrentMonth()`), but **every previous month vanished from both the home calendar and Insights**. The give-up path had also never backfilled `HIST.opex` from anything — only `txCat`/`txPm` were restored.
- **Follow-on fix**: Raised `loadHistData()`'s timeout to 30s (a one-time full load can afford to wait longer than a fast interaction), and added a fallback in the give-up path that reads `data-store.js`'s own last-known-good copy of the same payload (`notapub_opex_cache_<spreadsheetId>`, already kept by `handleGetAllOpex()`'s stale-while-revalidate cache, via the existing `DataStore.getSpreadsheetId()` getter) so a timeout now degrades to "yesterday's history" instead of "no history at all". Verified by stubbing the fetch to always fail and confirming `HIST.opex` backfills from a seeded cache entry instead of staying empty.
- **Lesson**: when converting an unbounded `await` into a bounded one to fix a hang, check what the timeout/failure branch actually does with state that was previously always fully populated on the (infinite-wait) success path — "bounded but empty" can be a worse regression than "unbounded but eventually correct" if nothing sensible fills the gap.

#### Session 35: Fixed Installed iOS Home Screen App (Standalone PWA) Permanently Stuck on Skeleton — Fourth Occurrence, and the Gap Session 34 Flagged but Never Closed (Claude)
- **Bug**: On an installed "Add to Home Screen" iOS app specifically (not a normal Safari tab, where the app works fine), the Google sign-in popup opens and closes on its own, and the home calendar is left on its skeleton indefinitely — no error, no retry, recoverable only by removing and re-adding the Home Screen icon.
- **Root cause**: two gaps Session 34 either introduced or explicitly flagged but didn't fix: (1) `ui-settings.js`'s `fetchCurrentMonthFresh()` — a sibling of the functions Session 34 fixed — still called raw, unbounded `fetch()`, so it could hang forever inside the warm-cache boot path's `Promise.all(...)` and leave the "Loading data…" toast stuck even though the calendar itself had already rendered from cache; (2) `auth.js`'s `_tokenReady` promise is only ever resolved on a *successful* token request — `triggerFirstTapSync()`'s catch branch showed the sign-in overlay on failure but never resolved or rejected `_tokenReady`, so it stayed permanently pending for the rest of the page load and `getAccessToken()`'s unbounded `await _tokenReady` stranded every caller already waiting on it. Nothing in the codebase had any awareness of iOS standalone/display-mode at all. The "popup opens and immediately closes" signature is consistent with known WebKit/GIS limitations of the standalone webclip runtime (broken `window.opener`/postMessage relay to GIS, and/or Google's own embedded-user-agent policy) — not something fixable purely in this app's JS, so the fix focuses on making failure fast, visible, and recoverable in-app rather than patching the popup mechanics themselves.
- **Fix**: Routed `fetchCurrentMonthFresh()` through `fetchWithTimeout()` like its siblings. Made `_tokenReady` re-armable: a failed token attempt now rejects the current promise (unblocking anything already waiting) and arms a fresh one, and fires a new `notaTokenStuck` window event; `getAccessToken()`'s deferred-mode wait is now bounded by the same event as defense-in-depth, throwing instead of hanging (deliberately *not* auto-retrying the popup from a non-gesture context). Added a small Home-page recovery banner (separate from the existing full-screen sign-in overlay, which is copy-written for brand-new users) that appears on the `notaTokenStuck` event or a 9-second watchdog, with a "Retry sign-in" button (calls `Auth.signIn()`, now returning true/false so the caller can tell whether it actually worked) and, on detected standalone mode (`navigator.standalone` / `display-mode: standalone`), an explicit "Open Nota in Safari instead" escape hatch, since Safari was already confirmed to work reliably. Also made the sign-in overlay's copy conditional on whether a spreadsheet already exists, so a returning user retrying doesn't see "create your own private spreadsheet" text meant for first-time setup.
- **Lesson**: a promise-based "resolve once, from one success path" gate (like `_tokenReady`) is a latent permanent-hang risk the moment *any* of its resolve-sites can be reached via a failure branch instead — if a gate can fail, its failure path needs to unblock waiters (reject) just as deliberately as its success path resolves them, not just show a UI element and hope the user notices before giving up.

#### Session 36: Fixed "Retry Sign-In" Banner Falsely Appearing on Almost Every Normal Launch — Two Independently-Tuned Timeout Budgets Never Reconciled (Claude)
- **Bug**: reported by the user — since Session 35 shipped, every app launch required tapping a "Retry sign-in" banner to get the full calendar to load, even though the Google sign-in popup itself flashed and succeeded correctly every time. Before Session 35, the flash popup alone was always enough.
- **Root cause**: Session 35's stuck-recovery watchdog (`STUCK_WATCHDOG_MS = 9000`, `index.html`) fires a fixed 9 seconds after launch and shows the banner if the "Loading data…" toast is still spinning — but that same toast stays up until `loadHistData()` resolves, and `loadHistData()`'s own timeout was deliberately widened to **30 seconds** by Session 34's follow-on fix specifically because a full transaction-history sync can legitimately take that long. Combined with Session 32's deferred-first-tap gating (the real network call can't even start until the user's first tap resolves the OAuth token), the "Loading data…" toast was almost always still spinning at the 9-second mark on a normal launch — even though sign-in had already succeeded — so the banner fired as a false positive nearly every time. Two sessions each picked a reasonable-looking number for a different purpose and never cross-checked them against each other. A second, independent false-positive source: `getAccessToken()`'s deferred-mode wait (`auth.js`) fired the same `notaTokenStuck` event whenever the user simply hadn't tapped the screen within 10 seconds of page load — normal behavior (e.g. glancing at the screen before touching it), not evidence of a real failure, but indistinguishable from one to that code.
- **Fix**:
  - Extracted `HIST_LOAD_TIMEOUT_MS` (`index.html`) as the single source of truth for `loadHistData()`'s 30s budget, and derived `STUCK_WATCHDOG_MS` from it (`HIST_LOAD_TIMEOUT_MS + 1500 + 8500` = 40s) so the watchdog can never silently drift out of sync with the fetch it's supposed to be watching again. The fast, deterministic `notaTokenStuck` event (a real token-request failure) is untouched and still fires immediately — this only fixes the slower, broader backstop that was misfiring on healthy-but-slow loads.
  - Added `Auth.hasAttemptedFirstTap()` (`auth.js`, backed by a new `_firstTapAttempted` flag) so `getAccessToken()`'s deferred-wait timeout only dispatches `notaTokenStuck` if the user actually attempted a token request — "no tap yet" is no longer treated as a failure signal.
  - Per the user's request to minimize taps needed to fully launch the app: the banner's "Retry sign-in" button logic was extracted into a shared `attemptRecovery()` function, and once the banner is showing for a genuine reason, the user's very **next tap anywhere on screen** (not just a precisely-aimed hit on the small button) now triggers the same recovery — guarded by `Auth.hasAttemptedFirstTap()` so this new listener can never fire concurrently with the original one-shot first-tap listener on the same click (which would otherwise risk two overlapping `requestToken()` calls stomping each other's `tokenClient.callback`).
  - The banner now also auto-hides itself (`hideStuckBanner()`, bound from inside the banner's IIFE to a small holder declared in the outer `DOMContentLoaded` scope) when the cold-load data fetch finishes on its own — so a banner that appears right before a normal (if slow) load completes doesn't need a tap at all.
- **Lesson**: when two different sessions each add their own timeout/watchdog around the same underlying operation, check the two numbers against each other explicitly — a UI-facing "is this stuck yet?" check must never be tighter than the operation's own already-established "how long is this allowed to legitimately take?" budget, or the check becomes a false-positive generator instead of a safety net. Deriving one budget from the other (rather than picking both independently) makes this class of bug structurally impossible to reintroduce.

#### Session 37: Fixed 30+ Second Blank-Skeleton Wait on Every "Reopen After a Break" Launch — the No-Cache Boot Path Blocked the Fast Fetch Behind the Slow One (Claude)
- **Bug**: reported by the user immediately after Session 36 — the false-positive banner was gone, but a single tap-anywhere still left the calendar on its skeleton for ~35 real seconds before anything appeared, and tapping again during that wait did nothing. Only after the watchdog fired at ~35-40s did a second tap "fix" it, which looked like sign-in needed retrying even though the very first tap's Google popup had already flashed and succeeded.
- **Root cause**: two compounding issues, neither of them the banner itself:
  1. The no-cache boot branch (`index.html`) called `await loadHistData()` (the full multi-year history sync, budgeted up to `HIST_LOAD_TIMEOUT_MS` = 30s+) **before** even starting `fetchCurrentMonth()` (budgeted ~15s) — and `initCalendar()` doesn't run until both are done. The current month is all the calendar actually needs to stop being a skeleton, but it was made to wait behind the much slower full-history fetch for no structural reason.
  2. This "no cache" branch isn't just for brand-new users — the existing 30-minute inactivity timeout (`onInactive()`, `index.html`) deliberately clears `curMonthCacheKey()` on every idle reload (to avoid stale data on an unattended device) but leaves `notapub_txCat` alone, so the cold-boot condition `cachedHistLoaded && cachedCurMonth` fails and **every reopen after a short break** — not just first launches — takes this slow, sequential path. Once the watchdog did fire and the user tapped "Retry sign-in," `attemptRecovery()` unconditionally called `Auth.signIn()` again even though the very first tap had already obtained a perfectly valid token — a second, wasted OAuth popup flash that had nothing to do with the actual bottleneck (the slow fetch), creating the illusion that a second sign-in attempt was what fixed it.
- **Fix**:
  - No-cache branch now fires `loadHistData()` and `fetchCurrentMonth()` concurrently instead of sequentially; `initCalendar()` runs as soon as the current-month fetch resolves (typically a few seconds), while the full history continues loading in the background and triggers one more re-render (picking up older months and any `HIST.opex`-derived aggregates) once it settles — the same pattern the cache-hit branch already used, now applied here too.
  - `isStillStuck()` (`index.html`) no longer treats a lingering "Loading data…" toast as evidence of being stuck — only the calendar's own render state (`!calInited`) counts now, since a background full-history sync legitimately outliving the toast is no longer blocking a real, already-rendered calendar. The independent, immediate `notaTokenStuck` event (a real token failure) is unaffected and still fires right away.
  - Added `Auth.hasValidToken()` (`auth.js`) and used it to make `attemptRecovery()` (`index.html`) skip `Auth.signIn()`'s OAuth popup entirely when a valid token is already in hand, re-kicking just the data fetch instead — eliminating the redundant second popup flash and making a genuine retry near-instant instead of restarting the whole sign-in dance.
- **Lesson**: a "stuck" recovery mechanism can be perfectly correct in isolation (Session 36) and still produce a bad experience if the thing it's protecting against — a slow-but-legitimate cold-boot sequence — was itself avoidably slow. Fix the actual bottleneck (don't block a fast, sufficient fetch behind a slow, non-essential one) before reaching for a longer timeout or a friendlier retry button; the best "stuck" UX is not needing the recovery path at all in the common case.

#### Session 38: Session 37's Fix Only Halved the Wait, Not Eliminated It — `fetchCurrentMonth()` Was Never Actually the Fast One (Claude)
- **Bug**: reported by the user immediately after Session 37 — the wait dropped from ~35s to ~20-25s (a real improvement), but the calendar still sat on its skeleton that whole time with taps doing nothing, and a manual retry was still needed at the end.
- **Root cause**: Session 37's premise — "`fetchCurrentMonth()` is bounded far faster (~15s) than the full history sync (~30s+)" — was wrong. `handleGetMonth()` (`data-store.js`, the handler behind `fetchCurrentMonth()`) has **no server-side cache of its own** and unconditionally re-fetches the **entire** `Opex!A2:K` range — the exact same Sheets API cost as `handleGetAllOpex()` (behind `loadHistData()`) — then just filters the result down to the current month client-side. It is not reliably faster at all; for a sizable sheet the two calls take comparable time. Session 37's fix ran both fetches concurrently (a real improvement — roughly halving the wait, from sequential to parallel), but still specifically raced the **first render** against `fetchCurrentMonth()`'s own completion (with a 15s fallback timer), so it stayed gated on whichever of the two happened to be slower that run — never on the genuinely faster one. Meanwhile `handleGetAllOpex()` *does* have its own stale-while-revalidate `localStorage` cache (`notapub_opex_cache_<spreadsheetId>`) and, when warm, resolves near-instantly regardless of network conditions — and since it fetches the whole sheet too, it already contains a fully correct current month by itself, with no need to wait on `fetchCurrentMonth()` at all in that case.
- **Fix**: the no-cache boot branch (`index.html`) now races the first render against **whichever of `loadHistData()` / `fetchCurrentMonth()` resolves first** (`Promise.race([_histFetch, _monthFetch.catch(() => {})])`), instead of specifically waiting on `fetchCurrentMonth()`. Whichever one is still in flight keeps running in the background and triggers one more re-render via `Promise.all(...)` once both settle, same as before. A warm `handleGetAllOpex()` cache now unblocks the calendar almost immediately even with no client-side month/history cache at all (plausible even for a longtime user — iOS can silently evict `localStorage` under storage pressure, per the existing `navigator.storage?.persist?.()` call already in this same boot sequence); with no cache anywhere, the wait is now bounded by the faster of two comparable fetches instead of artificially extended by racing against the wrong one.
- **Lesson**: when reasoning about which of two calls is "the fast one," verify the actual server/handler-side cost of each — a name like `fetchCurrentMonth()` invites the assumption that it's doing less work than a full-history fetch, but the two can share the exact same underlying implementation and cost. Don't fix a "raced against the wrong thing" bug by picking a better fixed timeout for the wrong thing (Session 37's `15000` → still the wrong gate); race against the actual faster signal instead.

#### Session 39: Real Root Cause Found for the Cold-Boot Wait — Installed iOS PWA Throttles the Page's Own Timers While the GIS Popup Has Focus (Claude)
- **Bug**: Sessions 37 and 38 each measurably improved the boot-time wait (35s → 25s → 32s) without ever eliminating it, and a manual second tap (reopening a second popup) was still required every time. Diagnostic questions to the reporting user finally isolated the actual cause: (1) **nothing at all** — no full sign-in overlay, no small recovery banner — appears on screen during the entire 30+ second wait, ruling out both the "slow data fetch" theory (Sessions 37/38) and a fast, cleanly-failing token request (which would show the full overlay within ~6-8s); (2) the user is on an **installed iOS Home Screen app** (standalone PWA), the exact context README Session 35 already flagged as having known WebKit/GIS popup limitations.
- **Root cause**: on an installed iOS PWA, the GIS OAuth popup opening (even the "flash" first-tap silent-reuse attempt) can take focus away from the parent page, and WebKit can throttle or fully pause that backgrounded page's JS timers while it doesn't have focus — including the plain `setTimeout()` inside `requestToken()` (auth.js) that's supposed to guarantee a bounded 6-second failure detection, and everything chained after it (the stuck-recovery banner's own watchdog, `notaTokenStuck` dispatches). If the popup closes without ever invoking its own success/error callback (the standalone caveat Session 35 already documented), the app can be left with literally nothing scheduled to notice — not a slow-but-progressing fetch, a genuinely frozen page — until some later, unrelated event (in the user's reports: their own next tap) happens to resume the JS timer queue. That's why a "second tap" was always required and always seemed to trigger "another flash popup, then it works": the second tap wasn't retrying anything on purpose, it was just what unfroze the page enough for the already-overdue failure detection to finally run, surfacing the recovery mechanism whose own next tap then genuinely did retry sign-in.
- **Fix**: added a `visibilitychange`/`focus` listener in `auth.js` that fires the moment the page regains foreground visibility (an event WebKit still delivers reliably even when plain timers are throttled) — if the app is still waiting on a token whose first-tap attempt has already started (`_deferredMode && _firstTapAttempted`) once refocused, it dispatches `notaTokenStuck` after a short 750ms grace period (letting a callback that's about to succeed on its own, now that the page is unthrottled, finish first rather than racing ahead of it) instead of waiting on whatever timer might still be paused. Combined with Session 36's tap-anywhere recovery, this collapses the dead time from ~30s of a frozen, unresponsive screen down to under a second before the recovery banner — and a working retry path — becomes available.
- **Lesson**: three consecutive numeric-timeout fixes (Sessions 37, 38) each nudged the symptom without addressing the cause, because the actual mechanism (JS timer throttling on a backgrounded popup) doesn't respect any timeout value at all — no `setTimeout` duration is reliable if the platform can pause the timer queue itself. When a fix based on solid reasoning about the code doesn't move a *reported, user-observed* symptom, stop iterating on more timeout numbers and go get direct evidence instead — a couple of targeted disambiguating questions (what's literally visible on screen, what platform) here ruled out two entire theories in one round and pointed straight at the real mechanism. Recovering from any state a JS timer can't reliably detect needs a signal the platform delivers independent of the timer queue — `visibilitychange`/`focus` here, not a better guess at how many milliseconds to wait.

#### Session 40: Cold-Launch Blank Screen, and an Experimental Fix for the Remaining Two-Tap Sign-In on Installed iOS PWA (Claude)
- **Follow-up reports after Session 39**: the frozen-timer bug was confirmed fixed (banner now appears "directly, without delay" after the failed first popup), leaving two remaining, distinct issues: (1) a cold launch on an installed iOS Home Screen app showed ~10s of a bare black screen, then ~3s of white, then the calendar skeleton — before anything was interactive; (2) reliably still needing exactly 2 taps (first tap's silent popup attempt always fails on this platform per every report so far, then an explicit tap on the recovery banner always succeeds) to fully sign in.
- **Root cause (blank screen)**: two render-blocking resources were holding up the very first paint on a cold connection, independent of any auth logic. `index.html`'s Google Fonts `<link rel="stylesheet">` was a standard blocking stylesheet — browsers hold all rendering until it resolves. Separately, `config.js`/`sheets-client.js`/`data-store.js`/`auth.js` (`index.html`, no `async`/`defer`) are fetched and executed **sequentially**, each blocking further HTML parsing, before the calendar skeleton or any JS-driven UI can appear. The page's own dark background (`--bg:#000`) rendering correctly but with *nothing on top of it yet* is what read as a "blank black screen" rather than a loading one.
- **Fix (blank screen)**:
  - Google Fonts now loads via the standard non-blocking pattern (`<link rel="preload" as="style">` + a `media="print"`/`onload` swap + `<noscript>` fallback) — safe because the font URL already carries `&display=swap` and `body{font-family}` already has solid system-font fallbacks, so there's no unstyled-text risk either way, just no more blocking the page's first paint on it.
  - Added a static, pure-HTML/CSS boot splash (`#notaBootSplash` — the Nota icon, a gentle CSS-only pulse animation, system-font-only text) as the very first element in `<body>`, with **no JS or external-resource dependency** — it's the earliest thing that can possibly paint, before webfonts or the app's own scripts have loaded, well before `Auth.js`'s own JS-driven splash overlay can run. Removed at the very top of the `DOMContentLoaded` handler, the instant real content is about to take over, so there's no visible gap or double-flash.
  - **Deliberately not done this session**: adding `defer` to the four blocking scripts, which would likely meaningfully shrink the wait further. This codebase has broken this exact way twice before from a script-ordering change (Sessions 21, 22 — a top-level cross-file reference silently throwing and halting the rest of that script's execution, with no visible error). Needs a dedicated audit of everything between those script tags and the end of `<body>` before attempting it, not a same-session drive-by change.
- **Root cause (2-tap sign-in) — working theory, not confirmed**: `triggerFirstTapSync()`'s silent first attempt and the recovery banner's retry both call the exact identical `requestToken('')` with identical timing — there's no structural difference in the code between the attempt that always fails and the one that always succeeds. The best available theory (matching Session 35's original diagnosis that the *silent* relay specifically is what's broken in standalone webclip WebKit, not interactive popups generally): Google's own SDK likely only falls back to a lighter, interactive-style flow after a first silent (`prompt:''`) attempt fails within the same page load — the retry isn't succeeding because it's a "second attempt," it's succeeding because it's not attempting the silent path.
- **Fix (experimental)**: for installed-standalone mode only (`Auth.isStandalone()`, hoisted out of the banner's own local copy into `auth.js` as the single source of truth), the very first tap now requests `prompt:'select_account'` instead of `prompt:''`, skipping the silent step outright instead of waiting to fail it first. Every other context (regular Safari tab, Android, desktop) is unchanged — the silent-reuse flow already works invisibly and reliably there. Known, disclosed trade-off: `select_account` can occasionally show a visible account-chooser needing a tap even on a single-account device — this could turn "always 2 taps for one reason" into "usually 1, occasionally still 2 for a different reason" rather than reliably eliminating the second tap. Not verifiable without live device testing; flagged here as experimental for a future session to confirm or revert.
- **Lesson**: when a fix's justification is genuinely "this is the only different thing I can find to try, and I can't verify why the current behavior happens" rather than a mechanism you can trace end to end, say so explicitly (as here, and to the user before shipping it) rather than presenting a guess with the same confidence as a diagnosed fix — the next session (or the next bug report) needs to know this one is unverified, not settled.

#### Session 41: Session 40's Experiment Partially Worked, Exposed Three New Bugs — Fixed at the Root Instead of Patching Each Symptom (Claude)
- **Bug**: Session 40's `select_account` experiment did work as intended — the account chooser appeared — but the user then still got stuck: "Reconnecting to Google" appeared right after choosing an account, then a retry popup flashed, then the small banner showed, then the flow ended stuck on what looked like the boot splash again.
- **Root causes, three separate issues found by tracing the reported sequence against the code**:
  1. `requestToken()`'s internal timeout was a **fixed 6 seconds regardless of prompt mode** (`auth.js`). That's fine for `prompt:'none'` (never shows UI, resolves or fails near-instantly) but nowhere near enough for `prompt:'select_account'` (Session 40's own change), which requires a real human to notice the picker, read it, and tap their account. If the callback arrived even a moment after the 6s timer fired, `requestToken()` had already rejected and silently discarded the late success (`if (settled) return;`) — so choosing an account could genuinely succeed on Google's side while the app had already given up and shown "Reconnecting to Google."
  2. The small recovery banner is only ever hidden by its **own** retry path (`attemptRecovery()`, `index.html`) — `auth.js` has no way to tell it "a token was obtained" when sign-in instead completes via the full overlay's own "Sign in with Google" button. The banner could sit stale — hidden behind the higher z-index overlay while it's up, then re-exposed once the overlay closes — even after sign-in had already succeeded.
  3. Session 39's refocus-based rescue (for WebKit throttling/pausing this page's timers while a popup has focus — see that session) was wired as a **module-level watchdog scoped only to the first deferred-mode tap** (`_deferredMode && _firstTapAttempted`). By the time a *retry* attempt runs (via the overlay's button or `signIn()`), `_deferredMode` is already `false`, so nothing was watching for the exact same freeze recurring on that attempt — matching the final "stuck on the boot-splash-like overlay" symptom.
- **Fix**: rather than patch each symptom where it was noticed, moved the fix to the shared root all three calling paths go through — `requestToken()` itself (`auth.js`):
  - Two timeout tiers: `SILENT_PROMPT_TIMEOUT_MS` (6s, for `prompt:'none'` only) vs. `INTERACTIVE_PROMPT_TIMEOUT_MS` (45s, for every prompt that can show UI a human has to act on — `''`, `'select_account'`, etc.).
  - The refocus-based rescue (previously the module-level watchdog from Session 39) now lives **inside `requestToken()`'s own promise**, checking real elapsed time against `timeoutMs` on `visibilitychange`/`focus` — so it applies uniformly to every caller (first tap, the overlay's button, the banner's retry) instead of only the one path the old watchdog covered. The old module-level watchdog was removed as redundant now that the fix lives at the shared root.
  - `auth.js` now dispatches a `notaTokenObtained` event from a single `_resolveTokenReady()` helper used by all three success paths (new-user sign-in, first-tap sync, `signIn()` retry); `index.html`'s banner listens for it and hides itself regardless of which path actually completed sign-in, closing the staleness gap.
- **Lesson**: when three symptoms trace back to the same root call (`requestToken()`) being used in more ways than it was originally designed for (only silent, only one caller, only fixed short timeouts), fix the shared root once rather than adding a patch at each call site that happened to surface a symptom — a fix scoped to "the one path that broke" reliably misses the next path that breaks the same way, as this session's bug #3 (Session 39's own watchdog, working exactly as designed but only for the path it was scoped to) demonstrates directly.

#### Session 42: `getAccessToken()`'s Own Wait Timeout Was Never Reconciled With Session 41's Longer Interactive Timeout (Claude)
- **Bug**: after Session 41 shipped, the frozen-dead-zone and silently-discarded-success bugs were both confirmed fixed — but the user still needed 2 taps: choosing an account in the picker was followed by landing back on the skeleton calendar with the recovery banner up, before a second tap ("anywhere") finally loaded full data.
- **Root cause**: the exact same class of bug fixed twice before in this app (Sessions 37-38's watchdog-vs-fetch mismatch; Session 41's `requestToken()`-timeout-vs-interactive-prompt mismatch), now surfacing one layer up. `requestToken()`'s own timeout for an interactive prompt is a generous 45s (`INTERACTIVE_PROMPT_TIMEOUT_MS`, Session 41) — but `getAccessToken()` (`auth.js`), the function `loadHistData()`/`fetchCurrentMonth()` actually wait on for a token, had its own **separate, still-hardcoded 10-second** `TOKEN_WAIT_TIMEOUT_MS`, never updated when the 45s change went in. If choosing an account in the picker took more than ~10 real seconds (normal — reading the list, deciding, tapping), this shorter timeout fired first: it showed the recovery banner and made the data fetch fall back to degraded/cached data, seconds before the real sign-in (still legitimately in-flight underneath, well within its own 45s budget) succeeded on its own.
- **Fix**: `TOKEN_WAIT_TIMEOUT_MS` is now derived from `INTERACTIVE_PROMPT_TIMEOUT_MS + 2000` instead of an independent hardcoded number, guaranteeing it can never fire before the token request it's waiting on could have possibly settled — the same "derive one budget from the other" principle applied in Sessions 37/38 and 41, applied here at a third layer. Waiting the full duration is safe now specifically because the frozen-dead-zone problem was already fixed at the `requestToken()` level (Sessions 39/41) — the user is actively interacting with a real popup during this wait, not staring at an unresponsive screen.
- **Lesson**: this is the third time in this app's history that two timeouts guarding the same underlying operation were tuned independently and drifted apart (README's "Config Persistence Pattern" section documents a similar "single source of truth" principle for a different kind of duplication — the same discipline applies to timeout budgets). Whenever a timeout value changes, grep for every *other* timeout that bounds a wait on the same operation (here: anything waiting on `_tokenReady`/`requestToken()`) before considering the change complete — a longer inner budget with a shorter outer watchdog is strictly worse than either alone, since it changes "sometimes/rarely too slow" into "reliably races and loses."

#### Session 43: Broke the "Re-Tune the Next Mismatched Pair" Cycle — Fixed the Whole Nested-Timeout Chain at Once, Plus a New Regression From the Boot-Splash Speedup (Claude)
- **Bug**: Session 42's fix (reconciling `getAccessToken()`'s wait with `requestToken()`'s 45s) made things measurably *worse* — a 3rd tap was now needed, and a new 13-second silent delay appeared between the first tap and the account-chooser popup even showing up.
- **Root causes, two separate issues**:
  1. **The nested-timeout chain has more than two links, and only the innermost pair had ever been reconciled.** `requestToken()` (45s) is wrapped by `getAccessToken()`'s wait (Session 42: 47s) — but *that* is itself wrapped by `loadHistData()`'s `fetchWithTimeout(..., HIST_LOAD_TIMEOUT_MS)` (still 30,000 — a budget sized before deferred-mode auth existed, for the sheet fetch alone) and by `fetchCurrentMonth()`/`fetchCurrentMonthFresh()`'s own hardcoded `10000`. Session 42 made the *inner* wait longer without touching these *outer* wraps, which is strictly worse than not touching either — it guaranteed the outer ones now fire before the inner one ever could succeed, for any interactive sign-in past ~10-30s (which, per every report so far, is all of them).
  2. **New regression from Session 40's own fix.** Making the calendar render near-instantly (removing the blank-screen wait) had a side effect nobody had reason to anticipate at the time: the page is now tappable *before* Google's own deferred `<script src="…/gsi/client">` has necessarily finished loading in the background. `requestToken()` silently awaits that script via `waitForGis()`'s polling before it can even open a popup — previously hidden behind the slower boot sequence's own incidental delay, now a real, visible, unexplained wait after the tap.
- **Fix**:
  - Broke the "find the next mismatched pair" cycle instead of re-tuning another single constant: `Auth.INTERACTIVE_PROMPT_TIMEOUT_MS` is now exposed from `auth.js` as the one shared source every outer wrap derives from — `HIST_LOAD_TIMEOUT_MS` (`index.html`) and a new `MONTH_FETCH_TIMEOUT_MS` (`index.html`, shared with `ui-settings.js`'s `fetchCurrentMonthFresh()`) are now `Auth.INTERACTIVE_PROMPT_TIMEOUT_MS + <their own original network-fetch budget>` instead of independent hardcoded numbers. `STUCK_WATCHDOG_MS` (already derived from `HIST_LOAD_TIMEOUT_MS`) picks up the new, larger ceiling automatically.
  - Also simplified `getAccessToken()` itself rather than re-tuning its constant a third time: once a real tap attempt is in flight (`_firstTapAttempted`), it now just `await`s `_tokenReady` directly instead of racing it against yet another independently-sized timeout — `requestToken()`'s own bound already guarantees `_tokenReady` settles one way or another, so there's nothing left to duplicate. The short defensive timeout is kept only for the genuinely different "nobody has tapped yet" case.
  - Added `<link rel="preload" as="script" href=".../gsi/client">` to give Google's sign-in script a head start on loading.
  - Added a purely informational `#connectingIndicator` (deliberately separate from the actionable `#stuckRecoveryBanner`, so an in-progress attempt and a failed one are never visually conflated) shown the instant the first tap fires and hidden once it settles either way — so the `waitForGis()` wait (or any other silent stretch before the popup opens) doesn't look identical to nothing happening.
- **Lesson**: fixing "the next mismatched timeout that got reported" one at a time (Sessions 37/38, 41, 42) is a losing game against a chain more than two links deep — each fix proves correct in isolation and the user-visible symptom barely moves, or moves backward, because a different, untouched link in the same chain becomes the new binding constraint. Once a timeout needs deriving from another, ask what *wraps* the one you just fixed too, and derive from one shared source (`Auth.INTERACTIVE_PROMPT_TIMEOUT_MS`, exported) instead of writing `otherThing + margin` at each layer by hand — the latter is what let this drift happen three times in the first place. Separately: a speed fix for one part of a flow (Session 40's boot splash) can silently move — not remove — a wait that used to be absorbed by whatever it sped past; check what the thing you made faster used to be inadvertently waiting on.

#### Session 44: Reverted the `select_account` Experiment Entirely — the Interactive Prompt Was the Actual Cause of Every Timeout-Cascade Bug Since (Claude)
- **Bug**: even after Session 43's full-chain reconciliation, the user reported the flow still needed a 3rd tap and was, in their words, worse than the pre-experiment behavior — and explicitly asked to compare against how sign-in worked before Session 40's `select_account` experiment.
- **Root cause, in retrospect**: the entire cascade of timeout-mismatch bugs from Session 41 onward (45s → 47s → 75s/85s, reconciled fully in Session 43) existed *only* to accommodate `prompt:'select_account'`'s fundamentally unpredictable, human-paced duration — reading and tapping an account chooser cannot be reliably bounded the way a silent exchange can. Every fix in that chain was individually correct given the premise that an interactive prompt was necessary, but the premise itself was the problem: `prompt:''` (silent), used everywhere in this app before Session 40, resolved within a few seconds in *every* real report gathered across this entire investigation — either a fast successful reuse or a fast failure — making the pre-experiment "sometimes need one retry tap" flow both faster and more predictable than anything the interactive experiment produced, no matter how well the surrounding timeouts were tuned.
- **Fix**: reverted the experiment rather than continuing to tune around it.
  - `triggerFirstTapSync()` requests `prompt:''` again in every context (standalone or not) — the standalone-specific `select_account` branch is removed entirely.
  - `requestToken()`'s timeout collapses back to a single `REQUEST_TOKEN_TIMEOUT_MS = 6000` for every prompt mode this app actually uses (`''`, `'none'`), removing the now-unnecessary silent/interactive tier split. If a genuinely interactive prompt is ever reintroduced, the guidance left in-line is to pass an explicit larger `timeoutMs` at that one call site rather than growing the shared default again.
  - `HIST_LOAD_TIMEOUT_MS` and `MONTH_FETCH_TIMEOUT_MS` (`index.html`) now derive from `Auth.REQUEST_TOKEN_TIMEOUT_MS` (6s) instead of the old `INTERACTIVE_PROMPT_TIMEOUT_MS` (45s) — shrinking back to ~36s and ~16s respectively (from ~75s/~55s), with `STUCK_WATCHDOG_MS` following automatically to ~46s (from ~85s).
  - **Kept, deliberately** — genuinely separate fixes for real bugs, independent of which prompt mode is used: the boot splash and non-blocking fonts (Session 40), tap-anywhere recovery (Session 36), the refocus-based rescue built into `requestToken()` itself (Sessions 39/41/43 — still valuable, since WebKit can throttle even a short timer), the `notaTokenObtained` event keeping the banner from going stale (Session 41), and the GIS-script preload hint plus `#connectingIndicator` (Session 43 — still relevant, since GIS-load time is independent of which prompt is requested).
- **Lesson**: when a chain of individually-correct fixes keeps failing to move the user-reported symptom (or moves it backward), stop asking "which timeout is still wrong" and ask "was the thing that made a timeout necessary in the first place actually a good idea." Four sessions (41-43) were spent making an unpredictable, human-paced popup interaction *survivable* by every downstream layer, when the simpler fix — per the user's own comparison against the known-better prior behavior — was to not require that interaction at all. A working baseline the user can name specifically ("the previous method before the experiment") is a stronger signal than any amount of further tuning of the experimental path.

#### Session 45: Three Concrete Boot-Sequence Requests — Early Tap Listener, Honest Progress Messaging Instead of a Premature Banner, and Clarifying What "Show Data Instead of Skeleton" Can and Can't Fix Yet (Claude)
- **Requests**: with the `select_account` revert confirmed working, the user asked for three more specific things from a fresh report: (1) the first tap still needed ~5s before the popup appeared at all; (2) a further ~25s passed with no feedback before the "Retry sign-in" banner appeared; (3) show real current-month/recent data instead of a skeleton while all this is happening — and, on discussion, to add a "connecting/syncing" indicator during the actual data-fetch wait so the user isn't staring at an unexplained blank calendar.
- **Diagnosis for each**:
  1. The first-tap listener was only ever attached inside the `DOMContentLoaded` handler — which can't fire until several blocking `<script>` tags finish loading, even though the boot splash and calendar skeleton (plain HTML) already paint well before that. An early tap landed on nothing listening yet and was silently lost.
  2. The math doesn't support "sign-in itself" being the 25s cause — `requestToken()` is bounded to ~6s post-revert. Far more likely: the *actual data fetch* (a real, possibly-uncached Sheets download) legitimately taking that long, with the eventual banner being the last-resort `STUCK_WATCHDOG_MS` backstop, not a sign-in failure. Making the banner appear sooner, as literally requested, would have reintroduced the exact false-positive "retry sign-in when sign-in already worked" bug fixed in Sessions 36-38 — retrying sign-in does nothing for a slow fetch that's already in progress.
  3. `fetchCurrentMonth()` costs exactly the same as the full-history fetch server-side (both download the whole sheet) — there's no cheap "just this month" query available with the current Sheets API usage, so a genuinely faster *first-ever, fully uncached* load isn't achievable without a different fetch mechanism entirely (out of scope for this session). What *is* already covered: Session 38's "race whichever fetch resolves first" means a surviving `handleGetAllOpex()` cache (separate from, and more durable than, the current-month-specific cache `onInactive()` clears) already renders real data almost instantly when present.
- **Fix**:
  - Moved the one-shot first-tap listener out of `DOMContentLoaded` into its own small `<script>` immediately after `auth.js`'s tag — deliberately self-contained (direct DOM style toggles only, no dependency on `showToast()`/`hideToast()` or anything else defined later in the document) so it's safe to run this early; everything it touches (`Auth`, and the static `#connectingIndicator` markup near the top of `<body>`) is already available by that point.
  - Rather than make the banner appear sooner (wrong fix per the diagnosis above), extended `#connectingIndicator` to stay up and change its message from "Connecting to Google…" to "Syncing your data…" once sign-in succeeds but the boot-time fetch is still running, instead of hiding on sign-in success and leaving the user with an unexplained skeleton. Added `hideConnectingIndicator()`, wired into every point the cold-load sequence already clears the toast/banner (both boot branches, plus `attemptRecovery()`), so it can't go stale the same way earlier banner staleness bugs did (Session 41).
  - No fetch-mechanism change for #3 this session — the honest scope is: instant real data when a cache survives (already true via Session 38), clear "still syncing" messaging instead of silence when it doesn't (this session), and a genuinely faster uncached first load remains a separate, bigger design question, stated plainly rather than implied as solved.
- **Lesson**: not every literal request is the right fix once traced against the actual mechanism — recalibrating request #2 (banner timing) against what the numbers actually showed, and being explicit about what #3 can't yet do, mattered as much as implementing #1 and the indicator. An honest "here's what this doesn't solve yet" is worth more than a change that appears to satisfy the letter of a request while reintroducing a bug fixed in an earlier session.

#### Session 46: Reverted the Entire Session-36-Through-45 Arc — Nine Rounds of Fixes Made the Real, Measured Experience Worse (Claude)
- **Bug**: after Session 45 shipped, the reported experience was a ~3s pre-popup delay, then a **35-second** wait with only the (new) "Syncing your data…" toast for company, then the recovery banner appeared but tap-anywhere no longer worked on it — the user had to precisely hit the "Retry Sign-In" button — then a further 10s wait before the calendar finally loaded. The user directly compared this against the state at the very start of today's investigation and asked, correctly, why nine sessions of individually-reasoned fixes had produced a worse measured outcome than not touching it at all.
- **Decision**: rather than attempt a tenth fix, reverted `auth.js`, `index.html`, and `ui-settings.js` to their exact state at the commit this whole investigation began from (`ce148f7`, "Session 35" — the iOS installed-PWA permanently-stuck-skeleton fix). Offered the user a choice first: revert only today's session (keeps Session 35's recovery banner, since removing it risks reintroducing the *worse*, unrecoverable permanently-stuck bug it was built to fix) vs. going further back to a "no retry ever needed" state that predates the banner entirely. The user chose the former — `git checkout ce148f7 -- auth.js index.html ui-settings.js`, confirmed to exactly match that commit with no residual diff.
- **What this means going forward**: `Auth.INTERACTIVE_PROMPT_TIMEOUT_MS`/`Auth.REQUEST_TOKEN_TIMEOUT_MS`, `select_account`, the early first-tap listener, `#connectingIndicator`, `hideConnectingIndicator()`, `notaTokenObtained`, the `requestToken()`-internal refocus rescue, and every timeout derived from any of them (`HIST_LOAD_TIMEOUT_MS`, `MONTH_FETCH_TIMEOUT_MS`, `STUCK_WATCHDOG_MS`'s Session-36-onward values) — none of these exist in the code as of this commit. Do not assume any Session 36-45 change is still present; re-read the actual current file before building on anything described in those entries. Sessions 36-45 above are kept as a detailed record of what was tried and why each one seemed reasoned at the time, specifically so a future attempt at this same problem does not re-derive and re-ship the same non-improvements from scratch.
- **Lesson, for whichever session picks this up next**: a chain of individually-well-reasoned fixes is not evidence of progress — the only evidence that matters is the user's own before/after comparison of the real, measured experience, and here it went from "35s wait, one retry tap" all the way through 45s→85s timeout ceilings, an interactive-prompt experiment, a full revert of that experiment, and a further four rounds of boot-sequence tuning, arriving back at "35s wait" but now with a *broken* tap-anywhere recovery on top. Every individual diagnosis in Sessions 36-45 may still be factually correct in isolation (several were independently verified against the code) — that didn't make the cumulative direction correct. Before attempting this again: get a real device/console trace instead of iterating on inference from behavioral reports alone (this class of bug — WebKit timer throttling, GIS popup relay behavior in standalone mode, real Sheets API fetch latency — has enough interacting variables that reasoning from symptoms alone visibly stopped converging after a few rounds); and treat "does this net-improve the user's actual measured experience, end to end" as the acceptance criterion for shipping, not "is this individual change correct."

#### Session 47: First Real Evidence — a Screen Recording, Frame-by-Frame — Confirms the Early-Listener Fix and the Root Popup Bug Directly (Claude)
- **What changed the game**: the user supplied an actual screen recording of a real installed-iOS-PWA launch (post-Session-46 revert). No `ffmpeg`/video tooling was available in the sandbox, so `pip install imageio imageio-ffmpeg` was used to pull frames out at 0.5s intervals (48 frames across a 23.7s clip) and each was read directly as an image — the first time in this whole investigation actual visual evidence, not a behavioral text description, was available.
- **What the frames confirmed, second by second**: tap on the Home Screen icon (~1.5s) → black screen (~1.5-4s, the native launch transition) → calendar skeleton with correct dates, *no* transaction data (~4-9.5s) — **taps in this window visibly do nothing**, confirming the Session 45 "listener not attached until `DOMContentLoaded`" diagnosis was correct all along, independent of anything else that session touched → a real Safari-chrome popup opens (~9.5-10s) → the popup **visibly reaches Google and starts rendering its own branded loading screen** (spinner + "Please wait a moment…", ~11.5s) — not an instant/silent failure, a genuine in-flight request → the popup **closes itself mid-load, unprompted** (~12s) → skeleton again (~12-18s) → the recovery banner appears (~19s, a ~7s gap this run — matches the previously-documented variability of WebKit's timer-throttling behavior, seen as anywhere from ~7s to 30s+ across different real launches) → button tap (~22-23s) opens a second popup, which the user reports succeeds a further ~10s after the recording ends.
- **What this rules in and out**: confirms directly, not just diagnosed from code, that (a) the pre-`DOMContentLoaded` tap-listener gap is real and was worth fixing regardless of anything else from Sessions 36-45; (b) the first popup attempt doesn't fail cleanly or instantly — it's Google's own relay to the parent page breaking *after* a real network round-trip, exactly matching Session 35's original "broken window.opener/postMessage relay" diagnosis; (c) the delay before the banner appears is genuinely variable run-to-run (timer-throttling duration, not a fixed number), so no fixed timeout constant was ever going to reliably characterize it — reinforcing Session 46's own retrospective lesson about that whole timeout-tuning arc.
- **Fix**: reintroduced *only* the early-first-tap-listener change from Session 45 on top of the Session 46 revert baseline — the one-shot `click` listener now lives in its own small `<script>` immediately after `auth.js`'s tag instead of inside `DOMContentLoaded`, closing the confirmed ~5s dead-tap window. Nothing else from Sessions 36-45 (no timeout changes, no `select_account`, no tap-anywhere-on-the-banner — the user explicitly asked to keep the button-only interaction as-is) came back.
- **Deliberately not attempted this session — scoped as a plan for a future session instead**: see "Planned: Redirect-Based Sign-In (Not Yet Implemented)" below.

#### Session 48: Connecting/Syncing Toast Added, Early-Listener Fix Confirmed via a Second Recording (Claude)
- **Request**: with the early-listener fix live, the user asked for a "Connecting…" toast (same shared `#toast` element/styling as everything else, top-right) during the skeleton-only wait between the first tap and the recovery banner appearing, then a second screen recording to analyze for the redirect-flow plan.
- **Fix**: added a `setToast()`/`clearToast()` pair to the early first-tap listener, manipulating `#toast` directly (same className/textContent pattern `showToast()` itself uses) rather than calling that function — it's defined later in the document and this listener is deliberately attached before that's guaranteed to exist. Shows "Connecting to Google…" on tap, updates to "Loading data…" on success (handing off to the existing cold-load sequence's own toast calls, which still own clearing it once data actually finishes), clears on failure so it doesn't linger next to the recovery banner.
- **Second recording, frame-extracted the same way (35 frames, 17s clip)**: confirmed the early-listener fix's real-world effect directly — tap→popup dropped from ~9.5-10s (Session 47's recording) to ~6-7s here, a genuine ~3s improvement matching the fix's intent. **Did not confirm the new toast** — no toast text appeared in any frame from the tap onward, though it should be visible continuously per the code just shipped. Most likely a deploy/service-worker cache lag (this app explicitly caches its own shell files — see `sw.js`) rather than a code defect, but flagged as unverified pending one more real-device check, not claimed as confirmed-working.
- **Updated the redirect-flow plan** (below) with concrete, recording-derived timing baselines instead of estimates, and an explicit definition of what "success" looks like for that future rewrite (eliminating the failed first attempt, not just recovering from it faster).

## Planned: Redirect-Based Sign-In (Not Yet Implemented)

Scoped in Session 47, deliberately not started — this is a real architectural change, not a same-session fix, and this project's own recent history (Sessions 36-45) is a direct warning against attempting something this size without room to verify it properly.

**The idea**: the confirmed root cause (Session 47) is that Google's popup-based sign-in relies on a `postMessage`/`window.opener` relay from the popup back to the parent page to deliver the token — and that relay is what's broken in WebKit's installed-standalone-PWA runtime, not the sign-in itself (the popup visibly reaches Google and starts loading a real response before dying). A **full-page redirect** flow doesn't use a popup or that relay at all: the whole tab navigates to Google and back, so there's no child window relay to break. If this diagnosis is right, it could eliminate the near-guaranteed first-attempt failure entirely, rather than continuing to make recovery from it faster/clearer.

**Why this is a real rewrite, not a tweak** — every one of these needs to be worked through, not assumed:
- **State survives a redirect via URL, not memory.** `auth.js` currently expects `accessToken`/`tokenExpiresAt` to live in an in-memory closure for the rest of the page's life. A redirect flow means a full page reload — the token comes back in the URL fragment (`#access_token=...`) on the *next* load, has to be parsed and consumed as a new boot-time step, and then stripped from the URL immediately via `history.replaceState` (an access token sitting in the visible URL/browser history is a real, if usually low-severity, exposure).
- **CSRF `state` parameter must survive the same round trip** — typically via `sessionStorage` (survives a same-tab top-level navigation, unlike a plain JS variable) rather than the in-memory pattern used today.
- **Unverified: does a top-level navigation away from an installed PWA stay inside the standalone window, or kick out to Safari and break the "installed app" context?** This is exactly the kind of assumption that has repeatedly turned out wrong in this investigation without real-device verification — must be confirmed on an actual installed iOS Home Screen app before relying on it, not assumed from general PWA documentation.
- **Reconciling with the existing two-phase-auth boot sequence** (`Auth.start()`'s cached-vs-new-user branches, `DataStore.bootstrap()`) — "just returned from a redirect with a token in the URL" needs to become a third, explicit boot path alongside the existing "returning user, deferred" and "new user" ones, not bolted on ad hoc.
- **Google Cloud Console configuration**: the existing setup (README's "Setup" section above) only documents "Authorized JavaScript origins" for the popup flow — a redirect flow needs "Authorized redirect URIs" configured too, which the user would need to add manually in their own GCP project before this could work at all.
- Worth deciding explicitly whether to use the plain implicit flow (token directly in the fragment, simplest, matches current architecture most closely) or authorization-code-with-PKCE (more secure, no long-lived token ever appears in a URL, but needs a token-exchange step this app's current no-backend architecture would need to do as a public client — more moving parts).

**Suggested approach for whoever picks this up**: build it behind a flag or on a branch, verify the standalone-navigation behavior on a real installed iOS PWA *first* — before writing the rest of the flow — since if that assumption is wrong, the whole approach is moot and it's better to find out in five minutes than after the full implementation.

**Baseline measurements to compare against** (from real screen recordings, frame-extracted and read directly — see Sessions 47-48; not estimates), so a future implementation of the redirect flow has something concrete to beat:
- Tap → popup visibly opens: ~9.5-10s before the Session 47 early-listener fix, ~6-7s after it. The remaining gap is mostly `waitForGis()` (Google's own script finishing its load) plus normal tap-response latency, not something the redirect flow itself would change.
- Popup opens → Google's own branded loading UI renders (a real network round-trip, confirmed visually — not an instant/silent failure): ~1.5-2s.
- That loading UI → popup self-closes without completing: near-immediate after it starts rendering (well under 1s once "Please wait a moment…" appears).
- Popup closing → recovery banner appearing: **highly variable** — ~7s in one recorded run, 25-35s in earlier (pre-recording, text-described) reports. This variability itself is expected if the cause is WebKit throttling the parent page's timers while the popup had focus — it is not a number a fixed timeout could ever reliably characterize, which is part of why Sessions 41-43's timeout-tuning arc didn't converge.
- **What "success" for the redirect flow looks like**: eliminating the "popup opens, reaches Google, dies mid-load" step entirely — i.e., a single redirect round-trip completing sign-in without ever needing the recovery banner in the common case, not just making today's failure-then-retry faster.

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
via `computeInvestNetLots()` (moved to `ui-insights.js:724` by the Session 15 script
split) to prevent them from drifting out of sync.

## Invest ↔ Opex dual-write (avoiding double-counting)

Every Invest **Buy** writes to **two sheets, not one**: `handleInvest()`
(`data-store.js`) appends the Invest row itself, and — for `action === 'Buy'`
only — also appends a linked `Opex` row (`cat = 'Investment'`, `pm` = the
funding account, `exp = totalIdr`), joining the two via an `opexTxId`/`opexId`
column. This is deliberate — it's what makes an investment show up as an
"Investment" expense in the ledger — but it means **the same real-world outflow
now exists as two rows**, and any balance/valuation calculation that reads
both sheets for the same account has to count it exactly once, not twice.
Session 31 fixed two variants of this exact mistake (see above) — both were
`computeAccountCurrentBalance()` (`ui-settings.js`) summing the linked Opex
row *and* the Invest row for the same Buy.

**Do:**
- When writing a calculation that reads **both** `HIST.opex` and Invest rows
  (`getAllInvestRows()`) for the same account, decide up front which sheet is
  the "source of truth" for a linked Buy's outflow, and explicitly skip that
  same event on the other side.
- Use the row's `opexTxId` (Invest side) as the de-dupe key — a truthy
  `opexTxId` on a `Buy` row means its outflow is already represented as an
  Opex row somewhere.
- Remember `Sell` never gets a linked Opex row (`handleInvest` only dual-writes
  for `Buy`) — don't add a de-dupe guard that accidentally also skips Sells;
  they're the *only* record of that inflow.
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
- **Net Worth Fallback Aggregation (`getNetWorthAllocations` step 3, `ui-insights.js`)**: Non-invest stock items and static account snapshots stored in `rawAccountBalances` or `CONFIG_ITEMS` (like JHT) must be included via the fallback pass inside `getNetWorthAllocations()` (called by `renderOverview()`, `ui-insights.js:952-1040`, the fallback block at line ~999), ensuring assets without Opex/Invest sheet transaction rows are still counted in total net worth and donut visualization. (There is no function literally named `renderNetWorthOverview` — that name never existed in the codebase; this bullet previously cited it in error.)
- **Invest Buy transactions dual-write to Opex** (`handleInvest`, `data-store.js`) — a linked `cat='Investment'` row, joined via `opexTxId`. Any balance calculation reading both `HIST.opex` and Invest rows for the same account must count that outflow exactly once — see **[Invest ↔ Opex dual-write](#invest--opex-dual-write-avoiding-double-counting)** for the do's/don'ts and Session 31 for the two variants of this bug (IDR and FX accounts) already found and fixed.

### Resilience & error handling patterns

- **External API calls MUST have a timeout.** Stalled connections to external services (e.g., Google Sheets API) can leave a fetch pending forever with no error and no response. Every call to an external API (`sheets.googleapis.com`, `www.googleapis.com`, etc.) must wrap in `AbortController` with a bounded timeout (typically 15s for Sheets, 8s for user-visible calls). Without a timeout, a single stalled connection can hang the entire app's data-load chain with nothing left to catch or retry. See `sheets-client.js:authedFetch()` as a template.
- **Local DataStore calls don't need timeout.** Calls from `index.html` to `DataStore.handleRequest()` (via the fetch shim at `index.html:1295`) are synchronous JS execution in the same thread — they can't stall. Add timeouts only to `fetch()` calls that cross the network boundary.
- **`fetchWithTimeout(url, opts, ms = 8000)`:** all user-facing API calls use this to
  avoid hanging if the server is slow. Returns a `"timeout"` error if no
  response arrives in time. Callers check `e.message === 'timeout'` and show
  `"Server slow — try again"` instead of a generic error.
- **`isSyncing` flag:** guards `submitOpex()`/`submitInvest()` against
  double-submit — prevents duplicate transactions from repeated taps.
- **`visibilitychange` listener:** re-fetches the current month when the app
  returns to foreground (tabs, app switcher) — prevents stale data on iOS.
- **Global runtime-error logging:** `window.addEventListener('error', ...)` (now at `ui-settings.js:1136`, moved there by the Session 15 script split) logs uncaught runtime errors to console for debugging on mobile devices where DevTools aren't always available. (This has always been implemented via `addEventListener('error', ...)`, never the `window.onerror` property — an old wording mismatch, not a code change.)
- **Service worker:** only registers on localhost/HTTPS. Opening `index.html`
  as a `file://` URL won't activate it — use `serve.py` instead.
- **Cross-file top-level references need a deferred lookup, not a direct one.** The app is split across several `<script src>` files that all share one global scope (`index.html`'s inline script, then `ui-settings.js`, `ui-calendar.js`, `ui-insights.js` in that order). Hoisting makes a function safely callable from anywhere *within the same file*, or from any file that loads *after* the file defining it — but a **top-level** (immediately-executed, not deferred to `DOMContentLoaded`) statement in an *earlier*-loading file can never directly reference a bare identifier defined only in a *later*-loading file. The reference is evaluated the instant that line runs, before the later file has even been fetched, and throws `ReferenceError`. This doesn't just fail that one line — it halts the rest of *that script's* top-level execution, silently skipping every subsequent top-level statement (though later `function` declarations in the same file are still hoisted and remain callable). If the skipped statement happens to be the one registering the `DOMContentLoaded` listener that calls `Auth.markAppReady()`, the sign-in overlay hangs forever with no console error and no network activity — see Sessions 21 and 22. Fixes: either move the call inside `DOMContentLoaded` (the file will have loaded by then), or — if it must run immediately, like `attachSwipeClose()`'s direct-attach calls, which need to bind their touch listeners as soon as the DOM parses — wrap the cross-file reference in a closure (`() => laterFileFn()`) so the identifier lookup happens at call time instead of script-load time.

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
- **Don't leave `fetch()` calls to external APIs unbounded.** A stalled connection can hang forever with no error, leaving entire data-load chains pending indefinitely. Always wrap external API calls in `AbortController` with a timeout (15s for Sheets API, 8s for user-visible endpoints). See `sheets-client.js:authedFetch()` and `index.html:fetchWithTimeout()` as templates.
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
