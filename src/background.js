// Service worker: data layer. Holds the captured IMS token (chrome.storage.session,
// memory-only), calls the AEM Assets API with it, and keeps a persistent score
// cache (chrome.storage.local) so badges render instantly and refresh behind.

const HOST_RE = /^https:\/\/[a-z0-9-]+\.adobeaemcloud\.com$/i;
const FRESH_MS = 60_000; // older cached data is shown, then refreshed in the background
const BULK_RETRY_MS = 30 * 60_000; // re-try the bulk folder listing this long after it failed
const AUTH_WAIT_MS = 20_000;
const MAX_LIST_PAGES = 10; // 1,000 children (bulk) / 500 (fallback)
const MAX_REFRESH_PER_FOLDER = 200;
const MAX_ENTRIES = 5000; // per host
const CONCURRENCY = 6;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- auth ----------

async function getAuthMap() {
  const { auth = {} } = await chrome.storage.session.get('auth');
  return auth;
}

async function setAuth(host, authorization, apiKey) {
  if (!HOST_RE.test(host || '') || !/^Bearer\s/i.test(authorization || '')) return;
  const auth = await getAuthMap();
  auth[host] = { authorization, apiKey: apiKey || null, ts: Date.now() };
  await chrome.storage.session.set({ auth, lastHost: host });
}

// Only drop the token that failed, never a newer one captured meanwhile.
async function clearAuth(host, authorization) {
  const auth = await getAuthMap();
  if (auth[host]?.authorization !== authorization) return;
  delete auth[host];
  await chrome.storage.session.set({ auth });
}

async function waitForAuth(host, notToken = null) {
  const until = Date.now() + AUTH_WAIT_MS;
  for (;;) {
    const a = (await getAuthMap())[host];
    if (a && a.authorization !== notToken) return a;
    if (Date.now() > until) return null;
    await sleep(400);
  }
}

// ---------- persistent cache ----------

const hostLoads = new Map(); // host -> Promise<Map<id, entry>>
const dirtyHosts = new Set();
let flushTimer = null;

function hostCache(host) {
  if (!hostLoads.has(host)) {
    const key = `c:${host}`;
    hostLoads.set(host, chrome.storage.local.get(key).then((r) => new Map(Object.entries(r[key] || {}))));
  }
  return hostLoads.get(host);
}

function scheduleFlush(host) {
  dirtyHosts.add(host);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 500);
}

async function flush() {
  const hosts = [...dirtyHosts];
  dirtyHosts.clear();
  for (const host of hosts) {
    const c = await hostCache(host);
    if (c.size > MAX_ENTRIES) {
      const oldest = [...c.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, c.size - MAX_ENTRIES);
      for (const [id] of oldest) c.delete(id);
    }
    await chrome.storage.local.set({ [`c:${host}`]: Object.fromEntries(c) });
  }
}

async function cacheSet(host, id, patch) {
  const c = await hostCache(host);
  const next = { ...c.get(id), ...patch, ts: Date.now() };
  c.set(id, next);
  scheduleFlush(host);
  return next;
}

async function cacheGet(host, id) {
  return (await hostCache(host)).get(id) || null;
}

const isFresh = (e) => e && Date.now() - e.ts < FRESH_MS;

async function getFolderIndex(host, path) {
  const key = `f:${host}|${path}`;
  return (await chrome.storage.local.get(key))[key] || null;
}

async function setFolderIndex(host, path, ids) {
  await chrome.storage.local.set({ [`f:${host}|${path}`]: { ids, ts: Date.now() } });
}

async function bulkUnavailable(host) {
  const { noBulk = {} } = await chrome.storage.session.get('noBulk');
  return noBulk[host] && Date.now() - noBulk[host] < BULK_RETRY_MS;
}

async function markBulkUnavailable(host) {
  const { noBulk = {} } = await chrome.storage.session.get('noBulk');
  noBulk[host] = Date.now();
  await chrome.storage.session.set({ noBulk });
}

// ---------- helpers ----------

