import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { YimuClient } from '../dist/api.js';
import { registerYimuTools } from '../dist/tools.js';

const BASE = 'https://yimubill.com/api';
const JWT = 'synthetic-initial-jwt-do-not-use';
const USER_TOKEN = 'synthetic-user-object-token-do-not-use';
const PASSWORD = 'synthetic-password-do-not-use';
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function connect(t, { fetchImpl, token = JWT, userToken = USER_TOKEN, creds, options } = {}) {
  const api = new YimuClient({ baseUrl: BASE, token, userToken, userId: '42', fetchImpl: fetchImpl ?? (() => { throw new Error('Unexpected fetch in offline test'); }) });
  const server = new McpServer({ name: 'security-regression-test', version: '1.0.0' });
  registerYimuTools(server, api, tmpdir(), creds, options);
  const client = new Client({ name: 'security-regression-client', version: '1.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { api, client, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}

function textOf(result) {
  assert.ok(Array.isArray(result.content), 'tool must return MCP content');
  assert.ok(result.content.length > 0, 'tool must return at least one content block');
  for (const item of result.content) if (item.type === 'text') assert.equal(typeof item.text, 'string');
  return result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function decoded(result) {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

function excludesSecrets(result, secrets) {
  const wireResult = JSON.stringify(result);
  for (const value of secrets) assert.equal(wireResult.includes(value), false, 'MCP result exposed a synthetic secret');
}

function noCredentialFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(token|password|accesskeyid|accesskeysecret|securitytoken)$/i.test(key.replace(/[_-]/g, '')), `credential field survived: ${key}`);
    noCredentialFields(child);
  }
}

test('default tool surface excludes credential exports and the general API escape hatch', async (t) => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of ['get_sts', 'get_sts_no_verify', 'api_request', 'login_qr_recognize']) assert.equal(names.has(name), false, `${name} must not be registered by default`);
  for (const name of ['login_email', 'login_qr_poll', 'get_me', 'get_bill_count', 'save_bill', 'sync_pull']) assert.equal(names.has(name), true, `${name} must remain usable`);
});

test('QR recognition of arbitrary host files is not exposed via MCP in any mode', async (t) => {
  for (const settings of [
    { token: '', options: undefined },
    { token: JWT, options: { enableApiRequest: true } },
  ]) {
    const { client } = await connect(t, settings);
    const { tools } = await client.listTools();
    const names = new Set(tools.map(({ name }) => name));
    assert.equal(names.has('login_qr_recognize'), false, 'host file QR reader must not be registered');
    assert.equal(names.has('login_qr_start'), true, 'QR login generation must stay available');
    assert.equal(names.has('login_qr_poll'), true, 'QR login polling must stay available');
  }
});

test('auth_status preserves safe Boolean credential status without disclosing values', async (t) => {
  for (const configured of [false, true]) {
    const { call } = await connect(t, { token: configured ? JWT : '', creds: { email: configured ? 'offline@example.invalid' : '', password: configured ? PASSWORD : '' } });
    const result = await call('auth_status');
    const status = decoded(result);
    assert.equal(status.logged_in, configured);
    assert.equal(status.token_set, configured);
    assert.equal(status.password_configured, configured);
    assert.equal(status.email_configured, configured);
    assert.equal(status.base_url, BASE);
    excludesSecrets(result, [JWT, PASSWORD, USER_TOKEN]);
  }
});

