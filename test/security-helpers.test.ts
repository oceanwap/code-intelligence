import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import { sanitizeLabel, safeFetch, validateGraphPath, SecurityError, isLocalNetworkAllowed } from '../src/utils/security.js';

async function withTmp(t: TestContext, fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-intel-security-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await fn(dir);
}

test('sanitizeLabel: strips control chars', () => {
  const raw = 'hello\x00\x07\x1b[31mworld\x9f';
  assert.equal(sanitizeLabel(raw), 'helloworld');
});

test('sanitizeLabel: collapses whitespace', () => {
  assert.equal(sanitizeLabel('foo   bar\n\tbaz'), 'foo bar baz');
});

test('sanitizeLabel: caps length at 256', () => {
  const long = 'x'.repeat(500);
  assert.equal(sanitizeLabel(long).length, 256);
});

test('sanitizeLabel: tolerates non-string input', () => {
  assert.equal(sanitizeLabel(null), '');
  assert.equal(sanitizeLabel(undefined), '');
  assert.equal(sanitizeLabel(42), '42');
});

test('safeFetch: refuses file://', async () => {
  await assert.rejects(
    () => safeFetch('file:///etc/passwd'),
    (err: unknown) => err instanceof SecurityError && /file/i.test(err.message)
  );
});

test('safeFetch: refuses ftp://', async () => {
  await assert.rejects(
    () => safeFetch('ftp://example.com/foo'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: refuses localhost (default policy)', async () => {
  await assert.rejects(
    () => safeFetch('http://localhost:3000/'),
    (err: unknown) => err instanceof SecurityError && /loopback|blocked/i.test(err.message)
  );
});

test('safeFetch: refuses 127.0.0.1', async () => {
  await assert.rejects(
    () => safeFetch('http://127.0.0.1:8080/'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: refuses 10.x private range', async () => {
  await assert.rejects(
    () => safeFetch('http://10.0.0.1/'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: refuses 192.168.x private range', async () => {
  await assert.rejects(
    () => safeFetch('http://192.168.1.1/'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: refuses 172.16.x private range', async () => {
  await assert.rejects(
    () => safeFetch('http://172.16.0.5/'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: refuses ::1 (IPv6 loopback)', async () => {
  await assert.rejects(
    () => safeFetch('http://[::1]/'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: refuses fe80::/10', async () => {
  await assert.rejects(
    () => safeFetch('http://[fe80::1]/'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: refuses fc00::/7', async () => {
  await assert.rejects(
    () => safeFetch('http://[fc00::1]/'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: refuses IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)', async () => {
  await assert.rejects(
    () => safeFetch('http://[::ffff:127.0.0.1]/'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: refuses hostname that resolves to a private IP', async () => {
  await assert.rejects(
    () => safeFetch('http://localhost/'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: rejects invalid URL syntax', async () => {
  await assert.rejects(
    () => safeFetch('not a url at all'),
    (err: unknown) => err instanceof SecurityError
  );
});

test('safeFetch: ALLOW_LOCAL_NETWORK=1 still rejects file://', async () => {
  const prev = process.env['ALLOW_LOCAL_NETWORK'];
  process.env['ALLOW_LOCAL_NETWORK'] = '1';
  try {
    await assert.rejects(
      () => safeFetch('file:///etc/passwd'),
      (err: unknown) => err instanceof SecurityError && /protocol/i.test(err.message)
    );
  } finally {
    if (prev === undefined) delete process.env['ALLOW_LOCAL_NETWORK'];
    else process.env['ALLOW_LOCAL_NETWORK'] = prev;
  }
});

test('safeFetch: ALLOW_LOCAL_NETWORK=1 permits localhost resolution', async () => {
  const prev = process.env['ALLOW_LOCAL_NETWORK'];
  process.env['ALLOW_LOCAL_NETWORK'] = '1';
  try {
    assert.ok(isLocalNetworkAllowed());
    try {
      await safeFetch('http://127.0.0.1:1/');
    } catch (err) {
      assert.ok(!(err instanceof SecurityError), `expected non-security error, got: ${(err as Error).message}`);
    }
  } finally {
    if (prev === undefined) delete process.env['ALLOW_LOCAL_NETWORK'];
    else process.env['ALLOW_LOCAL_NETWORK'] = prev;
  }
});

test('validateGraphPath: accepts file inside root', async (t) => {
  await withTmp(t, async (dir) => {
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const file = path.join(sub, 'foo.ts');
    fs.writeFileSync(file, 'export const x = 1;');
    const resolved = validateGraphPath('src/foo.ts', dir);
    assert.equal(resolved, file);
  });
});

test('validateGraphPath: rejects .. traversal', async (t) => {
  await withTmp(t, async (dir) => {
    assert.throws(
      () => validateGraphPath('../etc/passwd', dir),
      (err: unknown) => err instanceof SecurityError && /\.\./.test(err.message)
    );
  });
});

test('validateGraphPath: rejects absolute path outside root', async (t) => {
  await withTmp(t, async (dir) => {
    assert.throws(
      () => validateGraphPath('/etc/passwd', dir),
      (err: unknown) => err instanceof SecurityError && /escapes root/i.test(err.message)
    );
  });
});

test('validateGraphPath: rejects symlink pointing outside root', async (t) => {
  await withTmp(t, async (dir) => {
    const external = path.join(os.tmpdir(), `external-${Date.now()}.ts`);
    fs.writeFileSync(external, 'export const x = 1;');
    const sub = path.join(dir, 'src');
    fs.mkdirSync(sub, { recursive: true });
    const linkPath = path.join(sub, 'foo.ts');
    fs.symlinkSync(external, linkPath);
    t.after(() => fs.rmSync(external, { force: true }));
    assert.throws(
      () => validateGraphPath('src/foo.ts', dir),
      (err: unknown) => err instanceof SecurityError && /symlink|escapes root/i.test(err.message)
    );
  });
});

test('validateGraphPath: accepts non-existent file inside root', async (t) => {
  await withTmp(t, async (dir) => {
    const resolved = validateGraphPath('src/not-yet.ts', dir);
    assert.equal(resolved, path.join(dir, 'src', 'not-yet.ts'));
  });
});