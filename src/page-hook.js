// Runs in the page's MAIN world. Observes the Assets view's own calls to the
// AEM author host so the extension can reuse its IMS token, and harvests any
// xdm:score values already present in API responses. Data is posted only to
// this same window (targetOrigin = own origin), where content.js picks it up.
(() => {
  'use strict';
  if (window.__gbsHooked) return;
  window.__gbsHooked = true;

  const MSG = '__GBS__';
  const AEM_RE = /^https:\/\/[a-z0-9-]+\.adobeaemcloud\.com\//i;
  const REPOST_MS = 30_000; // re-send an unchanged token so a cleared extension cache recovers
  let lastAuthKey = '';
  let lastAuthAt = 0;

  function post(kind, data) {
    window.postMessage({ [MSG]: kind, ...data }, location.origin);
  }

  function headerMap(h) {
    const out = {};
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) {
      h.forEach((v, k) => { out[k.toLowerCase()] = v; });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) out[String(k).toLowerCase()] = v;
    } else if (typeof h === 'object') {
      for (const k of Object.keys(h)) out[k.toLowerCase()] = h[k];
    }
    return out;
  }

  function reportAuth(url, headers) {
    const authorization = headers.authorization;
    if (!authorization || !/^Bearer\s/i.test(authorization)) return;
    const host = new URL(url).origin;
    const apiKey = headers['x-api-key'] || null;
    const key = `${host}|${authorization}|${apiKey}`;
    if (key === lastAuthKey && Date.now() - lastAuthAt < REPOST_MS) return;
    lastAuthKey = key;
    lastAuthAt = Date.now();
    post('auth', { host, authorization, apiKey });
  }

  function harvest(json) {
    const items = [];
    const seen = new Set();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 8) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      const md = o.assetMetadata;
      if (typeof o.assetId === 'string' && md && md['xdm:score'] != null && !seen.has(o.assetId)) {
        seen.add(o.assetId);
        const notes = md['xdm:brandScoreNotes'];
        items.push({
          id: o.assetId,
          score: md['xdm:score'],
          notes: typeof notes === 'string' ? notes : null,
          name: o.repositoryMetadata?.['repo:name'] ?? null,
        });
      }
      for (const k in o) walk(o[k], depth + 1);
    })(json, 0);
    return items;
  }

  function harvestFrom(url, json) {
    const items = harvest(json);
    if (items.length) post('harvest', { host: new URL(url).origin, items });
  }

  const isAemApi = (url) => AEM_RE.test(url) && /\/adobe\//.test(url);

  // fetch
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = null;
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      url = new URL(raw, location.href).href;
      if (AEM_RE.test(url)) {
        reportAuth(url, { ...headerMap(input?.headers), ...headerMap(init?.headers) });
      }
    } catch { /* never break the app */ }
    const p = origFetch.apply(window, arguments);
    if (url && isAemApi(url)) {
      p.then((res) => {
        const ct = res.headers.get('content-type') || '';
        if (res.ok && ct.includes('json')) {
          res.clone().json().then((j) => harvestFrom(url, j)).catch(() => {});
        }
      }).catch(() => {});
    }
    return p;
  };

  // XMLHttpRequest
  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSetHeader = XHR.setRequestHeader;
  const origSend = XHR.send;
  XHR.open = function (method, url) {
    try { this.__gbsUrl = new URL(url, location.href).href; this.__gbsHeaders = {}; } catch { this.__gbsUrl = null; }
    return origOpen.apply(this, arguments);
  };
  XHR.setRequestHeader = function (k, v) {
    if (this.__gbsHeaders) this.__gbsHeaders[String(k).toLowerCase()] = v;
    return origSetHeader.apply(this, arguments);
  };
  XHR.send = function () {
    const url = this.__gbsUrl;
    try {
      if (url && AEM_RE.test(url)) reportAuth(url, this.__gbsHeaders || {});
      if (url && isAemApi(url)) {
        this.addEventListener('load', () => {
          try {
            if (this.status < 200 || this.status >= 300) return;
            if (this.responseType === 'json') harvestFrom(url, this.response);
            else if ((this.responseType === '' || this.responseType === 'text') &&
                     (this.getResponseHeader('content-type') || '').includes('json')) {
              harvestFrom(url, JSON.parse(this.responseText));
            }
          } catch { /* ignore */ }
        });
      }
    } catch { /* never break the app */ }
    return origSend.apply(this, arguments);
  };
})();