function parseTabUrl(url) {
  try {
    const u = new URL(url);
    const repo = u.searchParams.get('repoId') || new URLSearchParams(u.hash.split('?')[1] || '').get('repoId');
    const host = repo && HOST_RE.test(`https://${repo}`) ? `https://${repo}` : null;
    const m = u.hash.match(/\/assets\/browse(\/content\/dam(?:\/[^?#]*)?)/);
    const folderPath = m ? decodeURIComponent(m[1]).replace(/\/+$/, '') : null;
    return { host, folderPath };
  } catch {
    return { host: null, folderPath: null };
  }
}

async function resolveHost(sender) {
  const { host } = parseTabUrl(sender.tab?.url || '');
  if (host) return host;
  const { lastHost } = await chrome.storage.session.get('lastHost');
  return lastHost || null;
}

function toScore(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = undefined; }
    }
  }));
  return out;
}

function toItem(id, e) {
  const item = { id, name: e?.name ?? null };
  if (e && 'score' in e) item.score = e.score;
  if (typeof e?.notes === 'string') item.notes = e.notes;
  return item;
}

// Retries: one fresh token after 401, two backoffs for network errors / 429 / 5xx.
async function aemFetch(host, path, { method = 'GET', body, raw = false } = {}) {
  let staleToken = null;
  for (let attempt = 0; ; attempt++) {
    const auth = await waitForAuth(host, staleToken);
    if (!auth) {
      const err = new Error('No AEM token captured yet — reload the Assets view tab.');
      err.status = 0;
      throw err;
    }
    // Images: AEM answers a bare "image/*" with 406, so list concrete formats plus a catch-all.
    const headers = {
      Authorization: auth.authorization,
      Accept: raw ? 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8' : 'application/json',
    };
    if (auth.apiKey) headers['x-api-key'] = auth.apiKey;
    if (path.startsWith('/adobe/experimental/')) headers['X-Adobe-Accept-Experimental'] = '1';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(host + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
      });
    } catch (e) {
      if (attempt < 2) { await sleep(600 * 2 ** attempt); continue; }
      throw e;
    }
    if (res.status === 401 && !staleToken) {
      staleToken = auth.authorization;
      await clearAuth(host, auth.authorization);
      continue; // wait for the app to use a refreshed token
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(600 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return raw ? res : res.json();
  }
}

// ---------- AEM calls ----------

// Bulk: the same folder listing the Assets view uses (Repository API), with each
// child's asset metadata embedded. One ~1 MB request returns score, notes, path
// and rendition links for up to 100 direct children; paged with _page.next.
const REL_META = 'http://ns.adobe.com/adobecloud/rel/metadata/asset';
const REL_RENDITION = 'http://ns.adobe.com/adobecloud/rel/rendition';

async function repoFolder(host, folderPath) {
  const items = [];
  const encPath = folderPath.split('/').map(encodeURIComponent).join('/');
  let start = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const qs = new URLSearchParams({ embed: REL_META, limit: '100' });
    if (start) qs.set('start', start);
    const r = await aemFetch(host, `/adobe/repository${encPath}?${qs}`);
    const children = Array.isArray(r.children) ? r.children : [];
    for (const k of children) {
      const id = k['repo:assetId'];
      if (typeof id !== 'string' || k['repo:assetClass'] === 'directory') continue;
      const md = k._embedded?.[REL_META] || {};
      const notes = md['xdm:brandScoreNotes'];
      const thumbHref = (k._links?.[REL_RENDITION] || []).map((x) => x?.href).find((h) => /cq5dam\.thumbnail\.319\.319/.test(h || ''));
      let thumb;
      try { if (thumbHref) { const u = new URL(thumbHref); if (u.origin === host) thumb = u.pathname + u.search; } } catch { /* ignore */ }
      const e = await cacheSet(host, id, {
        score: toScore(md['xdm:score']),
        notes: typeof notes === 'string' ? notes : null,
        name: k['repo:name'] ?? null,
        path: k['repo:path'] ?? null,
        ...(thumb ? { thumb } : {}),
      });
      items.push(toItem(id, e));
    }
    start = r._page?.next;
    if (!start || !children.length) break;
  }
  return items;
}

