// Node test for src/background.js with mocked chrome + fetch.  Run: node tests/background.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const HOST = 'https://author-p12345-e67890.adobeaemcloud.com';
const TAB_URL = `https://experience.adobe.com/?repoId=author-p12345-e67890.adobeaemcloud.com#/@yourorg/assets/browse/content/dam/campaigns/spring/output`;
const SRC = fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ASSETS = Array.from({ length: 60 }, (_, i) => ({
  id: `urn:aaid:aem:00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  name: `asset-${i}.jpg`,
  score: i % 10 === 0 ? null : (70 + (i % 21)).toFixed(1),
}));

function storageArea(backing) {
  return {
    get: async (k) => (typeof k === 'string' ? { [k]: structuredClone(backing[k]) } : structuredClone(backing)),
    set: async (o) => { Object.assign(backing, structuredClone(o)); },
  };
}

// `disk` is shared between envs to simulate a service-worker restart.
function makeEnv({ disk = { local: {}, session: {} }, server = {} } = {}) {
  let listener;
  const calls = [];
  const pushed = [];
  const opts = { searchStatus: 200, tokens: ['Bearer TOKEN'], fail503: 0, ...server };
  const chrome = {
    runtime: { id: 'ext', onMessage: { addListener: (fn) => { listener = fn; } }, openOptionsPage() {} },
    storage: { session: storageArea(disk.session), local: storageArea(disk.local) },
    tabs: { sendMessage: async (tabId, msg) => { pushed.push(msg); } },
    action: { onClicked: { addListener() {} } },
  };
  async function fetch(url, init) {
    calls.push(`${init.method} ${url.replace(HOST, '')}`);
    assert.strictEqual(init.headers['x-api-key'], 'KEY');
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const fail = (status) => ({ ok: false, status, json: async () => ({}) });
    if (!opts.tokens.includes(init.headers.Authorization)) return fail(401);
    if (opts.fail503 > 0) { opts.fail503--; return fail(503); }
    if (url.includes('/search-assets')) {
      if (opts.searchStatus !== 200) return fail(opts.searchStatus);
      assert.strictEqual(init.headers['X-Adobe-Accept-Experimental'], '1');
      const body = JSON.parse(init.body);
      assert.strictEqual(body.termFilters[0].value, '/content/dam/campaigns/spring/output');
      const start = body.cursor ? 50 : 0;
      return ok({
        results: ASSETS.slice(start, start + 50).map((a) => ({ assetId: a.id, repositoryMetadata: { 'repo:name': a.name },
          assetMetadata: a.score == null ? {} : { 'xdm:score': a.score } })),
        cursor: start + 50 < ASSETS.length ? 'next' : undefined,
      });
    }
    if (url.includes('/adobe/folders?')) {
      return ok({ children: ASSETS.map((a) => ({ type: 'ASSET', assetId: a.id, name: a.name })) });
    }
    const m = url.match(/\/adobe\/assets\/([^/]+)\/metadata/);
    if (m) {
      const a = ASSETS.find((x) => x.id === decodeURIComponent(m[1]));
      return ok({ assetMetadata: { 'xdm:score': a.score == null ? undefined : Number(a.score), 'xdm:brandScoreNotes': `notes ${a.name}` },
        repositoryMetadata: { 'repo:name': a.name } });
    }
    throw new Error('unexpected ' + url);
  }
  const ctx = { chrome, fetch, console: { warn() {}, debug() {}, log: console.log }, setTimeout, clearTimeout, structuredClone, URL, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const send = (msg) => new Promise((resolve) => listener(msg, { id: 'ext', tab: { id: 1, url: TAB_URL } }, resolve));
  const auth = (token = 'Bearer TOKEN') => send({ type: 'auth', host: HOST, authorization: token, apiKey: 'KEY' });
  return { send, auth, calls, pushed, disk, opts };
}

(async () => {
  // 1. Bulk search, then instant cached answers after a service-worker restart.
  {
    const a = makeEnv();
    await a.auth();
    const r = await a.send({ type: 'folderScores' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.items.length, 60);
    assert.strictEqual(r.items[1].score, 71);
    assert.strictEqual(r.items[0].score, null);
    assert.strictEqual(a.calls.length, 2, 'two search pages');
    await sleep(700); // let the debounced cache flush hit storage.local

    const b = makeEnv({ disk: a.disk }); // "restarted" worker, same storage
    const r2 = await b.send({ type: 'folderScores' });
    assert.ok(r2.cached, 'served from persistent cache');
    assert.strictEqual(r2.items[1].score, 71);
    assert.strictEqual(b.calls.length, 0, 'no network while fresh');
    console.log('ok bulk search + persistent cache');
  }

  // 2. Stale cache: served immediately, refreshed in background and pushed to the tab.
  {
    const a = makeEnv();
    await a.auth();
    await a.send({ type: 'folderScores' });
    await sleep(700);
    for (const k of Object.keys(a.disk.local)) if (k.startsWith('f:')) a.disk.local[k].ts -= 120_000;
    const b = makeEnv({ disk: a.disk });
    const r = await b.send({ type: 'folderScores' });
    assert.ok(r.cached);
    await sleep(50);
    assert.strictEqual(b.pushed.length, 1, 'fresh scores pushed');
    assert.strictEqual(b.pushed[0].type, 'scores');
    assert.strictEqual(b.pushed[0].items.length, 60);
    console.log('ok stale-while-revalidate');
  }

  // 3. Search rejected: falls back, and the failure is remembered.
  {
    const a = makeEnv({ server: { searchStatus: 403 } });
    await a.auth();
    const r = await a.send({ type: 'folderScores' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.items.length, 60);
    assert.ok(!('score' in r.items[5]), 'listing has no scores');
    const s = await a.send({ type: 'assetScores', ids: [ASSETS[5].id, ASSETS[10].id] });
    assert.deepStrictEqual(s.items.map((x) => x.score), [75, null]);
    const n = await a.send({ type: 'notes', id: ASSETS[5].id });
    assert.strictEqual(n.notes, 'notes asset-5.jpg');
    assert.strictEqual(a.calls.filter((c) => c.includes('/metadata')).length, 2, 'notes came from cache');
    const b = makeEnv({ disk: a.disk, server: { searchStatus: 403 } });
    for (const k of Object.keys(a.disk.local)) if (k.startsWith('f:')) delete a.disk.local[k];
    await b.send({ type: 'folderScores' });
    assert.ok(!b.calls.some((c) => c.includes('search-assets')), 'search not retried');
    console.log('ok fallback + remembered search failure');
  }

  // 4. Expired token: 401 waits for the app's refreshed token, then succeeds.
  {
    const a = makeEnv({ server: { tokens: ['Bearer NEW'] } });
    await a.auth('Bearer OLD');
    const p = a.send({ type: 'folderScores' });
    await sleep(100);
    await a.auth('Bearer NEW');
    const r = await p;
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.items.length, 60);
    console.log('ok token refresh after 401');
  }

  // 5. Transient 503s are retried.
  {
    const a = makeEnv({ server: { fail503: 2 } });
    await a.auth();
    const r = await a.send({ type: 'folderScores' });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.items.length, 60);
    console.log('ok 5xx retry');
  }

  // 6. Foreign hosts are ignored.
  {
    const a = makeEnv();
    await a.send({ type: 'auth', host: 'https://evil.example.com', authorization: 'Bearer X' });
    assert.deepStrictEqual(a.disk.session.auth, undefined);
    console.log('ok host validation');
  }
})().catch((e) => { console.error(e); process.exit(1); });
