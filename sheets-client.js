// Nota — thin wrapper over the Google Sheets/Drive REST APIs.
// Every call is authorized with the signed-in user's own OAuth access token
// (see auth.js) and only ever touches the one spreadsheet this app created
// for that user (drive.file scope).

const SheetsClient = (() => {
  const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

  async function authedFetch(url, opts = {}) {
    const token = await Auth.getAccessToken();
    const res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Sheets API ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
  }

  function create(spreadsheetBody) {
    return authedFetch(SHEETS_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spreadsheetBody),
    });
  }

  function batchUpdate(spreadsheetId, requests) {
    return authedFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
  }

  function getValues(spreadsheetId, range) {
    return authedFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  }

  function updateValues(spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
    return authedFetch(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }
    );
  }

  function appendValues(spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
    return authedFetch(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append` +
        `?valueInputOption=${valueInputOption}&insertDataOption=INSERT_ROWS`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) }
    );
  }

  function clearValues(spreadsheetId, range) {
    return authedFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, {
      method: 'POST',
    });
  }

  return { create, batchUpdate, getValues, updateValues, appendValues, clearValues };
})();
