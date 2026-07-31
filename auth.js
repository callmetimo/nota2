// Nota — Google sign-in using Google Identity Services (GIS) Token Client
// Pure client-side OAuth 2.0 without Firebase or redirect URL setup.

(function () {
  let accessToken = sessionStorage.getItem('notaAuth_accessToken') || null;
  let tokenExpiresAt = Number(sessionStorage.getItem('notaAuth_tokenExpiresAt')) || 0;

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
          <img src="icon.png" class="nota-auth-logo" alt="Nota">
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
        <p>Sign in with Google to create your own private Nota spreadsheet in your Google Drive.</p>
        <button id="notaSignInBtn" type="button" style="width:100%;margin-bottom:8px">Sign in with Google</button>
        <p class="nota-auth-status" id="notaAuthStatus"></p>
        <p class="nota-auth-links"><a href="privacy.html" target="_blank">Privacy</a> · <a href="terms.html" target="_blank">Terms</a></p>`;
      const btn = this.el.querySelector('#notaSignInBtn');
      if (btn) btn.onclick = () => signIn();
    },
    setStatus(msg) {
      this.ensure();
      const s = this.el.querySelector('#notaAuthStatus');
      if (s) s.textContent = msg || '';
    },
    hide() {
      if (this.el) this.el.remove();
      this.el = null;
    }
  };

  function saveToken(token, expiresInSec) {
    accessToken = token;
    tokenExpiresAt = Date.now() + (expiresInSec || 3500) * 1000;
    if (token) {
      sessionStorage.setItem('notaAuth_accessToken', token);
      sessionStorage.setItem('notaAuth_tokenExpiresAt', String(tokenExpiresAt));
    } else {
      sessionStorage.removeItem('notaAuth_accessToken');
      sessionStorage.removeItem('notaAuth_tokenExpiresAt');
    }
  }

  let tokenClient = null;

  function initGisTokenClient() {
    if (tokenClient) return tokenClient;
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
      throw new Error('Google Identity Services script not loaded');
    }

    const clientId = (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && NOTA_PUBLIC_CONFIG.GOOGLE_CLIENT_ID) || '';
    const scope = (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && NOTA_PUBLIC_CONFIG.GOOGLE_SCOPE) || 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: scope,
      callback: async (resp) => {
        if (resp.error) {
          console.error('[auth] GIS response error:', resp);
          if (resp.error === 'popup_closed_by_user') {
            overlay.setStatus('Sign-in popup was closed. Click button to try again.');
          } else if (resp.error === 'access_denied') {
            overlay.setStatus('Permission was not granted. Please sign in to continue.');
          } else {
            overlay.setStatus('Sign-in error: ' + (resp.error_description || resp.error));
          }
          return;
        }
        if (resp.access_token) {
          saveToken(resp.access_token, resp.expires_in);
          overlay.setStatus('Setting up your Nota spreadsheet…');
          try {
            await DataStore.bootstrap();
            readyResolve();
            overlay.hide();
          } catch (err) {
            console.error('[auth] bootstrap failed', err);
            overlay.setStatus('Setup failed: ' + (err.message || 'Error'));
          }
        }
      },
      error_callback: (err) => {
        console.warn('[auth] GIS error_callback:', err);
        if (err && (err.type === 'popup_closed' || err.message === 'popup_closed')) {
          overlay.setStatus('Sign-in popup was closed. Click button to try again.');
        } else {
          overlay.setStatus('Sign-in error: ' + (err.message || err.type || 'Popup closed or blocked'));
        }
      }
    });
    return tokenClient;
  }

  function signIn() {
    overlay.showSignIn();
    overlay.setStatus('Opening Google sign-in…');
    try {
      const client = initGisTokenClient();
      client.requestAccessToken({ prompt: 'select_account' });
    } catch (err) {
      console.error('[auth] sign-in error', err);
      overlay.setStatus('Sign-in error: ' + err.message);
    }
  }

  async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
    signIn();
    await ready;
    return accessToken;
  }

  async function start() {
    if (accessToken && Date.now() < tokenExpiresAt - 60000) {
      try {
        await DataStore.bootstrap();
        readyResolve();
      } catch (err) {
        console.warn('[auth] bootstrap with cached token failed', err);
        overlay.showSignIn();
        overlay.setStatus('Session expired. Please sign in again.');
      }
      return;
    }

    overlay.showSignIn();
  }

  function signOut() {
    saveToken(null, 0);
    localStorage.removeItem('notaPublic_spreadsheetId');
    location.reload();
  }

  window.Auth = {
    ready,
    start,
    signIn,
    signOut,
    getAccessToken,
    isGuest: () => false,
    getSpreadsheetId: () => localStorage.getItem('notaPublic_spreadsheetId')
  };
})();

window.addEventListener('DOMContentLoaded', () => Auth.start());