test('QR login returns safe identity while its JWT remains usable and refreshes internally', async (t) => {
  const loginJwt = 'synthetic-qr-jwt-do-not-use';
  const refreshedJwt = 'synthetic-refreshed-jwt-do-not-use';
  const requests = [];
  const { call, api } = await connect(t, { token: '', userToken: '', fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/getScanLogin/')) return json({ code: 0, token: loginJwt, result: { id: 42, name: 'Offline user', email: 'offline@example.invalid', token: USER_TOKEN, password: PASSWORD } });
    if (url.endsWith('/getUserInfoById')) return json({ code: 0, token: refreshedJwt, result: { id: 42, name: 'Offline user', token: USER_TOKEN } });
    return json({ code: 0, result: 7 });
  } });
  const login = await call('login_qr_poll', { session_id: 'offline-session', timeout: 0 });
  assert.deepEqual(decoded(login), { status: 'success', user: { id: 42, name: 'Offline user', email: 'offline@example.invalid' } });
  excludesSecrets(login, [loginJwt, USER_TOKEN, PASSWORD]);
  assert.equal(api.token, loginJwt);
  assert.equal(api.userToken, USER_TOKEN);
  assert.equal(api.userId, '42');
  assert.deepEqual(decoded(await call('get_me')), { id: 42, name: 'Offline user' });
  assert.equal(requests[1].init.headers.token, loginJwt);
  assert.equal(new URLSearchParams(requests[1].init.body).get('token'), USER_TOKEN);
  assert.equal(api.token, refreshedJwt);
  assert.equal(decoded(await call('get_bill_count')), 7);
  assert.equal(requests[2].init.headers.token, refreshedJwt);
});

test('pending QR login remains a valid status result without authenticating', async (t) => {
  const { call, api } = await connect(t, { token: '', userToken: '', fetchImpl: async () => json({ code: 1, msg: 'no data' }) });
  assert.equal(decoded(await call('login_qr_poll', { session_id: 'not-scanned', timeout: 0 })).status, 'pending');
  assert.equal(api.token, '');
});

test('protected tools still reject unauthenticated calls without issuing a request', async (t) => {
  let fetched = false;
  const { call } = await connect(t, { token: '', userToken: '', fetchImpl: async () => { fetched = true; return json({ code: 0, result: 7 }); } });
  const result = await call('get_bill_count');
  assert.equal(result.isError, true);
  assert.ok(textOf(result).length > 0);
  assert.equal(fetched, false);
});

for (const source of ['tool arguments', 'configured credentials']) {
  test(`email login via ${source} protects credentials and preserves subsequent authentication`, async (t) => {
    const loginJwt = 'synthetic-email-jwt-do-not-use';
    const requests = [];
    const credentials = { email: 'offline@example.invalid', password: PASSWORD };
    const { call, api } = await connect(t, { token: '', userToken: '', creds: source === 'configured credentials' ? credentials : undefined, fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith('/getUserEmail')) return json({ code: 0, token: loginJwt, result: { id: 42, name: 'Offline user', token: USER_TOKEN, password: PASSWORD } });
      return json({ code: 0, result: { count: 3, note: `credential echo: ${PASSWORD} / ${loginJwt} / ${USER_TOKEN}` } });
    } });
    const login = await call('login_email', source === 'tool arguments' ? credentials : {});
    const data = decoded(login);
    assert.equal(data.status, 'success');
    assert.deepEqual(data.user, { id: 42, name: 'Offline user' });
    noCredentialFields(data);
    excludesSecrets(login, [loginJwt, PASSWORD, USER_TOKEN]);
    assert.equal(api.token, loginJwt);
    const form = new URLSearchParams(requests[0].init.body);
    assert.equal(form.get('email'), credentials.email);
    assert.notEqual(form.get('password'), PASSWORD);
    assert.match(form.get('password'), /^[A-F0-9]+$/);
    const followup = await call('get_bill_count');
    assert.equal(decoded(followup).count, 3);
    excludesSecrets(followup, [loginJwt, PASSWORD, USER_TOKEN]);
    assert.equal(requests[1].init.headers.token, loginJwt);
  });
}

test('a public email used as userObjectToken remains visible in the safe profile', async (t) => {
  const email = 'offline-public-profile@example.invalid';
  const requests = [];
  const { call, api } = await connect(t, { token: '', userToken: '', fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return json({ code: 0, token: JWT, result: { id: 42, name: 'Offline user', email, token: email } });
  } });
  const login = decoded(await call('login_email', { email, password: PASSWORD }));
  assert.equal(login.user.email, email);
  assert.equal(api.userToken, email);
  const profile = decoded(await call('get_me'));
  assert.equal(profile.email, email);
  assert.equal(new URLSearchParams(requests[1].init.body).get('token'), email);
  noCredentialFields(login);
  noCredentialFields(profile);
});

