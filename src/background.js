// Service worker: data layer. Holds the captured IMS token (chrome.storage.session,
// memory-only), calls the AEM Assets API with it, and keeps a persistent score
// cache (chrome.storage.local) so badges render instantly and refresh behind.

const SEARCH_PATH = '/adobe/experimental/aemmcpserver-expires-20991231/search-assets';
const HOST_RE = /^https:\/\/[a-z0-9-]+\.adobeaemcloud\.com$/i;
const FRESH_MS = 60_000; // older cached data is shown, then refreshed in the background
const SEARCH_RETRY_MS = 30 * 60_000; // re-try bulk search this long after it failed
const AUTH_WAIT_MS = 20_000;
const MAX_SEARCH_PAGES = 10; // 500 assets
const MAX_LIST_PAGES = 10;
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

async function searchUnavailable(host) {
  const { noSearch = {} } = await chrome.storage.session.get('noSearch');
  return noSearch[host] && Date.now() - noSearch[host] < SEARCH_RETRY_MS;
}

async function markSearchUnavailable(host) {
  const { noSearch = {} } = await chrome.storage.session.get('noSearch');
  noSearch[host] = Date.now();
  await chrome.storage.session.set({ noSearch });
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
  return item;
}

// Retries: one fresh token after 401, two backoffs for network errors / 429 / 5xx.
async function aemFetch(host, path, { method = 'GET', body } = {}) {
  let staleToken = null;
  for (let attempt = 0; ; attempt++) {
    const auth = await waitForAuth(host, staleToken);
    if (!auth) {
      const err = new Error('No AEM token captured yet — reload the Assets view tab.');
      err.status = 0;
      throw err;
    }
    const headers = { Authorization: auth.authorization, Accept: 'application/json' };
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
    return res.json();
  }
}

// ---------- AEM calls ----------

async function searchFolder(host, folderPath) {
  const items = [];
  let cursor;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const body = {
      termFilters: [{ key: 'repositoryMetadata.repo:ancestors', value: folderPath }],
      projectedFields: { includes: ['repositoryMetadata.repo:name', 'assetMetadata.xdm:score'] },
      limit: 50,
    };
    if (cursor) body.cursor = cursor;
    const r = await aemFetch(host, SEARCH_PATH, { method: 'POST', body });
    const results = Array.isArray(r.results) ? r.results : [];
    for (const x of results) {
      if (typeof x.assetId !== 'string') continue;
      const score = toScore(x.assetMetadata?.['xdm:score']);
      const patch = { score, name: x.repositoryMetadata?.['repo:name'] ?? null };
      const prev = await cacheGet(host, x.assetId);
      if (prev && prev.score !== score) patch.notes = undefined; // re-scored: notes are stale
      const e = await cacheSet(host, x.assetId, patch);
      items.push(toItem(x.assetId, e));
    }
    cursor = r.cursor;
    if (!cursor || !results.length) break;
  }
  return items;
}

async function fetchAssetMeta(host, id) {
  try {
    const r = await aemFetch(host, `/adobe/assets/${encodeURIComponent(id)}/metadata`);
    const md = r.assetMetadata || {};
    const notes = md['xdm:brandScoreNotes'];
    return cacheSet(host, id, {
      score: toScore(md['xdm:score']),
      notes: typeof notes === 'string' ? notes : null,
      name: r.repositoryMetadata?.['repo:name'] ?? null,
    });
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
    const e = await cacheSet(host, x.assetId, { name: x.name ?? null });
    items.push(toItem(x.assetId, e));
  }
  return items;
}

const refreshes = new Map(); // `${host}|${path}` -> Promise<items>

function refreshFolder(host, folderPath) {
  const key = `${host}|${folderPath}`;
  if (refreshes.has(key)) return refreshes.get(key);
  const p = (async () => {
    let items = null;
    if (!(await searchUnavailable(host))) {
      try {
        items = await searchFolder(host, folderPath);
      } catch (e) {
        if (e.status === 0) throw e; // no token: not the search endpoint's fault
        await markSearchUnavailable(host);
        console.warn('[Grid Brand Score] bulk search unavailable, using per-asset metadata:', e.message);
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
      return folderScores(host, folderPath, sender.tab?.id);
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
