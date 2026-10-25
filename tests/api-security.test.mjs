import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { YimuClient, YimuError } from '../dist/api.js';

const BASE = 'https://yimubill.com/api';
const TOKEN = 'synthetic-transport-token-do-not-use';
const MARKER = 'SYNTHETIC-UNTRUSTED-SERVER-CONTENT';
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

for (const baseUrl of [BASE, `${BASE}/`]) {
  test(`canonical official base accepts legitimate API and bookkeeping routes: ${baseUrl}`, async () => {
    const calls = [];
    const api = new YimuClient({ baseUrl, token: TOKEN, fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ code: 0, result: { count: 0, ok: false } }); } });
    assert.deepEqual(await api.request('GET', '/api/bill/getBillCount/{userId}', { params: { userId: 42 }, query: { page: 0 } }), { count: 0, ok: false });
    await api.syncStart();
    assert.equal(api.baseUrl, BASE);
    assert.equal(calls[0].url, `${BASE}/bill/getBillCount/42?page=0`);
    assert.equal(calls[1].url, 'https://yimubill.com/bookkeeping/rateLimit/sync/start');
    for (const { url, init } of calls) {
      assert.equal(new URL(url).origin, 'https://yimubill.com');
      assert.equal(init.headers.token, TOKEN);
      assert.equal(init.redirect, 'error', 'authenticated fetch must fail closed on redirects');
    }
  });
}

const invalidBases = [
  'https://attacker.invalid/api',
  'https://yimubill.com.attacker.invalid/api',
  'http://yimubill.com/api',
  'https://user@yimubill.com/api',
  'https://user:password@yimubill.com/api',
  'https://yimubill.com:444/api',
  'https://yimubill.com/api?target=elsewhere',
  'https://yimubill.com/api#fragment',
  'https://yimubill.com/other',
  'https://yimubill.com/',
];
for (const baseUrl of invalidBases) {
  test(`reject untrusted/noncanonical API base before transport: ${baseUrl}`, () => {
    let called = false;
    assert.throws(() => new YimuClient({ baseUrl, token: TOKEN, fetchImpl: async () => { called = true; return json({ code: 0 }); } }));
    assert.equal(called, false);
  });
}

test('hostile API path spellings cannot send authentication outside the official origin', async () => {
  const calls = [];
  const api = new YimuClient({ baseUrl: BASE, token: TOKEN, fetchImpl: async (url, init) => { calls.push({ url, init }); return json({ code: 0, result: 'ok' }); } });
  for (const path of ['https://attacker.invalid/collect', '//attacker.invalid/collect', '\\\\attacker.invalid/collect', '/bookkeeping/../../../\\attacker.invalid/collect']) {
    try { await api.request('GET', path); } catch (error) { assert.ok(error instanceof Error); }
  }
  for (const { url, init } of calls) {
    assert.equal(new URL(url).origin, 'https://yimubill.com');
    assert.equal(init.redirect, 'error');
  }
});

const unsafeFailures = [
  ['HTTP response body', async () => new Response(`${MARKER} ${TOKEN}`, { status: 502 })],
  ['business error message', async () => json({ code: 403, msg: `${MARKER} ${TOKEN}`, result: { detail: MARKER } })],
  ['malformed business error code', async () => json({ code: MARKER, msg: '' })],
  ['nested network error', async () => { throw new Error(`${MARKER} ${TOKEN}`, { cause: new Error(`nested ${MARKER}`) }); }],
  ['JSON parser error with nested cause', async () => ({ ok: true, status: 200, json: async () => { throw new Error(MARKER, { cause: new Error(TOKEN) }); }, text: async () => MARKER })],
];
for (const [label, fetchImpl] of unsafeFailures) {
  test(`${label} exposes a bounded safe error, including its cause chain`, async () => {
    const api = new YimuClient({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await assert.rejects(api.getBillCount(42), (error) => {
      assert.ok(error instanceof YimuError);
      assert.ok(error.message.length > 0 && error.message.length < 300);
      const exposed = inspect(error, { depth: 20, showHidden: true });
      assert.equal(exposed.includes(MARKER), false, 'untrusted upstream content leaked through Error');
      assert.equal(exposed.includes(TOKEN), false, 'known token leaked through Error');
      return true;
    });
  });
}

test('valid no-data and sync-rate-limit envelopes remain supported', async () => {
  const responses = [{ code: 1, msg: 'no data' }, { code: 200, syncCount: 2, sessionId: 'synthetic-sync-session' }];
  const api = new YimuClient({ baseUrl: BASE, fetchImpl: async () => json(responses.shift()) });
  assert.equal(await api.getDeleteHistory(42, 0), null);
  assert.deepEqual(await api.syncStart(), { code: 200, syncCount: 2, sessionId: 'synthetic-sync-session' });
});