test('late response echoes cannot reveal old JWTs or a previous plaintext/encrypted login password', async (t) => {
  const firstJwt = 'synthetic-before-refresh-jwt-do-not-use';
  const refreshedJwt = 'synthetic-after-refresh-jwt-do-not-use';
  let encryptedPassword = '';
  const requests = [];
  const { call, api } = await connect(t, { fetchImpl: async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith('/getUserEmail')) {
      encryptedPassword = new URLSearchParams(init.body).get('password');
      return json({ code: 0, token: firstJwt, result: { id: 42, token: USER_TOKEN } });
    }
    if (url.endsWith('/getUserInfoById')) return json({ code: 0, token: refreshedJwt, result: { id: 42 } });
    return json({ code: 0, result: { count: 7, note: `late echo ${JWT} ${firstJwt} ${refreshedJwt} ${PASSWORD} ${encryptedPassword}` } });
  } });
  decoded(await call('login_email', { email: 'offline@example.invalid', password: PASSWORD }));
  assert.match(encryptedPassword, /^[A-F0-9]+$/);
  decoded(await call('get_me'));
  assert.equal(api.token, refreshedJwt);
  const result = await call('get_delete_history');
  assert.equal(decoded(result).count, 7);
  excludesSecrets(result, [JWT, firstJwt, refreshedJwt, PASSWORD, encryptedPassword]);
  assert.equal(requests[1].init.headers.token, firstJwt);
  assert.equal(requests[2].init.headers.token, refreshedJwt);
});

test('all normal tool output removes nested credential fields and embedded known secrets', async (t) => {
  const upstream = { count: 0, enabled: false, label: 'ordinary ledger data', nested: [{ token: 'synthetic-foreign-token', password: 'synthetic-foreign-password', AccessKeyId: 'synthetic-access-id', AccessKeySecret: 'synthetic-access-secret', SecurityToken: 'synthetic-security-token', kept: 'useful' }], serialized: JSON.stringify({ label: 'serialized business data', nested: { AccessKeySecret: 'synthetic-serialized-access-secret', password: PASSWORD } }), note: `JWT=${JWT}; user=${USER_TOKEN}; password=${PASSWORD}; repeated=${JWT}` };
  const { call } = await connect(t, { creds: { email: 'offline@example.invalid', password: PASSWORD }, fetchImpl: async () => json({ code: 0, result: upstream }) });
  const result = await call('get_delete_history');
  const data = decoded(result);
  assert.equal(data.count, 0);
  assert.equal(data.enabled, false);
  assert.equal(data.label, 'ordinary ledger data');
  assert.equal(data.nested[0].kept, 'useful');
  const serialized = JSON.parse(data.serialized);
  assert.equal(serialized.label, 'serialized business data');
  noCredentialFields(serialized);
  noCredentialFields(data);
  excludesSecrets(result, [JWT, USER_TOKEN, PASSWORD, 'synthetic-foreign-token', 'synthetic-foreign-password', 'synthetic-access-id', 'synthetic-access-secret', 'synthetic-security-token', 'synthetic-serialized-access-secret']);
});

test('explicitly enabled raw API preserves raw business data but cannot bypass sanitization', async (t) => {
  const { call, client } = await connect(t, { options: { enableApiRequest: true }, fetchImpl: async () => json({ code: 0, token: JWT, result: { count: 0, enabled: false, blank: '', absent: null, items: [{ AccessKeyId: 'synthetic-raw-access-id', AccessKeySecret: 'synthetic-raw-access-secret', SecurityToken: 'synthetic-raw-security-token', token: USER_TOKEN, password: PASSWORD, label: 'preserved' }], remark: `Authorization: ${JWT}` } }) });
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('api_request'));
  assert.ok(!names.includes('get_sts') && !names.includes('get_sts_no_verify'));
  const result = await call('api_request', { method: 'GET', path: '/app/getSts/42', raw: true });
  const data = decoded(result);
  assert.equal(data.code, 0);
  assert.equal(data.result.count, 0);
  assert.equal(data.result.enabled, false);
  assert.equal(data.result.blank, '');
  assert.equal(data.result.absent, null);
  assert.equal(data.result.items[0].label, 'preserved');
  noCredentialFields(data);
  excludesSecrets(result, [JWT, USER_TOKEN, PASSWORD, 'synthetic-raw-access-id', 'synthetic-raw-access-secret', 'synthetic-raw-security-token']);
});

