// Nota — Google sign-in using Google Identity Services (GIS) Token Client
// Pure client-side OAuth 2.0 without Firebase Auth or redirect URLs.

(function () {
  let accessToken = sessionStorage.getItem('notaAuth_accessToken') || null;
  let tokenExpiresAt = Number(sessionStorage.getItem('notaAuth_tokenExpiresAt')) || 0;
  let isGuest = sessionStorage.getItem('notaAuth_isGuest') === 'true';
  let gisTokenClient = null;

  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  function getClientId() {
    if (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && typeof NOTA_PUBLIC_CONFIG.getGoogleClientId === 'function') {
      return NOTA_PUBLIC_CONFIG.getGoogleClientId();
    }
    const custom = localStorage.getItem('nota_custom_client_id');
    if (custom && custom.trim()) return custom.trim();
    return (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && NOTA_PUBLIC_CONFIG.GOOGLE_CLIENT_ID)
      || "186138780479-6vuu77kjkm75qrc13a1srcdjflo18umg.apps.googleusercontent.com";
  }

  const overlay = {
    el: null,
    ensure() {
      if (this.el) return this.el;
      this.injectStyles();
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
    injectStyles() {
      if (document.getElementById('notaAuthOverlayStyles')) return;
      const style = document.createElement('style');
      style.id = 'notaAuthOverlayStyles';
      style.textContent = `
        #notaAuthOverlay {
          position: fixed;
          inset: 0;
          z-index: 10000;
          background: #0d0d0d;
          color: #f0f0f0;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          overflow-y: auto;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          -webkit-font-smoothing: antialiased;
        }
        .nota-auth-card {
          background: #181818;
          border: 1px solid #2a2a2a;
          border-radius: 18px;
          padding: 24px 20px;
          width: 100%;
          max-width: 420px;
          text-align: center;
          box-shadow: 0 12px 32px rgba(0,0,0,0.6);
          box-sizing: border-box;
        }
        .nota-auth-logo {
          width: 64px;
          height: 64px;
          border-radius: 14px;
          margin-bottom: 12px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .nota-auth-card h1 {
          font-size: 22px;
          font-weight: 700;
          margin: 0 0 8px 0;
          color: #fff;
          letter-spacing: -0.5px;
        }
        .nota-auth-card p {
          font-size: 13px;
          color: #aaa;
          margin: 0 0 16px 0;
          line-height: 1.45;
        }
        .nota-auth-btn-primary {
          width: 100%;
          padding: 12px 16px;
          background: #2563eb;
          color: #ffffff;
          border: none;
          border-radius: 10px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s, transform 0.1s;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          box-sizing: border-box;
          margin-bottom: 10px;
        }
        .nota-auth-btn-primary:active {
          background: #1d4ed8;
          transform: scale(0.98);
        }
        .nota-auth-btn-secondary {
          width: 100%;
          padding: 10px 14px;
          background: #262626;
          color: #ccc;
          border: 1px solid #333;
          border-radius: 10px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s;
          box-sizing: border-box;
          margin-bottom: 10px;
        }
        .nota-auth-btn-secondary:active {
          background: #333;
          color: #fff;
        }
        .nota-auth-status {
          font-size: 12px;
          color: #c8f060;
          margin: 8px 0 12px 0;
          min-height: 16px;
          word-break: break-word;
        }
        .nota-auth-help-box {
          background: #221a10;
          border: 1px solid #854d0e;
          border-radius: 12px;
          padding: 14px;
          text-align: left;
          margin: 12px 0 16px 0;
          font-size: 12px;
          color: #fef08a;
          line-height: 1.45;
        }
        .nota-auth-help-box strong {
          color: #fde047;
          display: block;
          font-size: 13px;
          margin-bottom: 6px;
        }
        .nota-auth-links {
          font-size: 11px;
          color: #666;
          margin-top: 12px;
        }
        .nota-auth-links a {
          color: #888;
          text-decoration: none;
        }
        .nota-auth-links a:hover {
          text-decoration: underline;
        }
      `;
      document.head.appendChild(style);
    },
    showSplash() {
      this.ensure();
      this.el.querySelector('#notaAuthBody').innerHTML = `<p class="nota-auth-status" id="notaAuthStatus">Loading Nota…</p>`;
    },
    showSignIn() {
      this.ensure();
      this.el.querySelector('#notaAuthBody').innerHTML = `
        <p>Sign in with Google to create and sync your private Nota spreadsheet in your Google Drive.</p>
        <button id="notaSignInBtn" type="button" class="nota-auth-btn-primary">
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
          Sign in with Google
        </button>
        <button id="notaGuestBtn" type="button" class="nota-auth-btn-secondary">
          Continue as Guest (Local Mode)
        </button>
        <p class="nota-auth-status" id="notaAuthStatus"></p>
        <div id="notaAuthHelpContainer"></div>
        <p class="nota-auth-links"><a href="privacy.html" target="_blank">Privacy Policy</a> · <a href="terms.html" target="_blank">Terms of Service</a></p>`;

      const signInBtn = this.el.querySelector('#notaSignInBtn');
      if (signInBtn) signInBtn.onclick = () => signIn();

      const guestBtn = this.el.querySelector('#notaGuestBtn');
      if (guestBtn) guestBtn.onclick = () => enableGuestMode();
    },
    setStatus(msg) {
      this.ensure();
      const s = this.el.querySelector('#notaAuthStatus');
      if (s) s.textContent = msg || '';
    },
    showDomainHelp(errCode, errDetail) {
      this.ensure();
      const helpContainer = this.el.querySelector('#notaAuthHelpContainer');
      if (!helpContainer) return;

      const origin = window.location.origin;

      if (origin.includes('run.app') || origin.includes('localhost')) {
        helpContainer.innerHTML = `
          <div class="nota-auth-help-box">
            <strong>ℹ️ Preview Environment Note</strong>
            <div>You are viewing this app in preview mode. When published to <strong>callmetimo.github.io</strong>, Google Sign-in will work directly with your existing Google Cloud OAuth configuration without any extra setup.</div>
          </div>
        `;
      } else {
        helpContainer.innerHTML = `
          <div class="nota-auth-help-box">
            <strong>⚠️ OAuth Origin Error</strong>
            <div>Ensure <code>${origin}</code> is listed in <strong>Authorized JavaScript origins</strong> in Google Cloud Console.</div>
          </div>
        `;
      }
    },
    hide() {
      if (this.el) this.el.remove();
      this.el = null;
    }
  };

  function saveToken(token, expiresAtMs) {
    accessToken = token;
    tokenExpiresAt = expiresAtMs;
    if (token) {
      sessionStorage.setItem('notaAuth_accessToken', token);
      sessionStorage.setItem('notaAuth_tokenExpiresAt', String(expiresAtMs));
      sessionStorage.removeItem('notaAuth_isGuest');
      isGuest = false;
    } else {
      sessionStorage.removeItem('notaAuth_accessToken');
      sessionStorage.removeItem('notaAuth_tokenExpiresAt');
    }
  }

  function enableGuestMode() {
    isGuest = true;
    sessionStorage.setItem('notaAuth_isGuest', 'true');
    saveToken(null, 0);
    readyResolve();
    overlay.hide();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.hasAttribute('data-loaded')) {
          resolve();
        } else {
          existing.addEventListener('load', () => resolve());
          existing.addEventListener('error', () => reject(new Error('Failed to load ' + src)));
        }
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { s.setAttribute('data-loaded', 'true'); resolve(); };
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
  }

  async function ensureGISLoaded() {
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
      return true;
    }
    try {
      await loadScript('https://accounts.google.com/gsi/client');
      return typeof google !== 'undefined' && google.accounts && google.accounts.oauth2;
    } catch (e) {
      console.error('[auth] GIS script load failed', e);
      return false;
    }
  }

  function initGISTokenClient() {
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
      return false;
    }

    const clientId = getClientId();
    const scope = (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && NOTA_PUBLIC_CONFIG.GOOGLE_SCOPE)
      || 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';

    try {
      gisTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: scope,
        callback: async (tokenResponse) => {
          if (tokenResponse && tokenResponse.access_token) {
            const expiresIn = tokenResponse.expires_in ? Number(tokenResponse.expires_in) : 3500;
            saveToken(tokenResponse.access_token, Date.now() + expiresIn * 1000);
            overlay.setStatus('Setting up your Nota spreadsheet…');
            try {
              await DataStore.bootstrap();
              readyResolve();
              overlay.hide();
            } catch (e) {
              console.error('[auth] bootstrap after GIS token failed', e);
              overlay.setStatus('Setup failed: ' + (e.message || 'Error'));
            }
          } else if (tokenResponse && tokenResponse.error) {
            console.error('[auth] GIS token error', tokenResponse);
            if (tokenResponse.error === 'popup_closed_by_user') {
              overlay.setStatus('Sign-in cancelled. Tap "Sign in with Google" to try again.');
            } else {
              overlay.setStatus('Sign-in failed: ' + (tokenResponse.error_description || tokenResponse.error));
              overlay.showDomainHelp(tokenResponse.error, tokenResponse.error_description);
            }
          }
        },
        error_callback: (err) => {
          console.error('[auth] GIS error_callback', err);
          overlay.setStatus('Sign-in error: ' + (err.message || 'OAuth error'));
          overlay.showDomainHelp('oauth_error', err.message);
        }
      });
      return true;
    } catch (e) {
      console.warn('[auth] Failed to initialize GIS Token Client', e);
      return false;
    }
  }

  async function signIn() {
    overlay.showSignIn();
    overlay.setStatus('Opening Google sign-in…');

    const loaded = await ensureGISLoaded();
    if (!loaded) {
      overlay.setStatus('Failed to load Google Sign-in library. Please check your internet connection.');
      return;
    }

    if (!initGISTokenClient() || !gisTokenClient) {
      overlay.setStatus('Could not initialize Google Sign-in client.');
      return;
    }

    try {
      gisTokenClient.requestAccessToken({ prompt: 'select_account' });
    } catch (err) {
      console.error('[auth] requestAccessToken error', err);
      overlay.setStatus('Sign-in error: ' + (err.message || 'Error launching popup'));
    }
  }

  async function getAccessToken() {
    if (isGuest) return null;
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;

    await signIn();
    return accessToken;
  }

  async function start() {
    if (isGuest) {
      readyResolve();
      return;
    }

    ensureGISLoaded();

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
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2 && accessToken) {
      try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch(e) {}
    }
    saveToken(null, 0);
    sessionStorage.removeItem('notaAuth_isGuest');
    localStorage.removeItem('notaPublic_spreadsheetId');
    location.reload();
  }

  window.Auth = {
    ready,
    start,
    signIn,
    signOut,
    enableGuestMode,
    getAccessToken,
    isGuest: () => isGuest,
    getSpreadsheetId: () => localStorage.getItem('notaPublic_spreadsheetId')
  };
})();

window.addEventListener('DOMContentLoaded', () => Auth.start());