async function fetchAssetMeta(host, id) {
  try {
    const r = await aemFetch(host, `/adobe/assets/${encodeURIComponent(id)}/metadata`);
    const md = r.assetMetadata || {};
    const notes = md['xdm:brandScoreNotes'];
    const patch = { score: toScore(md['xdm:score']), notes: typeof notes === 'string' ? notes : null };
    // Only overwrite name/path when the API actually returned them.
    const name = r.repositoryMetadata?.['repo:name'];
    const path = r.repositoryMetadata?.['repo:path'];
    if (typeof name === 'string') patch.name = name;
    if (typeof path === 'string') patch.path = path;
    return cacheSet(host, id, patch);
  } catch (e) {
    if (e.status === 404 || e.status === 403) return cacheSet(host, id, { score: null, notes: null });
    throw e;
  }
}

// Fallback when bulk search is rejected: list ids + names, then refresh scores
// we already knew (stale ones) per asset. Unknown visible cards are fetched on
// demand by the content script via assetScores.
async function listFolder(host, folderPath) {
  const children = [];
  let cursor;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const qs = new URLSearchParams({ path: folderPath, types: 'ASSET', limit: '50' });
    if (cursor) qs.set('cursor', cursor);
    const r = await aemFetch(host, `/adobe/folders?${qs}`);
    const list = Array.isArray(r.children) ? r.children : [];
    for (const c of list) if (typeof c.assetId === 'string') children.push(c);
    cursor = r.cursor;
    if (!cursor || !list.length) break;
  }
  const c = await hostCache(host);
  const stale = children
    .filter((x) => c.has(x.assetId) && 'score' in c.get(x.assetId) && !isFresh(c.get(x.assetId)))
    .slice(0, MAX_REFRESH_PER_FOLDER);
  await pool(stale, CONCURRENCY, (x) => fetchAssetMeta(host, x.assetId));
  const items = [];
  for (const x of children) {
    const e = await cacheSet(host, x.assetId, { name: x.name ?? null, path: x.name ? `${folderPath}/${x.name}` : null });
    items.push(toItem(x.assetId, e));
  }
  return items;
}

// Everything the ranked view needs for the folder's direct children:
// score, notes, path. The folder load already brings notes, so this is
// usually answered from cache; otherwise refresh, then fill gaps per asset.
async function folderDetails(host, folderPath) {
  const c = await hostCache(host);
  const hasAll = (id) => { const e = c.get(id); return !!e && 'score' in e && e.notes !== undefined; };
  const idx = await getFolderIndex(host, folderPath);
  let ids = idx && Date.now() - idx.ts < FRESH_MS && idx.ids.every(hasAll) ? idx.ids : null;
  if (!ids) ids = (await refreshFolder(host, folderPath)).map((x) => x.id); // bulk with notes, or listing
  const need = ids.filter((id) => !hasAll(id)).slice(0, MAX_REFRESH_PER_FOLDER);
  if (need.length) await pool(need, CONCURRENCY, (id) => fetchAssetMeta(host, id));
  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
  return ids
    .map((id) => ({ id, ...c.get(id) }))
    .filter((e) => !e.path || parentOf(e.path) === folderPath) // search also returns subfolders
    .map(({ id, name, path, score, notes }) => ({ id, name: name ?? null, path: path ?? null, score: score ?? null, notes: notes ?? null }));
}

// Thumbnails for the ranked view. The grid lazy-loads (and hands its images to
// the page as blob: URLs), so most assets have no usable image on the page.
// Order of attempts:
//   1. the same request the Assets view makes: <asset path>/jcr:content/renditions/cq5dam.thumbnail.319.319.png
//      (the exact link from the folder listing when we have it)
//   2. an id-based URL pattern learned from the app's own requests (page-hook.js)
//   3. the 319px rendition via the Assets API
//   4. the web-optimized image
// Returns base64 bytes + type; the content script draws them on a canvas, which
// sidesteps the page's img-src CSP (data:/blob: images may be blocked there).
const thumbCache = new Map(); // `${host}|${id}` -> { type, data }, small LRU
const THUMB_RENDITION = 'cq5dam.thumbnail.319.319.png';
const ID_IN_URL = /urn(?::|%3A)aaid(?::|%3A)aem(?::|%3A)[0-9a-f-]{36}/i;

