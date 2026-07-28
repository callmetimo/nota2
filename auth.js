// Nota — Google sign-in (Google Identity Services token client).
// No backend: the browser holds a short-lived OAuth access token scoped to
// drive.file (files this app creates) and talks to the Sheets API directly.

const Auth = (() => {
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  // Two content modes share one full-screen card: a bare "splash" (logo + loading
  // text, no button) shown while we check for an existing session, and the full
  // interactive sign-in prompt shown only once we know that check failed.
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
          <div id="notaAuthBody"></div>
        </div>`;
      document.body.appendChild(el);
      this.el = el;
      return el;
    },
    showSplash() {
      this.ensure();
      this.el.querySelector('#notaAuthBody').innerHTML = `<p class="nota-auth-status" id="notaAuthStatus">Loading…</p>`;
    },
    showSignIn() {
      this.ensure();
      this.el.querySelector('#notaAuthBody').innerHTML = `
        <p>Sign in with Google to create your own private Nota spreadsheet.
           Your data stays in a Google Sheet in your own Drive — this app
           never sees your other files.</p>
        <button id="notaSignInBtn" type="button">Sign in with Google</button>
        <p class="nota-auth-status" id="notaAuthStatus"></p>
        <p class="nota-auth-links"><a href="privacy.html" target="_blank">Privacy</a> · <a href="terms.html" target="_blank">Terms</a></p>`;
      this.el.querySelector('#notaSignInBtn').addEventListener('click', () => signIn());
    },
    setStatus(msg) {
      this.ensure();
      const s = this.el.querySelector('#notaAuthStatus');
      if (s) s.textContent = msg || '';
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

  // If the browser blocks the (possibly invisible) popup GIS opens even for
  // prompt:'none'/no-gesture calls, it can log an error and never invoke the
  // token client's callback at all — leaving the caller's promise hanging
  // forever. A bounded timeout is the only way to guarantee this resolves.
  function requestToken(promptMode, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('timeout'));
      }, timeoutMs);
      const client = initTokenClient();
      client.callback = (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (resp.error) { reject(new Error(resp.error)); return; }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in || 3300) * 1000);
        resolve(accessToken);
      };
      client.requestAccessToken({ prompt: promptMode });
    });
  }

  async function signIn() {
    overlay.showSignIn();
    overlay.setStatus('Opening Google sign-in…');
    try {
      // '' lets Google decide: silently reuses an already-granted session for a
      // returning user, or shows the consent screen if this is genuinely new —
      // avoids re-showing consent every time once the user has granted access once.
      await requestToken('');
      overlay.setStatus('Setting up your Nota spreadsheet…');
      await DataStore.bootstrap();
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
      await requestToken('none'); // silent, no-UI refresh if still permitted
      return accessToken;
    } catch (err) {
      overlay.showSignIn();
      overlay.setStatus('Your session expired — please sign in again.');
      await signIn(); // re-prompts; DataStore.bootstrap() is a no-op if already set up
      return accessToken;
    }
  }

  async function start() {
    // Show the bare splash immediately — no "please sign in" messaging flash —
    // then try a silent, no-UI reauth. If the browser still has an active Google
    // session and this app was already granted access, this resolves with a
    // fresh token and no popup at all, so a returning user never sees the
    // interactive sign-in prompt at all, just the splash before the app itself.
    overlay.showSplash();
    try {
      await requestToken('none', 4000); // shorter timeout so a blocked/failed silent attempt doesn't stall the splash
      await DataStore.bootstrap();
      readyResolve();
    } catch (err) {
      overlay.showSignIn();
    }
  }

  // Called by index.html once the Home page has had its first paint attempt —
  // hides the splash/sign-in overlay as soon as `ready` resolves (immediately,
  // if it already has). Safe to call more than once or before `ready` resolves.
  function markAppReady() {
    ready.then(() => overlay.hide());
  }

  function signOut() {
    try {
      if (accessToken && google.accounts?.oauth2?.revoke) {
        google.accounts.oauth2.revoke(accessToken, () => {});
      }
    } catch (err) { console.warn('[auth] revoke failed', err); }
    accessToken = null;
    tokenExpiresAt = 0;
    localStorage.removeItem('notaPublic_spreadsheetId');
    localStorage.removeItem('notaPublic_opexSheetId');
    localStorage.removeItem('notaPublic_investSheetId');
    location.reload();
  }

  return { start, signIn, signOut, getAccessToken, ready, markAppReady };
})();

window.addEventListener('DOMContentLoaded', () => Auth.start());
