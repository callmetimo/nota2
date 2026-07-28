// Nota — Google sign-in (Google Identity Services token client).
// No backend: the browser holds a short-lived OAuth access token scoped to
// drive.file (files this app creates) and talks to the Sheets API directly.

const Auth = (() => {
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  const overlay = {
    el: null,
    ensure() {
      if (this.el) return this.el;
      const el = document.createElement('div');
      el.id = 'notaAuthOverlay';
      el.innerHTML = `
        <div class="nota-auth-card">
          <img src="icon.png" alt="" class="nota-auth-logo">
          <h1>Nota</h1>
          <p>Sign in with Google to create your own private Nota spreadsheet.
             Your data stays in a Google Sheet in your own Drive — this app
             never sees your other files.</p>
          <button id="notaSignInBtn" type="button">Sign in with Google</button>
          <p class="nota-auth-status" id="notaAuthStatus"></p>
          <p class="nota-auth-links"><a href="privacy.html" target="_blank">Privacy</a> · <a href="terms.html" target="_blank">Terms</a></p>
        </div>`;
      document.body.appendChild(el);
      el.querySelector('#notaSignInBtn').addEventListener('click', () => signIn());
      this.el = el;
      return el;
    },
    setStatus(msg) {
      this.ensure();
      this.el.querySelector('#notaAuthStatus').textContent = msg || '';
    },
    hide() {
      if (this.el) this.el.remove();
      this.el = null;
    },
  };

  function initTokenClient() {
    if (tokenClient) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: NOTA_PUBLIC_CONFIG.GOOGLE_CLIENT_ID,
      scope: NOTA_PUBLIC_CONFIG.GOOGLE_SCOPE,
      callback: () => {}, // overridden per-request below
    });
    return tokenClient;
  }

  function requestToken(promptMode) {
    return new Promise((resolve, reject) => {
      const client = initTokenClient();
      client.callback = (resp) => {
        if (resp.error) { reject(new Error(resp.error)); return; }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in || 3300) * 1000);
        resolve(accessToken);
      };
      client.requestAccessToken({ prompt: promptMode });
    });
  }

  async function signIn() {
    overlay.setStatus('Opening Google sign-in…');
    try {
      await requestToken('consent');
      overlay.setStatus('Setting up your Nota spreadsheet…');
      await DataStore.bootstrap();
      overlay.hide();
      readyResolve();
    } catch (err) {
      console.error('[auth] sign-in failed', err);
      overlay.setStatus('Sign-in failed: ' + err.message + ' — try again.');
    }
  }

  // Called by SheetsClient for every API call — both during the initial
  // sign-in/bootstrap (before `ready` resolves) and afterwards by DataStore,
  // which already awaits `ready` itself before calling in. Returns the
  // current token, silently refreshing it if it's expired.
  async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
    try {
      await requestToken(''); // silent refresh (no prompt) if still permitted
      return accessToken;
    } catch (err) {
      overlay.ensure();
      overlay.setStatus('Your session expired — please sign in again.');
      await signIn(); // re-prompts; DataStore.bootstrap() is a no-op if already set up
      return accessToken;
    }
  }

  function start() {
    overlay.ensure();
    // If GIS supports silent restore (e.g. same session), users still click
    // "Sign in" once per browser session — GIS itself handles account
    // selection, so no auto-attempt here to avoid surprise popups.
  }

  return { start, signIn, getAccessToken, ready };
})();

window.addEventListener('DOMContentLoaded', () => Auth.start());
