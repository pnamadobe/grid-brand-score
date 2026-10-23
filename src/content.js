// Isolated-world content script: finds asset cards in the Assets view grid and
// overlays a colour-banded xdm:score badge, with xdm:brandScoreNotes on hover.
(() => {
  'use strict';
  if (window.__gbsContent) return;
  window.__gbsContent = true;

  const MSG = '__GBS__';

  // All DOM assumptions live here so selector drift is a one-place fix.
  const SELECTORS = {
    idAttr: 'data-id',
    idPrefix: 'urn:aaid:aem:',
    thumb: 'img',
    maxClimb: 8,
  };
  const ID_SELECTOR = `[${SELECTORS.idAttr}^="${SELECTORS.idPrefix}"]`;
  const ID_RE = /urn:aaid:aem:[0-9a-f-]{36}/i;
  const BADGE_ATTR = 'data-gbs-badge';

  const DEFAULTS = { enabled: true, green: 85, amber: 80, position: 'bottom-right' };
  const POSITIONS = {
    'top-left': 'top:8px;left:8px;',
    'top-right': 'top:8px;right:8px;',
    'bottom-left': 'bottom:8px;left:8px;',
    'bottom-right': 'bottom:8px;right:8px;',
  };

  const BADGE_CSS = `
    :host { all: initial; position: absolute; z-index: 5; pointer-events: auto; }
    .pill {
      display: inline-flex; align-items: center; gap: 4px;
      font: 700 12px/1 adobe-clean, "Source Sans Pro", -apple-system, system-ui, sans-serif;
      color: #fff; padding: 5px 9px; border-radius: 999px;
      box-shadow: 0 1px 3px rgba(0,0,0,.35); cursor: help; user-select: none;
    }
    .green { background: #0f7d55; }
    .amber { background: #b35c00; }
    .red   { background: #c9252d; }
  `;
  const TIP_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483647; pointer-events: none; }
    .tip {
      box-sizing: border-box; padding: 10px 12px; border-radius: 6px;
      background: #1d1d1d; color: #f5f5f5; box-shadow: 0 4px 16px rgba(0,0,0,.35);
      font: 400 12px/1.45 adobe-clean, "Source Sans Pro", -apple-system, system-ui, sans-serif;
      white-space: pre-wrap;
    }
    .head { font-weight: 700; margin-bottom: 4px; }
  `;

  const state = {
    settings: { ...DEFAULTS },
    scores: new Map(), // id -> { score: number|null, name }
    notes: new Map(), // id -> string|null
    byName: new Map(), // file name -> id
    pending: new Set(),
    retry: new Map(), // id -> { n, at } backoff for ids that failed to load
    folderLoading: true, // hold per-asset requests until the folder load settles
    badges: new WeakMap(), // host -> { pill, id }
    warned: false,
  };

  // ---------- messaging ----------

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError || !res?.ok) {
            if (res?.error) console.debug('[Grid Brand Score]', type, res.error);
            resolve(null);
          } else resolve(res);
        });
      } catch {
        resolve(null); // extension reloaded / context invalidated
      }
    });
  }

  function toScore(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function merge(items) {
    for (const it of items || []) {
      if (typeof it?.id !== 'string') continue;
      if (it.name) state.byName.set(it.name, it.id);
      if ('score' in it) state.scores.set(it.id, { score: toScore(it.score), name: it.name ?? null });
      if (typeof it.notes === 'string') state.notes.set(it.id, it.notes);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data[MSG] !== 'string') return;
    const d = e.data;
    if (d[MSG] === 'auth') {
      send('auth', { host: d.host, authorization: d.authorization, apiKey: d.apiKey });
    } else if (d[MSG] === 'harvest' && Array.isArray(d.items)) {
      merge(d.items);
      send('harvest', { host: d.host, items: d.items });
      schedule();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'navigated') loadFolder();
    else if (msg?.type === 'scores' && Array.isArray(msg.items)) { merge(msg.items); schedule(); }
  });

  // Folder-level load (bulk). Retries with backoff while no token / API errors.
  let folderGen = 0;
  async function loadFolder() {
    const gen = ++folderGen;
    state.folderLoading = true;
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await send('folderScores');
      if (gen !== folderGen) return; // superseded by a newer navigation
      if (res) {
        merge(res.items);
        break;
      }
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      if (gen !== folderGen) return;
    }
    state.folderLoading = false;
    schedule();
  }

  function canRequest(id) {
    if (state.pending.has(id)) return false;
    const r = state.retry.get(id);
    return !r || Date.now() >= r.at;
  }

  let batch = new Set();
  let batchTimer = null;
  function requestScores(ids) {
    for (const id of ids) { state.pending.add(id); batch.add(id); }
    clearTimeout(batchTimer);
    batchTimer = setTimeout(async () => {
      const ids = [...batch];
      batch = new Set();
      const res = await send('assetScores', { ids });
      merge(res?.items);
      const got = new Set((res?.items || []).map((x) => x.id));
      for (const id of ids) {
        state.pending.delete(id);
        if (got.has(id)) { state.retry.delete(id); continue; }
        const n = (state.retry.get(id)?.n || 0) + 1;
        state.retry.set(id, { n, at: Date.now() + Math.min(60_000, 2000 * 2 ** n) });
      }
      schedule();
    }, 250);
  }

  // ---------- card discovery ----------

  function distinctIdsIn(el, max) {
    const seen = new Set();
    for (const n of el.querySelectorAll(ID_SELECTOR)) {
      const m = n.getAttribute(SELECTORS.idAttr).match(ID_RE);
      if (m) seen.add(m[0]);
      if (seen.size > max) break;
    }
    return seen.size;
  }

  const isThumbSized = (img) => img.clientWidth >= 60 && img.clientHeight >= 40;

  // Closest ancestor (or self) that holds a thumbnail but no other asset.
  function cardForIdEl(el) {
    let n = el;
    let firstWithImg = null;
    for (let i = 0; i <= SELECTORS.maxClimb && n && n !== document.body; i++, n = n.parentElement) {
      if (distinctIdsIn(n, 1) > 1) break;
      const imgs = n.querySelectorAll(SELECTORS.thumb);
      if (imgs.length && !firstWithImg) firstWithImg = n;
      if ([...imgs].some(isThumbSized)) return n;
    }
    return firstWithImg;
  }

  // Climb until an ancestor holds a thumbnail-sized image (skipping small icons
  // next to the file name); fall back to the first ancestor with any image.
  function cardForNameEl(el) {
    let n = el;
    let firstWithImg = null;
    for (let i = 0; i <= SELECTORS.maxClimb && n && n !== document.body; i++, n = n.parentElement) {
      const imgs = n.querySelectorAll(SELECTORS.thumb);
      if (imgs.length > 4) break;
      if (imgs.length && !firstWithImg) firstWithImg = n;
      if ([...imgs].some(isThumbSized)) return n;
    }
    return firstWithImg;
  }

  function findCards() {
    const cards = new Map(); // id -> card element
    for (const el of document.querySelectorAll(ID_SELECTOR)) {
      const m = el.getAttribute(SELECTORS.idAttr).match(ID_RE);
      if (!m || cards.has(m[0])) continue;
      const card = cardForIdEl(el);
      if (card) cards.set(m[0], card);
    }
    // Fallback: match visible file names against the folder listing.
    if (!cards.size && state.byName.size && document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const id = state.byName.get(node.nodeValue.trim());
        if (!id || cards.has(id)) continue;
        const card = cardForNameEl(node.parentElement);
        if (card) cards.set(id, card);
      }
    }
    return cards;
  }

  function thumbAnchor(card) {
    let best = null;
    let bestArea = 0;
    for (const img of card.querySelectorAll(SELECTORS.thumb)) {
      const area = img.clientWidth * img.clientHeight;
      if (area > bestArea) { best = img; bestArea = area; }
    }
    const anchor = (best || card.querySelector(SELECTORS.thumb))?.parentElement || card;
    if (getComputedStyle(anchor).position === 'static') anchor.style.position = 'relative';
    return anchor;
  }

  // ---------- badge ----------

  function band(score) {
    const { green, amber } = state.settings;
    return score >= green ? 'green' : score >= amber ? 'amber' : 'red';
  }

  function fmt(score) {
    return Number.isInteger(score) ? String(score) : score.toFixed(1);
  }

  function createBadge() {
    const host = document.createElement('div');
    host.setAttribute(BADGE_ATTR, '');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = BADGE_CSS;
    const pill = document.createElement('span');
    pill.className = 'pill';
    root.append(style, pill);
    const rec = { pill, id: null, score: null };
    state.badges.set(host, rec);
    host.addEventListener('pointerenter', (e) => showTip(rec, e));
    host.addEventListener('pointermove', moveTip);
    host.addEventListener('pointerleave', hideTip);
    // Don't open the asset when clicking the badge.
    host.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
    return host;
  }

  function renderBadge(host, id, score) {
    const rec = state.badges.get(host);
    host.style.cssText = POSITIONS[state.settings.position] || POSITIONS['bottom-right'];
    rec.id = id;
    rec.score = score;
    rec.pill.className = `pill ${band(score)}`;
    rec.pill.textContent = fmt(score);
    rec.pill.setAttribute('aria-label', `Brand score ${fmt(score)}`);
  }

  // ---------- tooltip ----------

  let tipHost = null;
  let tipBox = null;
  let tipFor = null;

  function ensureTip() {
    if (tipHost?.isConnected) return;
    tipHost = document.createElement('div');
    const root = tipHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = TIP_CSS;
    tipBox = document.createElement('div');
    tipBox.className = 'tip';
    root.append(style, tipBox);
    tipHost.style.display = 'none';
    document.documentElement.appendChild(tipHost);
  }

  function setTip(rec, notes) {
    tipBox.replaceChildren();
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = `Brand score ${fmt(rec.score)}`;
    const body = document.createElement('div');
    body.textContent = notes === undefined ? 'Loading notes…' : notes || 'No brand score notes.';
    tipBox.append(head, body);
  }

  const TIP_W = 360;
  const TIP_GAP = 14;
  let cursor = { x: 0, y: 0 };

  // Tooltip's top-right corner sits just below-left of the cursor, so it opens
  // down and to the left (away from the scrollbar / right edge). Fixed width so
  // it never shrinks to a thin column; flips above the cursor if no room below.
  function placeTip() {
    const { x, y } = cursor;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(TIP_W, vw - 16);
    tipBox.style.width = `${w}px`;
    tipHost.style.display = 'block';
    const h = tipHost.getBoundingClientRect().height;
    const left = Math.min(Math.max(8, x - w), vw - w - 8);
    let top = y + TIP_GAP;
    if (top + h > vh - 8) top = Math.max(8, y - TIP_GAP - h);
    tipHost.style.left = `${left}px`;
    tipHost.style.top = `${top}px`;
  }

  async function showTip(rec, ev) {
    ensureTip();
    cursor = { x: ev.clientX, y: ev.clientY };
    tipFor = rec.id;
    const id = rec.id;
    setTip(rec, state.notes.has(id) ? state.notes.get(id) : undefined);
    placeTip();
    if (!state.notes.has(id)) {
      const res = await send('notes', { id });
      state.notes.set(id, res?.notes ?? null);
      if (tipFor === id && tipHost.style.display !== 'none') { setTip(rec, state.notes.get(id)); placeTip(); }
    }
  }

  function moveTip(ev) {
    if (!tipFor || !tipHost) return;
    cursor = { x: ev.clientX, y: ev.clientY };
    placeTip();
  }

  function hideTip() {
    tipFor = null;
    if (tipHost) tipHost.style.display = 'none';
  }

  // ---------- scan / render ----------

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(scan, 120);
  }

  function scan() {
    scheduled = false;
    const live = new Set();
    if (state.settings.enabled && document.body) {
      const missing = [];
      const cards = findCards();
      for (const [id, card] of cards) {
        const entry = state.scores.get(id);
        if (entry === undefined) {
          if (!state.folderLoading && canRequest(id)) missing.push(id);
          continue;
        }
        if (entry.score == null) continue;
        const anchor = thumbAnchor(card);
        let host = anchor.querySelector(`:scope > [${BADGE_ATTR}]`);
        if (!host || !state.badges.has(host)) { host = createBadge(); anchor.appendChild(host); }
        renderBadge(host, id, entry.score);
        live.add(host);
      }
      if (missing.length) requestScores(missing);
      if (!state.warned && state.byName.size && !cards.size) {
        state.warned = true;
        // Expected in frames without the grid (e.g. the shell); a problem only if no frame shows badges.
        console.info(`[Grid Brand Score] No asset cards matched in ${location.href.slice(0, 80)} — if no badges appear anywhere, update SELECTORS in content.js.`);
      }
    }
    // Remove badges that were recycled onto other content or are no longer wanted.
    for (const h of document.querySelectorAll(`[${BADGE_ATTR}]`)) if (!live.has(h)) h.remove();
  }

  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') { schedule(); return; }
      for (const n of m.addedNodes) {
        if (!(n instanceof Element) || !n.hasAttribute(BADGE_ATTR)) { schedule(); return; }
      }
      if (m.removedNodes.length) { schedule(); return; }
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, attributeFilter: [SELECTORS.idAttr],
  });

  // ---------- settings & navigation ----------

  chrome.storage.sync.get(DEFAULTS, (s) => { state.settings = { ...DEFAULTS, ...s }; schedule(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) state.settings[k] = newValue;
    schedule();
  });

  if (window === window.top) {
    let lastUrl = location.href;
    const check = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      send('navigated'); // background re-broadcasts to every frame in the tab
    };
    window.addEventListener('hashchange', check);
    window.addEventListener('popstate', check);
    setInterval(check, 1000);
  }

  // Safety net: rescan periodically so backed-off ids are retried even when the
  // grid is idle. A scan with no cards is a single querySelectorAll.
  setInterval(() => { if (!document.hidden) schedule(); }, 5000);

  loadFolder();
  schedule();
})();
