// "Sort by > Brand score": injects an entry into the Assets view's Sort by menu
// and opens a ranked overlay of the folder's assets ordered by xdm:score.
// The native grid can't be re-sorted (server-side sort options are fixed and
// the grid is virtualized), so the ranking is drawn by the extension instead.
// Loaded before content.js; content.js calls globalThis.__gbsRanked(deps).
(() => {
  'use strict';
  if (globalThis.__gbsRanked) return;

  const SORT_LABELS = new Set(['Name', 'Size', 'Modified', 'Created', 'Relevancy', 'Relevance']);
  const ITEM_SELECTOR = '[role="menuitemradio"],[role="menuitem"],[role="menuitemcheckbox"],[role="option"]';
  const MARK = 'data-gbs-sort';
  const LABEL = 'Brand score';

  const CSS = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483000; }
    * { box-sizing: border-box; }
    .backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.35); display: flex; justify-content: center; align-items: stretch; padding: 20px; }
    .panel {
      width: 100%; background: #f8f8f8; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.35);
      display: flex; flex-direction: column; overflow: hidden;
      font: 400 13px/1.45 adobe-clean, "Source Sans Pro", -apple-system, system-ui, sans-serif; color: #222;
    }
    header { background: #fff; border-bottom: 1px solid #e1e1e1; padding: 16px 20px 14px; display: grid; gap: 12px; }
    .top { display: flex; align-items: center; gap: 12px; }
    .top svg { flex: none; }
    h2 { margin: 0; font-size: 18px; font-weight: 800; }
    .sub { color: #6e6e6e; font-size: 12.5px; }
    .grow { flex: 1; }
    button { font: inherit; cursor: pointer; }
    .close { border: 0; background: transparent; width: 32px; height: 32px; border-radius: 8px; font-size: 18px; color: #444; }
    .close:hover { background: #eee; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
    .stats { display: flex; gap: 18px; flex-wrap: wrap; }
    .stat b { display: block; font-size: 17px; font-weight: 800; }
    .stat span { color: #6e6e6e; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; }
    .chips, .seg { display: flex; gap: 6px; }
    .chip, .seg button {
      border: 1px solid #d5d5d5; background: #fff; border-radius: 999px; padding: 4px 11px; font-size: 12.5px; color: #333;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .chip[aria-pressed="true"], .seg button[aria-pressed="true"] { background: #222; border-color: #222; color: #fff; }
    .dot { width: 9px; height: 9px; border-radius: 50%; }
    .seg { margin-left: auto; }
    .body { overflow: auto; padding: 18px 20px 28px; flex: 1; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
    .tile { background: #fff; border: 1px solid #e3e3e3; border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }
    .thumb { position: relative; height: 170px; background: #ececec; display: flex; align-items: center; justify-content: center; cursor: pointer; }
    .tbox { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    .tbox img, .tbox canvas { max-width: 100%; max-height: 100%; object-fit: contain; }
    .tbox.none::after { content: 'No preview'; color: #8e8e8e; font-size: 12px; }
    .rank { position: absolute; top: 8px; left: 8px; background: rgba(255,255,255,.92); color: #222; font-weight: 800; font-size: 12px; padding: 3px 8px; border-radius: 999px; box-shadow: 0 1px 2px rgba(0,0,0,.2); }
    .pill { position: absolute; bottom: 8px; right: 8px; color: #fff; font-weight: 800; font-size: 12px; padding: 5px 9px; border-radius: 999px; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
    .green { background: #0f7d55; } .amber { background: #b35c00; } .red { background: #c9252d; }
    .meta { padding: 10px 12px 12px; display: grid; gap: 6px; }
    .name { font-weight: 700; font-size: 12.5px; word-break: break-all; cursor: pointer; }
    .name:hover { text-decoration: underline; }
    .notes { margin: 0; color: #444; font-size: 12px; white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
    .tile.open .notes { display: block; }
    .more { justify-self: start; border: 0; background: none; color: #1473e6; padding: 0; font-size: 12px; }
    .empty { padding: 48px; text-align: center; color: #6e6e6e; }
    .status { color: #6e6e6e; font-size: 12px; }
  `;

  const RIBBON = `<svg width="28" height="28" viewBox="0 0 128 128" aria-hidden="true">
    <polygon points="44,70 26,122 40,114 50,126 64,80" fill="#0a4fa8"/><polygon points="84,70 102,122 88,114 78,126 64,80" fill="#0d66d0"/>
    <circle cx="64" cy="50" r="44" fill="#1473e6"/><circle cx="64" cy="50" r="31" fill="#fff"/><circle cx="64" cy="50" r="27" fill="#0d66d0"/>
    <polygon points="64,36 68,46 79,46 70,53 73,64 64,57 55,64 58,53 49,46 60,46" fill="#ffd24a"/></svg>`;

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  };

  const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  globalThis.__gbsRanked = (deps) => {
    // deps: { send, available(), folderPath(), items(): [{id,name,score}], notesFor(id), thumbFor(id,name), fmt(score), makeBander(scores), bandLabel(band) }
    let host = null;
    let root = null;
    let data = []; // [{id, name, path, score, notes}]
    let folderPath = null;
    let loading = false;
    const ui = { order: 'desc', band: 'all' };
    const thumbData = new Map(); // id -> data: URL from the background fallback

    // ---------- Sort by menu ----------

    // Close the app's popover with an "outside press" (what React Aria listens
    // for), then resolve once it's gone so our overlay never races with it.
    async function closeMenu(menu) {
      const press = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true };
      // One press, then give the close animation time; press again only if needed.
      for (let attempt = 0; attempt < 2 && menu?.isConnected; attempt++) {
        document.body.dispatchEvent(new PointerEvent('pointerdown', press));
        document.body.dispatchEvent(new PointerEvent('pointerup', press));
        document.body.dispatchEvent(new MouseEvent('click', press));
        for (let i = 0; i < 10 && menu.isConnected; i++) await new Promise((r) => setTimeout(r, 50));
      }
    }

    function inject(menu, items) {
      const last = items[items.length - 1];
      const src = items.find((i) => i.getAttribute('aria-checked') !== 'true' && i.getAttribute('aria-selected') !== 'true') || last;
      const srcLabel = src.textContent.trim();
      const item = src.cloneNode(true); // no React props/listeners: the app ignores it
      item.setAttribute(MARK, '');
      for (const n of [item, ...item.querySelectorAll('*')]) {
        for (const a of ['id', 'aria-labelledby', 'aria-describedby', 'data-key', 'data-focused', 'data-hovered', 'data-selected']) n.removeAttribute(a);
      }
      if (item.hasAttribute('aria-checked')) item.setAttribute('aria-checked', 'false');
      if (item.hasAttribute('aria-selected')) item.setAttribute('aria-selected', 'false');
      item.setAttribute('tabindex', '-1');
      // Replace the label text in the deepest element that holds it.
      let labelEl = null;
      for (const n of item.querySelectorAll('*')) if (n.childElementCount === 0 && n.textContent.trim() === srcLabel) labelEl = n;
      if (labelEl) labelEl.textContent = LABEL;
      else item.textContent = LABEL;
      item.style.borderRadius = getComputedStyle(src).borderRadius;
      ensureMenuStyle();
      menus.set(item, menu);
      placeItem(menu, last, item);
    }

    // Hover look via CSS: the app's own hover state never reaches our clone, and
    // pointer events can't be relied on (see onPress).
    function ensureMenuStyle() {
      if (document.getElementById('gbs-sort-style')) return;
      const s = document.createElement('style');
      s.id = 'gbs-sort-style';
      s.textContent = `[${MARK}]:hover { background: rgba(0,0,0,.07) !important; }`;
      (document.head || document.documentElement).appendChild(s);
    }

    // The app's popover stops press events before they reach elements inside it,
    // so listeners on our item never fire. Catch presses on our item at the very
    // top of the capture path (window), before the app sees them.
    const menus = new WeakMap(); // item -> its menu
    function onPress(e) {
      const item = e.composedPath().find((n) => n instanceof Element && n.hasAttribute(MARK));
      if (!item) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.type === 'click') {
        e.preventDefault();
        closeMenu(menus.get(item) || item.closest('[role="listbox"],[role="menu"]')).then(open);
      }
    }
    for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click']) {
      window.addEventListener(t, onPress, true);
    }

    // React Aria virtualizes the list: each option sits in its own absolutely
    // positioned row inside a fixed-height sizer. Appending next to the last
    // option would land outside the sizer and be clipped, so add a new row.
    function placeItem(menu, last, item) {
      const row = last.parentElement;
      const virtual = row && row !== menu && row.childElementCount === 1 &&
        getComputedStyle(row).position === 'absolute' && row.parentElement;
      if (!virtual) { last.after(item); return; }
      const sizer = row.parentElement;
      const h = row.offsetHeight || 32;
      const top = parseFloat(row.style.top) || row.offsetTop;
      const mine = row.cloneNode(false); // same positioning styles as the app's rows
      mine.style.top = `${top + h}px`;
      mine.appendChild(item);
      // Shift trailing rows (e.g. the zero-height bottom-padding row) down.
      for (const sib of sizer.children) {
        const t = parseFloat(sib.style.top);
        if (Number.isFinite(t) && t > top) sib.style.top = `${t + h}px`;
      }
      sizer.appendChild(mine);
      if (sizer.style.height) sizer.style.height = `${parseFloat(sizer.style.height) + h}px`;
    }

    function scanMenus() {
      if (deps.available && !deps.available()) return; // no scored assets in this folder
      for (const menu of document.querySelectorAll('[role="menu"],[role="listbox"]')) {
        if (menu.querySelector(`[${MARK}]`)) continue;
        const items = [...menu.querySelectorAll(ITEM_SELECTOR)];
        if (items.length < 3 || items.length > 8) continue;
        const label = (i) => i.textContent.replace(/[^\p{L} ]/gu, '').trim(); // ignore text checkmarks
        const hits = items.filter((i) => SORT_LABELS.has(label(i))).length;
        if (hits >= 3) inject(menu, items);
      }
    }

    // ---------- overlay ----------

    function onKey(e) {
      // Only real key presses: synthetic events (ours or the app's) must not close it.
      if (e.key === 'Escape' && host && e.isTrusted) { e.stopPropagation(); e.preventDefault(); close(); }
    }

    function close() {
      if (!host) return;
      host.remove();
      host = root = null;
      window.removeEventListener('keydown', onKey, true);
    }

    async function open() {
      if (host) return;
      const stored = await new Promise((r) => chrome.storage.sync.get({ rankOrder: 'desc' }, r));
      ui.order = stored.rankOrder === 'asc' ? 'asc' : 'desc';
      ui.band = 'all';
      host = document.createElement('div');
      host.setAttribute('data-gbs-ranked', '');
      root = host.attachShadow({ mode: 'open' }); // open: style isolation only; nothing secret in here
      document.documentElement.appendChild(host);
      window.addEventListener('keydown', onKey, true);
      // Instant first paint from what the grid already knows; details follow.
      data = deps.items().map((x) => ({ ...x, path: null, notes: deps.notesFor(x.id) }));
      loading = true;
      render();
      const res = await deps.send('folderDetails');
      loading = false;
      if (!host) return;
      if (res?.items) { data = res.items; folderPath = res.folderPath; }
      render();
    }

    function setOrder(order) {
      ui.order = order;
      chrome.storage.sync.set({ rankOrder: order });
      render();
    }

    // Bytes from the background -> canvas. Drawing (rather than <img src="data:…">)
    // isn't subject to the page's img-src CSP.
    async function drawBytes({ type, data }) {
      const bytes = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type }));
      const s = Math.min(1, 420 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * s));
      c.height = Math.max(1, Math.round(bmp.height * s));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close?.();
      return c;
    }

    // At most 4 background thumbnail fetches at a time, nearest tiles first.
    const queue = [];
    let active = 0;
    function enqueue(job) {
      queue.push(job);
      pump();
    }
    function pump() {
      while (active < 4 && queue.length) {
        const job = queue.shift();
        active++;
        job().finally(() => { active--; pump(); });
      }
    }

    // Thumbnail box: reuse the grid's own image URL when we have one (it was
    // drawn, or its URL pattern is known); otherwise fetch bytes when scrolled near.
    function thumbBox(x) {
      const box = el('div', { class: 'tbox' });
      const viaBackground = () => enqueue(async () => {
        if (!thumbData.has(x.id)) {
          const r = await deps.send('thumb', { id: x.id });
          thumbData.set(x.id, r?.image || null);
        }
        const image = thumbData.get(x.id);
        if (!image) { box.classList.add('none'); return; }
        try { box.replaceChildren(await drawBytes(image)); } catch { box.classList.add('none'); }
      });
      const src = deps.thumbFor(x.id, x.name);
      if (src && !thumbData.has(x.id)) {
        const img = el('img', { alt: '', loading: 'lazy', decoding: 'async' });
        img.onerror = () => { img.remove(); viaBackground(); };
        img.src = src;
        box.append(img);
      } else {
        box.__gbsLazy = viaBackground;
      }
      return box;
    }

    function openAsset(x) {
      if (!x.path) return;
      deps.send('openAsset', { path: x.path });
      close();
    }

    function render() {
      if (!root) return;
      const scored = data.filter((x) => typeof x.score === 'number');
      const unscored = data.length - scored.length;
      const scores = scored.map((x) => x.score);
      const band = deps.makeBander(scores); // same rule as the grid badges (fixed or relative)
      const counts = { green: 0, amber: 0, red: 0 };
      for (const s of scores) counts[band(s)]++;
      const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      const list = scored
        .filter((x) => ui.band === 'all' || band(x.score) === ui.band)
        .sort((a, b) => (ui.order === 'asc' ? a.score - b.score : b.score - a.score) || String(a.name).localeCompare(String(b.name)));

      const folderName = (folderPath || deps.folderPath?.() || '').split('/').pop() || 'This folder';
      const chip = (key, label, color) => el('button', {
        class: 'chip', 'aria-pressed': String(ui.band === key),
        onclick: () => { ui.band = key; render(); },
      }, ...(color ? [el('span', { class: 'dot', style: `background:${color}` })] : []), `${label}`);

      const header = el('header', {},
        el('div', { class: 'top' },
          (() => { const s = el('span'); s.innerHTML = RIBBON; return s.firstElementChild; })(),
          el('div', { class: 'grow' },
            el('h2', { text: 'Ranked by brand score' }),
            el('div', { class: 'sub', text: `${folderName} · ${scored.length} scored${unscored ? ` · ${unscored} without a score` : ''}${loading && scored.some((x) => !x.notes) ? ' · loading notes…' : ''}` })),
          el('button', { class: 'close', 'aria-label': 'Close', title: 'Close (Esc)', onclick: close, text: '✕' })),
        el('div', { class: 'row' },
          el('div', { class: 'stats' },
            el('div', { class: 'stat' }, el('b', { text: avg == null ? '–' : deps.fmt(Math.round(avg * 10) / 10) }), el('span', { text: 'Average' })),
            el('div', { class: 'stat' }, el('b', { text: scores.length ? deps.fmt(median(scores)) : '–' }), el('span', { text: 'Median' })),
            el('div', { class: 'stat' }, el('b', { text: scores.length ? `${deps.fmt(Math.min(...scores))}–${deps.fmt(Math.max(...scores))}` : '–' }), el('span', { text: 'Range' })))),
        el('div', { class: 'row' },
          el('div', { class: 'chips' },
            chip('all', `All ${scored.length}`),
            chip('green', `${deps.bandLabel('green')} · ${counts.green}`, '#0f7d55'),
            chip('amber', `${deps.bandLabel('amber')} · ${counts.amber}`, '#b35c00'),
            chip('red', `${deps.bandLabel('red')} · ${counts.red}`, '#c9252d')),
          el('div', { class: 'seg', role: 'group', 'aria-label': 'Order' },
            el('button', { 'aria-pressed': String(ui.order === 'desc'), onclick: () => setOrder('desc'), text: 'Highest first' }),
            el('button', { 'aria-pressed': String(ui.order === 'asc'), onclick: () => setOrder('asc'), text: 'Lowest first' }))));

      const grid = el('div', { class: 'grid' });
      list.forEach((x, i) => {
        const tile = el('article', { class: 'tile' });
        const notes = el('p', { class: 'notes', text: x.notes || (loading ? 'Loading notes…' : 'No brand score notes.') });
        const more = el('button', { class: 'more', text: 'More', onclick: () => { more.textContent = tile.classList.toggle('open') ? 'Less' : 'More'; } });
        tile.append(
          el('div', { class: 'thumb', title: x.path ? 'Open asset details' : '', onclick: () => openAsset(x) },
            thumbBox(x),
            el('span', { class: 'rank', text: `#${i + 1}` }),
            el('span', { class: `pill ${band(x.score)}`, text: deps.fmt(x.score) })),
          el('div', { class: 'meta' },
            el('div', { class: 'name', title: x.name || '', text: x.name || x.id, onclick: () => openAsset(x) }),
            notes,
            ...(x.notes && x.notes.length > 180 ? [more] : [])));
        grid.append(tile);
      });

      const body = el('div', { class: 'body' },
        list.length ? grid : el('div', { class: 'empty', text: loading ? 'Loading scores…' : 'No scored assets in this view.' }));
      const panel = el('section', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ranked by brand score' }, header, body);
      const backdrop = el('div', { class: 'backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, panel);

      const style = el('style', { text: CSS });
      root.replaceChildren(style, backdrop);

      // Background thumbnails: the first rows start right away, the rest when
      // scrolled near (each box loads once).
      const run = (box) => { const f = box.__gbsLazy; box.__gbsLazy = null; f?.(); };
      const io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          io.unobserve(en.target);
          run(en.target);
        }
      }, { root: body, rootMargin: '300px' });
      [...grid.querySelectorAll('.tbox')].filter((b) => b.__gbsLazy).forEach((box, i) => (i < 15 ? run(box) : io.observe(box)));
      panel.focus?.();
    }

    return { scanMenus, open, close, refresh: render, isOpen: () => !!host };
  };
})();