// "https://author…/x/urn:aaid:aem:<uuid>/y?w=320" -> { origin, tpl: "/x/{id}/y?w=320", encoded }
function thumbTemplate(url) {
  const u = new URL(url);
  if (!HOST_RE.test(u.origin)) return null;
  const pathAndQuery = u.pathname + u.search;
  const m = pathAndQuery.match(ID_IN_URL);
  if (!m) return null;
  return { origin: u.origin, tpl: pathAndQuery.replace(ID_IN_URL, '{id}'), encoded: /%3A/i.test(m[0]) };
}

async function learnThumbUrl(url) {
  let t = null;
  try { t = thumbTemplate(url); } catch { /* not a URL */ }
  if (!t) return;
  const { thumbTpl = {} } = await chrome.storage.session.get('thumbTpl');
  thumbTpl[t.origin] = t;
  await chrome.storage.session.set({ thumbTpl });
}

async function fetchThumb(host, id) {
  const key = `${host}|${id}`;
  if (thumbCache.has(key)) {
    const v = thumbCache.get(key);
    thumbCache.delete(key);
    thumbCache.set(key, v);
    return v;
  }
  const enc = encodeURIComponent(id);
  const { thumbTpl = {} } = await chrome.storage.session.get('thumbTpl');
  const learned = thumbTpl[host];
  const entry = await cacheGet(host, id);
  const path = entry?.path;
  const candidates = [
    entry?.thumb, // exact rendition link from the folder listing
    // What the Assets view itself fetches for grid thumbnails (path-based JCR rendition).
    path && `${path.split('/').map(encodeURIComponent).join('/')}/jcr%3Acontent/renditions/${THUMB_RENDITION}`,
    learned && learned.tpl.replace('{id}', learned.encoded ? enc : id),
    `/adobe/assets/${enc}/renditions/${THUMB_RENDITION}/as/thumb.png`,
    `/adobe/assets/${enc}`, // web-optimized original
  ].filter(Boolean);
  let res = null;
  let lastErr = null;
  for (const path of candidates) {
    try {
      res = await aemFetch(host, path, { raw: true });
      if ((res.headers.get('content-type') || '').startsWith('image/')) break;
      res = null;
    } catch (e) {
      lastErr = e;
      if (e.status === 0) throw e; // no token yet
    }
  }
  if (!res) throw lastErr || new Error('no thumbnail');
  const type = res.headers.get('content-type') || 'image/png';
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const v = { type, data: btoa(bin) };
  thumbCache.set(key, v);
  if (thumbCache.size > 60) thumbCache.delete(thumbCache.keys().next().value);
  return v;
}

