// Nota — Google sign-in using Google Identity Services (GIS) / Firebase Auth for Google Workspace OAuth
// No backend needed: the browser holds an OAuth access token scoped to drive.file
// and spreadsheets, talking to Google APIs directly.

const Auth = (() => {
  let firebaseAuth = null;
  let accessToken = sessionStorage.getItem('notaAuth_accessToken') || null;
  let tokenExpiresAt = Number(sessionStorage.getItem('notaAuth_tokenExpiresAt')) || 0;
  let isGuest = sessionStorage.getItem('notaAuth_isGuest') === 'true';
  let gisTokenClient = null;
  let activeClientId = null;

  let readyResolve, readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

  function getClientId() {
    if (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && typeof NOTA_PUBLIC_CONFIG.getGoogleClientId === 'function') {
      return NOTA_PUBLIC_CONFIG.getGoogleClientId();
    }
    const custom = localStorage.getItem('nota_custom_client_id');
    if (custom && custom.trim()) return custom.trim();
    return "186138780479-6vuu77kjkm75qrc13a1srcdjflo18umg.apps.googleusercontent.com";
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
          <img src="icon.png" alt="" class="nota-auth-logo">
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
        .nota-auth-code-block {
          background: #141414;
          border: 1px solid #333;
          border-radius: 6px;
          padding: 6px 10px;
          font-family: monospace;
          font-size: 11px;
          color: #38bdf8;
          word-break: break-all;
          margin: 6px 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
        }
        .nota-auth-copy-btn {
          background: #333;
          color: #fff;
          border: none;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 10px;
          cursor: pointer;
          flex-shrink: 0;
        }
        .nota-auth-copy-btn:active {
          background: #2563eb;
        }
        .nota-auth-toggle-btn {
          background: none;
          border: none;
          color: #38bdf8;
          font-size: 11px;
          text-decoration: underline;
          cursor: pointer;
          padding: 4px 0;
          margin-top: 4px;
        }
        .nota-auth-custom-box {
          background: #1e1e1e;
          border: 1px solid #333;
          border-radius: 10px;
          padding: 12px;
          margin-top: 10px;
          text-align: left;
        }
        .nota-auth-input {
          width: 100%;
          padding: 8px 10px;
          background: #121212;
          border: 1px solid #3d3d3d;
          border-radius: 6px;
          color: #fff;
          font-size: 12px;
          box-sizing: border-box;
          margin-top: 4px;
          margin-bottom: 8px;
          font-family: monospace;
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
      const currentOrigin = window.location.origin;
      const currentClientId = getClientId();

      this.el.querySelector('#notaAuthBody').innerHTML = `
        <p>Sign in with Google to create and sync your Nota spreadsheet directly in your Google Drive.</p>
        <button id="notaSignInBtn" type="button" class="nota-auth-btn-primary">
          <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
          Sign in with Google
        </button>
        <button id="notaGuestBtn" type="button" class="nota-auth-btn-secondary">
          Continue as Guest (Local Mode)
        </button>
        <p class="nota-auth-status" id="notaAuthStatus"></p>
        <div id="notaAuthHelpContainer"></div>
        <div>
          <button type="button" class="nota-auth-toggle-btn" id="notaToggleCustomBtn">⚙️ Advanced: Use Custom Client ID</button>
          <div class="nota-auth-custom-box" id="notaCustomBox" style="display:none;">
            <label style="font-size:11px;color:#aaa;">Google OAuth Client ID:</label>
            <input type="text" id="notaCustomClientIdInput" class="nota-auth-input" value="${currentClientId}">
            <div style="display:flex;gap:6px;">
              <button type="button" class="nota-auth-btn-secondary" id="notaSaveCustomBtn" style="flex:1;margin:0;padding:6px;">Save Client ID</button>
              <button type="button" class="nota-auth-btn-secondary" id="notaResetCustomBtn" style="flex:1;margin:0;padding:6px;color:#f87171;">Reset Default</button>
            </div>
          </div>
        </div>
        <p class="nota-auth-links"><a href="privacy.html" target="_blank">Privacy Policy</a> · <a href="terms.html" target="_blank">Terms of Service</a></p>`;

      const signInBtn = this.el.querySelector('#notaSignInBtn');
      if (signInBtn) signInBtn.onclick = () => signIn();

      const guestBtn = this.el.querySelector('#notaGuestBtn');
      if (guestBtn) guestBtn.onclick = () => enableGuestMode();

      const toggleCustomBtn = this.el.querySelector('#notaToggleCustomBtn');
      const customBox = this.el.querySelector('#notaCustomBox');
      if (toggleCustomBtn && customBox) {
        toggleCustomBtn.onclick = () => {
          customBox.style.display = customBox.style.display === 'none' ? 'block' : 'none';
        };
      }

      const saveCustomBtn = this.el.querySelector('#notaSaveCustomBtn');
      if (saveCustomBtn) {
        saveCustomBtn.onclick = () => {
          const inp = this.el.querySelector('#notaCustomClientIdInput');
          if (inp && inp.value.trim()) {
            localStorage.setItem('nota_custom_client_id', inp.value.trim());
            this.setStatus('Saved custom Client ID!');
            gisTokenClient = null; // reset client to use new ID
            initGISTokenClient();
          }
        };
      }

      const resetCustomBtn = this.el.querySelector('#notaResetCustomBtn');
      if (resetCustomBtn) {
        resetCustomBtn.onclick = () => {
          localStorage.removeItem('nota_custom_client_id');
          const inp = this.el.querySelector('#notaCustomClientIdInput');
          if (inp) inp.value = getClientId();
          this.setStatus('Reset to default Client ID.');
          gisTokenClient = null;
          initGISTokenClient();
        };
      }
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
      const clientId = getClientId();

      helpContainer.innerHTML = `
        <div class="nota-auth-help-box">
          <strong>⚠️ Domain Authorization Notice</strong>
          <div style="margin-bottom:6px;">Google blocked sign-in because this origin is not registered under Authorized JavaScript Origins:</div>
          <div class="nota-auth-code-block">
            <span>${origin}</span>
            <button class="nota-auth-copy-btn" id="notaCopyOriginBtn">Copy Domain</button>
          </div>
          <div style="margin-top:8px;"><strong>How to fix on Google Cloud Console:</strong></div>
          <ol style="margin:4px 0 8px 16px;padding:0;">
            <li>Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:#38bdf8;">Google Cloud Console > Credentials</a>.</li>
            <li>Select your OAuth 2.0 Client ID (<code>${clientId.substring(0,18)}…</code>).</li>
            <li>Under <strong>Authorized JavaScript origins</strong>, add <code>${origin}</code>.</li>
            <li>Save changes, wait 1 minute, and try signing in again.</li>
          </ol>
          <div style="margin-top:6px;font-size:11px;color:#d1d5db;">
            <em>Tip: Or click "Use Custom Client ID" below to use your own Client ID created for this domain.</em>
          </div>
        </div>
      `;

      const copyBtn = helpContainer.querySelector('#notaCopyOriginBtn');
      if (copyBtn) {
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(origin).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy Domain'; }, 2000);
          }).catch(() => {
            copyBtn.textContent = 'Failed';
          });
        };
      }
    },
    hide() {
      if (this.el) this.el.remove();
      this.el = null;
    },
  };

  function enableGuestMode() {
    isGuest = true;
    sessionStorage.setItem('notaAuth_isGuest', 'true');
    readyResolve();
    overlay.hide();
  }

  function saveToken(token, expiresAt) {
    accessToken = token;
    tokenExpiresAt = expiresAt;
    if (token) {
      sessionStorage.setItem('notaAuth_accessToken', token);
      sessionStorage.setItem('notaAuth_tokenExpiresAt', String(expiresAt));
      sessionStorage.removeItem('notaAuth_isGuest');
      isGuest = false;
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
          return;
        }
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', (e) => reject(e));
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => {
        s.setAttribute('data-loaded', 'true');
        resolve();
      };
      s.onerror = (e) => reject(new Error('Failed to load script: ' + src));
      document.head.appendChild(s);
    });
  }

  function initGISTokenClient() {
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
      return false;
    }
    const currentClientId = getClientId();
    if (gisTokenClient && activeClientId === currentClientId) return true;

    try {
      activeClientId = currentClientId;
      const scope = (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && NOTA_PUBLIC_CONFIG.GOOGLE_SCOPE)
        || 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';

      gisTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: activeClientId,
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
          overlay.setStatus('Sign-in error: ' + (err.message || 'OAuth popup error'));
          overlay.showDomainHelp('oauth_error', err.message);
        }
      });
      return true;
    } catch (e) {
      console.warn('[auth] Failed to initialize GIS Token Client', e);
      return false;
    }
  }

  async function ensureGISLoaded() {
    if (initGISTokenClient()) return true;
    try {
      await loadScript('https://accounts.google.com/gsi/client');
      return initGISTokenClient();
    } catch (e) {
      console.warn('[auth] GIS script load error', e);
      return false;
    }
  }

  async function ensureFirebaseLoaded() {
    if (typeof firebase !== 'undefined' && firebase.auth) return;
    await loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js');
  }

  async function initFirebase() {
    if (firebaseAuth) return firebaseAuth;
    await ensureFirebaseLoaded();
    if (typeof firebase === 'undefined' || !firebase.auth) {
      throw new Error('Firebase SDK could not be loaded');
    }
    let cfg = null;
    try {
      const res = await fetch('/firebase-applet-config.json');
      if (res.ok) {
        cfg = await res.json();
      }
    } catch (e) {
      console.warn('[auth] Failed to fetch firebase-applet-config.json', e);
    }
    if (!cfg) {
      cfg = {
        projectId: "qualified-orbit-71ttq",
        appId: "1:186138780479:web:3b4a0bfa3e2708cf63e98a",
        apiKey: "AIzaSyDBLo1TVY3qwm0wxPatHg6nTk4QhwrD32E",
        authDomain: "qualified-orbit-71ttq.firebaseapp.com",
        storageBucket: "qualified-orbit-71ttq.firebasestorage.app",
        messagingSenderId: "186138780479",
        oAuthClientId: getClientId()
      };
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(cfg);
    }
    firebaseAuth = firebase.auth();
    return firebaseAuth;
  }

  async function signInWithFirebase() {
    overlay.setStatus('Opening Google sign-in via Firebase…');
    try {
      const auth = await initFirebase();
      const provider = new firebase.auth.GoogleAuthProvider();
      const scopeString = (typeof NOTA_PUBLIC_CONFIG !== 'undefined' && NOTA_PUBLIC_CONFIG.GOOGLE_SCOPE)
        ? NOTA_PUBLIC_CONFIG.GOOGLE_SCOPE
        : 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets';

      scopeString.split(' ').forEach(sc => {
        if (sc.trim()) provider.addScope(sc.trim());
      });

      const result = await auth.signInWithPopup(provider);
      const credential = result.credential;
      if (!credential || !credential.accessToken) {
        throw new Error('Could not obtain access token from Google sign-in');
      }

      saveToken(credential.accessToken, Date.now() + 3500 * 1000);

      overlay.setStatus('Setting up your Nota spreadsheet…');
      await DataStore.bootstrap();
      readyResolve();
      overlay.hide();
    } catch (err) {
      console.error('[auth] Firebase sign-in failed', err);
      if (err.code === 'auth/unauthorized-domain' || (err.message && err.message.includes('unauthorized-domain'))) {
        overlay.setStatus('Domain not authorized in Firebase Console.');
        overlay.showDomainHelp(err.code, err.message);
      } else {
        overlay.setStatus('Sign-in failed: ' + (err.message || 'Error'));
      }
    }
  }

  async function signIn() {
    overlay.showSignIn();
    overlay.setStatus('Opening Google sign-in…');

    const gisLoaded = await ensureGISLoaded();
    if (gisLoaded && gisTokenClient) {
      try {
        gisTokenClient.requestAccessToken({ prompt: 'select_account' });
        return;
      } catch (e) {
        console.warn('[auth] GIS requestAccessToken error', e);
      }
    }

    // Fallback to Firebase sign-in
    signInWithFirebase();
  }

  async function getAccessToken() {
    if (isGuest) return null;
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
    overlay.showSignIn();
    overlay.setStatus('Session expired — please sign in again.');
    return null;
  }

  async function start() {
    overlay.showSplash();
    if (isGuest) {
      readyResolve();
      overlay.hide();
      return;
    }

    ensureGISLoaded();

    if (accessToken && Date.now() < tokenExpiresAt - 60000) {
      try {
        await DataStore.bootstrap();
        readyResolve();
        overlay.hide();
        return;
      } catch (e) {
        console.warn('[auth] bootstrap with cached token failed', e);
      }
    }

    try {
      const auth = await initFirebase();
      auth.onAuthStateChanged(async (user) => {
        if (user && accessToken && Date.now() < tokenExpiresAt - 60000) {
          try {
            await DataStore.bootstrap();
            readyResolve();
            overlay.hide();
          } catch (e) {
            overlay.showSignIn();
          }
        } else {
          overlay.showSignIn();
        }
      });
    } catch (err) {
      console.error('[auth] start failed', err);
      overlay.showSignIn();
    }
  }

  function markAppReady() {
    ready.then(() => overlay.hide());
  }

  function signOut() {
    if (firebaseAuth) {
      firebaseAuth.signOut().catch(() => {});
    }
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2 && accessToken) {
      try { google.accounts.oauth2.revoke(accessToken, () => {}); } catch(e) {}
    }
    saveToken(null, 0);
    sessionStorage.removeItem('notaAuth_isGuest');
    localStorage.removeItem('notaPublic_spreadsheetId');
    localStorage.removeItem('notaPublic_opexSheetId');
    localStorage.removeItem('notaPublic_investSheetId');
    location.reload();
  }

  function isGuestMode() {
    return isGuest;
  }

  return { start, signIn, signOut, getAccessToken, ready, markAppReady, isGuest: isGuestMode, enableGuestMode };
})();

window.addEventListener('DOMContentLoaded', () => Auth.start());

