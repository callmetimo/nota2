// Nota — Google sign-in using Google Identity Services (GIS) & Firebase Auth
// Pure client-side OAuth 2.0 scoped to drive.file and spreadsheets.

(function () {
  let accessToken = sessionStorage.getItem('notaAuth_accessToken') || null;
  let tokenExpiresAt = Number(sessionStorage.getItem('notaAuth_tokenExpiresAt')) || 0;
  let gisTokenClient = null;

  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

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
          padding: 28px 24px;
          width: 100%;
          max-width: 400px;
          text-align: center;
          box-shadow: 0 12px 32px rgba(0,0,0,0.6);
          box-sizing: border-box;
        }
        .nota-auth-logo {
          width: 64px;
          height: 64px;
          border-radius: 14px;
          margin-bottom: 16px;
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
          margin: 0 0 20px 0;
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
          gap: 10px;
          box-sizing: border-box;
        }
        .nota-auth-btn-primary:active {
          background: #1d4ed8;
          transform: scale(0.98);
        }
        .nota-auth-status {
          font-size: 12px;
          color: #c8f060;
          margin: 12px 0 0 0;
          min-height: 16px;
          word-break: break-word;
        }
        .nota-auth-error {
          color: #f87171;
          font-size: 12px;
          margin-top: 12px;
          line-height: 1.4;
        }
        .nota-auth-links {
          font-size: 11px;
          color: #666;
          margin-top: 20px;
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
        <p>Sign in with Google to create your own private Nota spreadsheet in your Google Drive.</p>
        <button id="notaSignInBtn" type="button" class="nota-auth-btn-primary">
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
          Sign in with Google
        </button>
        <p class="nota-auth-status" id="notaAuthStatus"></p>
        <p class="nota-auth-links"><a href="privacy.html" target="_blank">Privacy</a> · <a href="terms.html" target="_blank">Terms</a></p>`;

      const btn = this.el.querySelector('#notaSignInBtn');
      if (btn) btn.onclick = () => signIn();
    },
    setStatus(msg, isError = false) {
      this.ensure();
      const s = this.el.querySelector('#notaAuthStatus');
      if (s) {
        s.textContent = msg || '';
        s.className = isError ? 'nota-auth-error' : 'nota-auth-status';
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
    } else {
      sessionStorage.removeItem('notaAuth_accessToken');
      sessionStorage.removeItem('notaAuth_tokenExpiresAt');
    }
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

  async function ensureFirebaseLoaded() {
    if (typeof firebase !== 'undefined' && firebase.auth) return;
    await loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js');
  }

  let firebaseAuth = null;
  async function initFirebase() {
    if (firebaseAuth) return firebaseAuth;
    await ensureFirebaseLoaded();

    if (!firebase.apps.length) {
      firebase.initializeApp({
        apiKey: "AIzaSyD-mockKeyForOAuthPopupOnly",
        authDomain: "qualified-orbit-71ttq.firebaseapp.com",
        storageBucket: "qualified-orbit-71ttq.firebasestorage.app",
        messagingSenderId: "186138780479",
        oAuthClientId: (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && NOTA_PUBLIC_CONFIG.GOOGLE_CLIENT_ID) || "186138780479-6vuu77kjkm75qrc13a1srcdjflo18umg.apps.googleusercontent.com"
      });
    }

    firebaseAuth = firebase.auth();
    return firebaseAuth;
  }

  async function signInWithFirebase() {
    overlay.setStatus('Opening Google sign-in…');
    try {
      const auth = await initFirebase();
      const provider = new firebase.auth.GoogleAuthProvider();
      const scopeString = (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && NOTA_PUBLIC_CONFIG.GOOGLE_SCOPE) 
        ? NOTA_PUBLIC_CONFIG.GOOGLE_SCOPE 
        : 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';
      
      scopeString.split(' ').forEach(sc => {
        if (sc.trim()) provider.addScope(sc.trim());
      });

      const res = await auth.signInWithPopup(provider);
      const credential = res.credential;
      if (!credential || !credential.accessToken) {
        throw new Error('Google did not return an access token.');
      }
      saveToken(credential.accessToken, Date.now() + 3500 * 1000);
      overlay.setStatus('Setting up your Nota spreadsheet…');
      await DataStore.bootstrap();
      readyResolve();
      overlay.hide();
    } catch (err) {
      console.error('[auth] Firebase sign-in failed', err);
      overlay.setStatus('Sign-in failed: ' + (err.message || 'Error'), true);
    }
  }

  function initGISTokenClient() {
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
      return false;
    }

    const clientId = (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && NOTA_PUBLIC_CONFIG.GOOGLE_CLIENT_ID)
      || "186138780479-6vuu77kjkm75qrc13a1srcdjflo18umg.apps.googleusercontent.com";
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
              overlay.setStatus('Setup failed: ' + (e.message || 'Error'), true);
            }
          } else if (tokenResponse && tokenResponse.error) {
            console.error('[auth] GIS token error', tokenResponse);
            if (tokenResponse.error === 'popup_closed_by_user') {
              overlay.setStatus('Sign-in cancelled. Tap "Sign in with Google" to try again.');
            } else {
              console.warn('[auth] GIS error, trying Firebase fallback');
              signInWithFirebase();
            }
          }
        },
        error_callback: (err) => {
          console.error('[auth] GIS error_callback', err);
          signInWithFirebase();
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
    if (loaded && initGISTokenClient() && gisTokenClient) {
      try {
        gisTokenClient.requestAccessToken({ prompt: 'select_account' });
        return;
      } catch (err) {
        console.warn('[auth] GIS token request error, falling back to Firebase', err);
      }
    }

    signInWithFirebase();
  }

  async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
    await signIn();
    return accessToken;
  }

  async function start() {
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
    if (firebaseAuth) {
      firebaseAuth.signOut().catch(() => {});
    }
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
    getSpreadsheetId: () => localStorage.getItem('notaPublic_spreadsheetId')
  };
})();

window.addEventListener('DOMContentLoaded', () => Auth.start());