// Open an asset's Details page in the same tab (works from any frame).
function detailUrl(tabUrl, assetPath) {
  const u = new URL(tabUrl);
  const m = u.hash.match(/^(#\/@[^/]+\/assets)\//);
  if (!m || !assetPath?.startsWith('/content/dam/')) return null;
  u.hash = `${m[1]}/detail${assetPath.split('/').map(encodeURIComponent).join('/')}`;
  return u.href;
}

const refreshes = new Map(); // `${host}|${path}` -> Promise<items>

function refreshFolder(host, folderPath) {
  const key = `${host}|${folderPath}`;
  if (refreshes.has(key)) return refreshes.get(key);
  const p = (async () => {
    let items = null;
    if (!(await bulkUnavailable(host))) {
      try {
        items = await repoFolder(host, folderPath); // scores + notes in one request
      } catch (e) {
        if (e.status === 0) throw e; // no token: not the endpoint's fault
        await markBulkUnavailable(host);
        console.warn('[Grid Brand Score] folder listing unavailable, using per-asset metadata:', e.message);
      }
    }
    if (!items) items = await listFolder(host, folderPath);
    await setFolderIndex(host, folderPath, items.map((x) => x.id));
    return items;
  })().finally(() => refreshes.delete(key));
  refreshes.set(key, p);
  return p;
}

// Stale-while-revalidate: return cached items at once, push fresh ones later.
async function folderScores(host, folderPath, tabId) {
  const idx = await getFolderIndex(host, folderPath);
  if (idx) {
    const c = await hostCache(host);
    const items = idx.ids.map((id) => toItem(id, c.get(id)));
    if (Date.now() - idx.ts > FRESH_MS && tabId != null) {
      refreshFolder(host, folderPath)
        .then((fresh) => chrome.tabs.sendMessage(tabId, { type: 'scores', items: fresh }))
        .catch((e) => console.debug('[Grid Brand Score] refresh failed:', e.message));
    }
    return { items, cached: true };
  }
  return { items: await refreshFolder(host, folderPath) };
}

// ---------- messaging ----------

async function handle(msg, sender) {
  switch (msg?.type) {
    case 'auth':
      await setAuth(msg.host, msg.authorization, msg.apiKey);
      return {};

    case 'harvest': {
      if (!HOST_RE.test(msg.host || '') || !Array.isArray(msg.items)) return {};
      for (const it of msg.items.slice(0, 500)) {
        if (typeof it?.id !== 'string') continue;
        const patch = { score: toScore(it.score) };
        if (typeof it.notes === 'string') patch.notes = it.notes;
        if (typeof it.name === 'string') patch.name = it.name;
        await cacheSet(msg.host, it.id, patch);
      }
      return {};
    }

    case 'navigated':
      if (sender.tab?.id != null) chrome.tabs.sendMessage(sender.tab.id, { type: 'navigated' }).catch(() => {});
      return {};

    case 'folderScores': {
      const { folderPath } = parseTabUrl(sender.tab?.url || '');
      const host = await resolveHost(sender);
      if (!folderPath || !host) return { items: [], noFolder: true };
      return { ...(await folderScores(host, folderPath, sender.tab?.id)), folderPath };
    }

    case 'assetScores': {
      const host = await resolveHost(sender);
      const ids = Array.isArray(msg.ids) ? msg.ids.filter((x) => typeof x === 'string').slice(0, 200) : [];
      if (!host || !ids.length) return { items: [] };
      const entries = await pool(ids, CONCURRENCY, async (id) => {
        const e = await cacheGet(host, id);
        return e && 'score' in e && isFresh(e) ? e : fetchAssetMeta(host, id);
      });
      // Failed ids are omitted so the content script retries them with backoff.
      return { items: ids.map((id, i) => entries[i] && toItem(id, entries[i])).filter(Boolean) };
    }

    case 'folderDetails': {
      const { folderPath } = parseTabUrl(sender.tab?.url || '');
      const host = await resolveHost(sender);
      if (!folderPath || !host) return { items: [], folderPath: null };
      return { items: await folderDetails(host, folderPath), folderPath };
    }

    case 'thumb': {
      const host = await resolveHost(sender);
      if (!host || typeof msg.id !== 'string') return { image: null };
      return { image: await fetchThumb(host, msg.id) };
    }

    case 'thumbSample':
      if (typeof msg.url === 'string') await learnThumbUrl(msg.url);
      return {};

    case 'openAsset': {
      const url = sender.tab?.url && detailUrl(sender.tab.url, msg.path);
      if (url && sender.tab?.id != null) await chrome.tabs.update(sender.tab.id, { url });
      return { opened: !!url };
    }

    case 'notes': {
      const host = await resolveHost(sender);
      if (!host || typeof msg.id !== 'string') return { notes: null };
      const cached = await cacheGet(host, msg.id);
      const entry = cached && cached.notes !== undefined ? cached : await fetchAssetMeta(host, msg.id);
      return { notes: entry.notes ?? null, score: entry.score ?? null };
    }

    default:
      return {};
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg, sender).then(
    (r) => sendResponse({ ok: true, ...r }),
    (e) => sendResponse({ ok: false, error: String(e?.message || e) }),
  );
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
