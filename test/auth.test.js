import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'unused-in-these-tests';
process.env.PROXY_API_KEY = process.env.PROXY_API_KEY || 'unused-in-these-tests';

const { resolveApiKey } = await import('../src/middleware/auth.js');

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

// Every test passes its own explicit cfg (4th arg) instead of relying on
// the module-level config singleton, so the three modes described in
// middleware/auth.js can each be exercised in isolation.

test('pure BYOK: no server keys configured, client key is forwarded as-is', () => {
  const cfg = { geminiApiKey: undefined, proxyApiKey: undefined };
  const req = { headers: { authorization: 'Bearer my-own-gemini-key' }, query: {} };
  const res = mockRes();
  let nextCalled = false;

  resolveApiKey(req, res, () => {
    nextCalled = true;
  }, cfg);

  assert.equal(nextCalled, true);
  assert.equal(req.geminiApiKey, 'my-own-gemini-key');
});

test('rejects requests with no key at all and no server fallback', () => {
  const cfg = { geminiApiKey: undefined, proxyApiKey: undefined };
  const req = { headers: {}, query: {} };
  const res = mockRes();
  let nextCalled = false;

  resolveApiKey(req, res, () => {
    nextCalled = true;
  }, cfg);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('password mode: PROXY_API_KEY in the request substitutes the real GEMINI_API_KEY', () => {
  const cfg = { geminiApiKey: 'real-gemini-key', proxyApiKey: 'my-chosen-password' };
  const req = { headers: { 'x-proxy-key': 'my-chosen-password' }, query: {} };
  const res = mockRes();
  let nextCalled = false;

  resolveApiKey(req, res, () => {
    nextCalled = true;
  }, cfg);

  assert.equal(nextCalled, true);
  assert.equal(req.geminiApiKey, 'real-gemini-key');
});

test('a client key that does not match PROXY_API_KEY is used as-is (still BYOK, not rejected)', () => {
  const cfg = { geminiApiKey: 'real-gemini-key', proxyApiKey: 'my-chosen-password' };
  const req = { headers: { authorization: 'Bearer some-other-key' }, query: {} };
  const res = mockRes();
  let nextCalled = false;

  resolveApiKey(req, res, () => {
    nextCalled = true;
  }, cfg);

  assert.equal(nextCalled, true);
  assert.equal(req.geminiApiKey, 'some-other-key');
});

test('server fallback: GEMINI_API_KEY used when the client sends no key', () => {
  const cfg = { geminiApiKey: 'fallback-key', proxyApiKey: undefined };
  const req = { headers: {}, query: {} };
  const res = mockRes();
  let nextCalled = false;

  resolveApiKey(req, res, () => {
    nextCalled = true;
  }, cfg);

  assert.equal(nextCalled, true);
  assert.equal(req.geminiApiKey, 'fallback-key');
});

test("accepts a key via ?key= query param (Janitor's native Google AI Studio preset)", () => {
  const cfg = { geminiApiKey: undefined, proxyApiKey: undefined };
  const req = { headers: {}, query: { key: 'query-string-key' } };
  const res = mockRes();
  let nextCalled = false;

  resolveApiKey(req, res, () => {
    nextCalled = true;
  }, cfg);

  assert.equal(nextCalled, true);
  assert.equal(req.geminiApiKey, 'query-string-key');
});

test('accepts a key via x-goog-api-key header', () => {
  const cfg = { geminiApiKey: undefined, proxyApiKey: undefined };
  const req = { headers: { 'x-goog-api-key': 'goog-header-key' }, query: {} };
  const res = mockRes();
  let nextCalled = false;

  resolveApiKey(req, res, () => {
    nextCalled = true;
  }, cfg);

  assert.equal(nextCalled, true);
  assert.equal(req.geminiApiKey, 'goog-header-key');
});

test('PROXY_API_KEY set but GEMINI_API_KEY missing on the server is a config error, not a pass-through', () => {
  const cfg = { geminiApiKey: undefined, proxyApiKey: 'my-chosen-password' };
  const req = { headers: { 'x-proxy-key': 'my-chosen-password' }, query: {} };
  const res = mockRes();
  let nextCalled = false;

  resolveApiKey(req, res, () => {
    nextCalled = true;
  }, cfg);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 500);
});
