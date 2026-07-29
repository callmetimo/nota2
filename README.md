# Nota (public multi-tenant version)

This folder is a public, multi-tenant fork of the original [Nota](../README.md)
app (in the parent folder) — both are branded "Nota" to the end user, but this
is a separate codebase/deployment. The original is bound to one shared Google
Sheet with a hardcoded API token; this version lets each visitor sign in with
their own Google account instead: the app creates a private Google Sheet in
*their* Drive and reads/writes it directly via the Google Sheets API. There is
no backend server and no Apps Script deployment — everything runs client-side
in the browser using the signed-in user's own short-lived OAuth token.

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
