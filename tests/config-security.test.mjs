import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const BASE = 'https://yimubill.com/api';
const moduleUrl = new URL('../dist/config.js', import.meta.url).href;

function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'yimu-offline-config-test-'));
  t.after(() => {
    const resolvedDir = path.resolve(dir);
    const relative = path.relative(path.resolve(tmpdir()), resolvedDir);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'cleanup target must stay inside the temporary directory');
    assert.ok(path.basename(resolvedDir).startsWith('yimu-offline-config-test-'), 'cleanup target must use the test directory prefix');
    rmSync(resolvedDir, { recursive: true, force: true });
  });
  return dir;
}

function runConfig(cwd, { args = [], env = {} } = {}) {
  // No inherited YIMU_* values, NODE_OPTIONS, credentials, or user config files.
  const cleanEnv = { TEMP: cwd, TMP: cwd, ...env };
  for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) cleanEnv[key] = process.env[key];
  const script = `
    globalThis.fetch = () => { throw new Error('Network forbidden in config regression tests'); };
    process.argv = [process.execPath, 'offline-config-test', ...${JSON.stringify(args)}];
    const { CONFIG, CONFIG_FILE, RESOLVED } = await import(${JSON.stringify(moduleUrl)});
    console.log(JSON.stringify({ config: CONFIG, configFile: CONFIG_FILE?.path ?? null, sources: Object.fromEntries(Object.entries(RESOLVED).map(([k, v]) => [k, v.source])) }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env: cleanEnv, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function failure(result) {
  assert.notEqual(result.status, 0, 'invalid explicit configuration must fail closed');
  assert.equal(result.stdout.trim(), '', 'failed config must not produce a usable configuration');
}

test('an attacker-controlled cwd yimu.config.json is never loaded implicitly', (t) => {
  const dir = sandbox(t);
  writeFileSync(path.join(dir, 'yimu.config.json'), JSON.stringify({ token: 'synthetic-cwd-token', password: 'synthetic-cwd-password', userId: 999, baseUrl: 'https://attacker.invalid/api' }));
  const { config, configFile, sources } = success(runConfig(dir));
  assert.equal(config.baseUrl, BASE);
  assert.equal(config.token, '');
  assert.equal(config.password, '');
  assert.equal(config.userId, '');
  assert.equal(configFile, null);
  assert.equal(sources.baseUrl, 'default');
});

test('a malformed implicit cwd config is ignored', (t) => {
  const dir = sandbox(t);
  writeFileSync(path.join(dir, 'yimu.config.json'), '{ definitely not JSON');
  assert.equal(success(runConfig(dir)).config.baseUrl, BASE);
});

for (const selector of ['--config', 'YIMU_CONFIG']) {
  test(`${selector} accepts an explicit absolute file and environment fields override it`, (t) => {
    const dir = sandbox(t);
    const file = path.join(dir, 'chosen-config.json');
    writeFileSync(file, JSON.stringify({ token: 'synthetic-file-token', userToken: 'synthetic-file-user-token', userId: 123, password: 'synthetic-file-password', baseUrl: `${BASE}/`, timeoutMs: 12000 }));
    const env = { YIMU_TOKEN: 'synthetic-env-token', YIMU_PASSWORD: 'synthetic-env-password', YIMU_USER_ID: '456', ...(selector === 'YIMU_CONFIG' ? { YIMU_CONFIG: file } : {}) };
    const { config, configFile, sources } = success(runConfig(dir, { args: selector === '--config' ? ['--config', file] : [], env }));
    assert.equal(configFile, file);
    assert.equal(config.token, 'synthetic-env-token');
    assert.equal(config.password, 'synthetic-env-password');
    assert.equal(config.userId, '456');
    assert.equal(config.userToken, 'synthetic-file-user-token');
    assert.equal(config.timeoutMs, 12000);
    assert.equal(config.baseUrl, BASE);
    assert.equal(sources.token, 'env');
    assert.equal(sources.userToken, 'file');
  });

  for (const variant of ['relative', 'missing', 'malformed']) {
    test(`${selector} rejects ${variant} explicit config`, (t) => {
      const dir = sandbox(t);
      const file = variant === 'relative' ? 'chosen-config.json' : path.join(dir, 'chosen-config.json');
      if (variant !== 'missing') writeFileSync(path.join(dir, 'chosen-config.json'), variant === 'malformed' ? '{broken JSON' : '{}');
      const result = runConfig(dir, selector === '--config' ? { args: ['--config', file] } : { env: { YIMU_CONFIG: file } });
      failure(result);
    });
  }
}

for (const baseUrl of ['https://attacker.invalid/api', 'http://yimubill.com/api', 'https://user:password@yimubill.com/api', 'https://yimubill.com:444/api', 'https://yimubill.com/api?x=1', 'https://yimubill.com/api#fragment', 'https://yimubill.com/other']) {
  test(`environment base URL is validated at config load: ${baseUrl}`, (t) => {
    failure(runConfig(sandbox(t), { env: { YIMU_BASE_URL: baseUrl } }));
  });
}

test('documented --base-url alias cannot silently ignore an unsafe URL', (t) => {
  failure(runConfig(sandbox(t), { args: ['--base-url', 'https://attacker.invalid/api'] }));
});

test('documented --base-url alias wins over environment and normalizes trailing slash', (t) => {
  const { config, sources } = success(runConfig(sandbox(t), { args: [`--base-url=${BASE}/`], env: { YIMU_BASE_URL: 'https://attacker.invalid/api' } }));
  assert.equal(config.baseUrl, BASE);
  assert.equal(sources.baseUrl, 'arg');
});

test('an explicitly selected config file cannot introduce an unsafe API origin', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'unsafe-origin.json');
  writeFileSync(file, JSON.stringify({ baseUrl: 'https://attacker.invalid/api' }));
  failure(runConfig(dir, { args: ['--config', file] }));
});

for (const [label, options, expected] of [
  ['disabled by default', {}, false],
  ['enabled by an explicit environment value', { env: { YIMU_ENABLE_API_REQUEST: '1' } }, true],
  ['enabled by the startup flag', { args: ['--enable-api-request'] }, true],
  ['explicit false overrides an enabled environment', { args: ['--enable-api-request=false'], env: { YIMU_ENABLE_API_REQUEST: '1' } }, false],
]) {
  test(`general API opt-in is ${label}`, (t) => {
    assert.equal(success(runConfig(sandbox(t), options)).config.enableApiRequest, expected);
  });
}

test('an explicit config file cannot enable the general API escape hatch', (t) => {
  const dir = sandbox(t);
  const file = path.join(dir, 'cannot-opt-in.json');
  writeFileSync(file, JSON.stringify({ userId: 123, enableApiRequest: true }));
  const { config, configFile } = success(runConfig(dir, { args: ['--config', file] }));
  assert.equal(configFile, file);
  assert.equal(config.userId, '123');
  assert.equal(config.enableApiRequest, false);
});
