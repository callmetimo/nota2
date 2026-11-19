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
- **Invest Buy and Sell transactions dual-write to Opex** (`handleInvest`, `data-store.js`) — a linked `cat='Investment'` row (expense for Buy, income for Sell), joined via `opexTxId`. Any balance calculation reading both `HIST.opex` and Invest rows for the same account must count that cash flow exactly once — see **[Invest ↔ Opex dual-write](#invest--opex-dual-write-avoiding-double-counting)** for the do's/don'ts, Session 31 for the two variants of this bug (IDR and FX accounts) already found and fixed for Buy, and Session 59 for extending the dual-write and the de-dupe guard to Sell.

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

