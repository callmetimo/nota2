// Nota — Gmail access: the REST calls, MIME decoding, and reading text out of an attached PDF.
//
// Extracted from email-import.js, which was a single 1,518-line IIFE. Only this part came out:
// it is what talks to Google and decodes bytes, and almost nothing flows back the other way.
// The rest of that file (rules, stored state, the review popup and the settings UI) is far more
// entangled — its state and UI halves reference each other 141 times — so splitting those would
// be a redesign rather than a move, and was deliberately left alone.
//
// Nothing here touches the DOM except loadPdfJs, which injects the pdf.js <script> tag.
// pdf.js is pinned with Subresource Integrity, and its worker is fetched, hash-checked and run
// from a blob so it stays same-origin.
//
// Globals used at call time: Auth (access token), EmailParser (htmlToText, pdfItemsToText).
const GmailClient = (() => {
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

  const MAX_FETCH = 60;

  async function gmailFetch(path) {
    const token = await Auth.getAccessToken();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(GMAIL + path, { headers: { Authorization: 'Bearer ' + token }, signal: ctrl.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`Gmail ${res.status}: ${body.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Gmail request timed out');
      throw e;
    } finally { clearTimeout(timer); }
  }

  function b64urlToText(data) {
    const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Walks the MIME tree; prefers a text/plain part, falls back to text/html.
  function messageBody(msg) {
    let plain = '', html = '';
    (function walk(part) {
      if (!part) return;
      const data = part.body && part.body.data;
      if (data && /^text\/plain/i.test(part.mimeType || '')) plain += b64urlToText(data) + '\n';
      else if (data && /^text\/html/i.test(part.mimeType || '')) html += b64urlToText(data) + '\n';
      (part.parts || []).forEach(walk);
    })(msg.payload);
    // Many senders ship a plain-text copy whose layout differs from the HTML one (labels and values
    // separated by spaces or line breaks instead of table cells). Give the readers both: they look
    // labels up anywhere in the text, so whichever copy has a layout they understand is used.
    if (plain.trim() && html) return plain + '\n' + EmailParser.htmlToText(html);
    return plain.trim().length > 40 && /:/.test(plain) ? plain : (html || plain);
  }

  // Some receipts carry the amount only in an attached PDF. The text is read on this device with
  // pdf.js (loaded from cdnjs only the first time a PDF is needed; scanned or password-protected
  // PDFs have no readable text and are simply skipped).
  //
  // Was pinned to 3.11.174, which carries CVE-2024-4367 (arbitrary JS execution via a crafted
  // font in a malicious PDF — fixed upstream in 4.2.67). Every 4.x release on cdnjs, including
  // this one, dropped the classic pdf.min.js/<script> build entirely and ships only ES modules
  // (pdf.min.mjs), so the loader below is a rewrite, not a version-string bump:
  //   - <script integrity> has no equivalent for a dynamically import()'d module in the browsers
  //     this app targets, so the library file is now verified the same way the worker already
  //     was: fetched, hash-checked against a value computed directly from the downloaded bytes
  //     (not copied from a registry listing), then imported from a same-origin Blob URL.
  //   - the loaded module is a namespace object, not a global — window.pdfjsLib no longer gets
  //     set by the library itself, so it is cached locally instead.
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/';
  const PDFJS_SRI = 'sha384-+0ti2moQlmLN7WZHE2RHIf5lV8hHxhxEalN0il3YZceG26fUPyOkR0hp9daxk1i7';
  const PDFJS_WORKER_SRI = 'sha384-ToeVvShCxKc6CEvhHeMt0Q8A06pSPDbAlngO9nokrDmh914gk/pYd0N7D0a4Lz2o';
  const PDF_MAX_BYTES = 2000000;
  const PDF_MAX_PAGES = 4;
  let pdfjsPromise = null;
  let pdfjsLib = null;

  function b64ToBytes(data) {
    const bin = atob(String(data || '').replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Fetches a cdnjs file and throws unless its hash matches exactly — the same check a
  // <script integrity> attribute performs, applied by hand because neither a dynamically
  // import()'d module nor a Worker constructed from a URL goes through that attribute.
  async function fetchVerified(url, expectedSri) {
    // Was a raw fetch() — same hang risk as the fixes alongside this one, and this is
    // the modern replacement for the old pdf.worker.min.js fetch that the original
    // review flagged by line number before the pdf.js rewrite in this file moved it
    // here. A longer deadline than the default 8s: this downloads the ~350KB library
    // and the ~1.4MB worker, not a small API response, and it's not gating anything
    // on the calendar-boot path — only the on-demand PDF-reading feature.
    const buf = await (await fetchWithTimeout(url, undefined, 20000)).arrayBuffer();
    const sum = 'sha384-' + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-384', buf))));
    if (sum !== expectedSri) throw new Error('PDF reader failed its integrity check');
    return buf;
  }

  function loadPdfJs() {
    if (pdfjsLib) return Promise.resolve(pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = (async () => {
      const libBuf = await fetchVerified(PDFJS + 'pdf.min.mjs', PDFJS_SRI);
      const libUrl = URL.createObjectURL(new Blob([libBuf], { type: 'text/javascript' }));
      try {
        pdfjsLib = await import(/* webpackIgnore: true */ libUrl);
      } finally {
        URL.revokeObjectURL(libUrl);
      }
      const workerBuf = await fetchVerified(PDFJS + 'pdf.worker.min.mjs', PDFJS_WORKER_SRI);
      pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerBuf], { type: 'text/javascript' }));
      return pdfjsLib;
    })().catch(e => { pdfjsPromise = null; pdfjsLib = null; throw e; });
    return pdfjsPromise;
  }

  function pdfParts(msg) {
    const out = [];
    (function walk(part) {
      if (!part) return;
      const att = part.body && part.body.attachmentId;
      if (att && (/\.pdf$/i.test(part.filename || '') || /^application\/pdf/i.test(part.mimeType || '')) && (part.body.size || 0) <= PDF_MAX_BYTES) {
        out.push({ id: att, name: part.filename || 'attachment.pdf' });
      }
      (part.parts || []).forEach(walk);
    })(msg.payload);
    return out;
  }

  // Text of the first PDF attached to a message ('' when there is none or it cannot be read).
  async function pdfTextOf(msg) {
    const part = pdfParts(msg)[0];
    if (!part) return { text: '', name: '' };
    try {
      const att = await gmailFetch('/messages/' + msg.id + '/attachments/' + part.id);
      const lib = await loadPdfJs();
      // isEvalSupported:false is pdf.js's own switch for the exact class of bug CVE-2024-4367
      // was: a malicious font program using eval()/Function() during glyph rendering. The
      // library update above already carries the real fix; this is defense in depth, and
      // costs nothing here since nothing in this read-only text extraction needs it on.
      const doc = await lib.getDocument({ data: b64ToBytes(att.data), isEvalSupported: false }).promise;
      const pages = [];
      for (let i = 1; i <= Math.min(doc.numPages, PDF_MAX_PAGES); i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        pages.push(EmailParser.pdfItemsToText(tc.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width }))));
      }
      doc.destroy();
      return { text: pages.join('\n'), name: part.name };
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      console.warn('[email-import] pdf not read', e && e.message);
      return { text: '', name: part.name };
    }
  }

  // Body text plus, when the email text has no amount but a PDF is attached, that PDF's text.
  async function bodyWithPdf(msg, body) {
    if (EmailParser.receiptScore(body, '', '', '').amount > 0) return { body, names: '' };
    const pdf = await pdfTextOf(msg);
    return pdf.text ? { body: body + '\n' + pdf.text, names: pdf.name } : { body, names: pdf.name };
  }

  // Words a receipt or payment notice contains. Folders are ignored on purpose (receipts also land in
// Promotions / Updates / Social); the score in EmailParser.receiptScore does the real filtering.
  const RECEIPT_QUERY = 'newer_than:30d (total OR receipt OR struk OR invoice OR pembayaran OR payment OR order OR pesanan OR purchase OR transaction OR booking)';

  async function listMoneyEmails(max) {
    const list = await gmailFetch(`/messages?maxResults=${max}&q=` + encodeURIComponent(RECEIPT_QUERY));
    return (list.messages || []).map(m => m.id);
  }

  // Only what email-import.js actually used is exposed. loadPdfJs, pdfTextOf, pdfjsPromise and
  // b64ToBytes stay private — nothing outside ever called them.
  return { GMAIL, MAX_FETCH, RECEIPT_QUERY, gmailFetch, b64urlToText, messageBody, bodyWithPdf, pdfParts, listMoneyEmails };
})();
