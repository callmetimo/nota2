// Nota — Google Cloud OAuth configuration.
//
// Fill this in after creating your Google Cloud project (see README.md):
//   1. Create a Google Cloud project.
//   2. Enable the "Google Sheets API" and "Google Drive API".
//   3. Configure the OAuth consent screen — add the `drive.file` scope only.
//   4. Create an OAuth 2.0 Client ID (Web application) and add this app's
//      URL (e.g. https://you.github.io/Nota and http://localhost:8000)
//      under "Authorized JavaScript origins".
//   5. Paste the generated Client ID below.
const NOTA_PUBLIC_CONFIG = {
  GOOGLE_CLIENT_ID: '765296352533-sho2avfm5gerct9k5001stsk6d4cr4cu.apps.googleusercontent.com',
  GOOGLE_SCOPE: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets'
};

if (typeof window !== 'undefined') {
  window.NOTA_PUBLIC_CONFIG = NOTA_PUBLIC_CONFIG;
}