for (const [label, payload] of [['null', null], ['empty object', {}], ['credential-only object', { token: JWT, password: PASSWORD }]]) {
  test(`empty or credential-only upstream output stays valid MCP text (${label})`, async (t) => {
    const { call } = await connect(t, { fetchImpl: async () => json({ code: 0, result: payload }) });
    const result = await call('get_delete_history');
    assert.notEqual(result.isError, true);
    assert.doesNotThrow(() => JSON.parse(textOf(result)));
    excludesSecrets(result, [JWT, PASSWORD]);
  });
}

test('API failures become safe MCP errors without echoing upstream secrets or server messages', async (t) => {
  const marker = 'SYNTHETIC-UPSTREAM-ERROR-MUST-NOT-ESCAPE';
  const { call } = await connect(t, { fetchImpl: async () => json({ code: 403, msg: `${marker}: ${JWT}`, result: { password: PASSWORD } }) });
  const result = await call('get_bill_count');
  assert.equal(result.isError, true);
  assert.ok(textOf(result).length > 0);
  excludesSecrets(result, [marker, JWT, PASSWORD]);
});

test('ordinary save_bill keeps the business request and successful response intact', async (t) => {
  const bill = { billId: 123, cost: 12.34, time: 1760000000000, recordTime: 1760000000000, parentCategoryId: 2, remark: 'Lunch', tags: ['lunch'] };
  const saved = { billId: 123, saved: true, cost: 12.34, remark: 'Lunch', balance: 0 };
  let request;
  const { call } = await connect(t, { fetchImpl: async (url, init) => { request = { url, init }; return json({ code: 0, result: saved }); } });
  assert.deepEqual(decoded(await call('save_bill', { bill })), saved);
  assert.equal(request.url, `${BASE}/bill/addOrUpdateBill`);
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers.token, JWT);
  assert.deepEqual(JSON.parse(request.init.body), { ...bill, tags: '["lunch"]', userId: 42 });
});

test('ordinary JSON ledger remarks preserve large integers and original formatting', async (t) => {
  const remark = '{ "orderId": 9223372036854775807, "amount": 12.3400 }';
  const { call } = await connect(t, { fetchImpl: async () => json({
    code: 0, result: { Bill: [{ billId: 123, cost: 12.34, remark }] },
  }) });
  const result = decoded(await call('sync_pull', { summary: false }));
  assert.equal(result.Bill[0].remark, remark);
});

for (const [label, remark, expected] of [
  ['credential field', '{ "orderId": 9223372036854775807, "token": "synthetic-remark-secret" }', '{"orderId":9223372036854775807}'],
  ['known secret echo', '{ "orderId": 9223372036854775807, "note": "' + JWT + '" }', '{"orderId":9223372036854775807,"note":"[REDACTED]"}'],
  ['numeric spellings', '{"password":"hidden","values":[-9223372036854775809,12.3400,1e400,1e-400,-0]}', '{"values":[-9223372036854775809,12.3400,1e400,1e-400,-0]}'],
  ['nested JSON string', JSON.stringify({ nested: '{"orderId":9223372036854775807,"token":"hidden"}' }), JSON.stringify({ nested: '{"orderId":9223372036854775807}' })],
]) {
  test(`JSON ledger remarks preserve numeric source text while removing ${label}`, async (t) => {
    const { call } = await connect(t, { fetchImpl: async () => json({
      code: 0, result: { Bill: [{ billId: 123, cost: 12.34, remark }] },
    }) });
    const result = decoded(await call('sync_pull', { summary: false }));
    assert.equal(result.Bill[0].remark, expected);
  });
}
