// The server-side AI routes are a local-development aid only (lib/ai-guard.mjs).
//
// /api/ai/text, /api/ai/image and /api/ai/echo must answer 403 whenever
// NODE_ENV=production — with no exception — and otherwise to anything that is
// not a genuine loopback client. test/server.test.mjs checks the routes over
// HTTP in development; test/production-guards.test.mjs checks them under a real
// NODE_ENV=production boot. This file pins the decision itself.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AI_FALLBACK_ROUTES, aiServerAllowed, isLoopbackAddress, forwardedForSomeoneElse,
  normalizeRoutePath, isAiFallbackPath,
} from '../lib/ai-guard.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOOPBACK = ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1', '[::1]', '0:0:0:0:0:0:0:1'];
const REMOTE = ['203.0.113.9', '10.0.0.5', '192.168.1.2', '::ffff:203.0.113.9', '2001:db8::1', 'unknown', '', null];

describe('production refuses everything', () => {
  test('every address, loopback included', () => {
    for (const ip of [...LOOPBACK, ...REMOTE]) {
      assert.equal(aiServerAllowed({ nodeEnv: 'production', ip }), false, `production allowed ${ip}`);
    }
  });

  test('whatever the headers claim', () => {
    const spoof = {
      host: 'localhost', origin: 'http://localhost', referer: 'http://127.0.0.1/',
      'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', forwarded: 'for=127.0.0.1',
    };
    assert.equal(aiServerAllowed({ nodeEnv: 'production', ip: '127.0.0.1', headers: spoof }), false);
  });

  test('there is no escape hatch left to open it', () => {
    // AI_SERVER_FALLBACK=1 used to be read BEFORE NODE_ENV. Nothing reads it now.
    // Comment lines (// and the * lines of a JSDoc block) are stripped: they
    // may DESCRIBE process.env; the question is whether code READS it.
    const codeOnly = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const guard = codeOnly(readFileSync(join(ROOT, 'lib', 'ai-guard.mjs'), 'utf8'));
    assert.doesNotMatch(guard, /process\.env/, 'the guard reads the environment itself');
    const server = codeOnly(readFileSync(join(ROOT, 'server.js'), 'utf8'));
    assert.doesNotMatch(server, /AI_SERVER_FALLBACK/, 'server.js still reads AI_SERVER_FALLBACK');
  });
});

describe('development allows a genuine loopback client only', () => {
  for (const nodeEnv of ['development', 'test', undefined]) {
    test(`NODE_ENV=${nodeEnv}`, () => {
      for (const ip of LOOPBACK) assert.equal(aiServerAllowed({ nodeEnv, ip }), true, ip);
      for (const ip of REMOTE) assert.equal(aiServerAllowed({ nodeEnv, ip }), false, `${ip} was allowed`);
    });
  }

  test('a tunnel connecting from loopback on a visitor\'s behalf is refused', () => {
    for (const headers of [
      { 'x-forwarded-for': '203.0.113.9' },
      { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' },
      { forwarded: 'for=203.0.113.9;proto=https' },
      { forwarded: 'for="[2001:db8::1]:443"' },
      { 'x-real-ip': '198.51.100.7' },
      { 'cf-connecting-ip': '198.51.100.7' },
      { 'true-client-ip': '198.51.100.7' },
      { forwarded: 'for=_hidden' },
    ]) {
      assert.equal(aiServerAllowed({ nodeEnv: 'development', ip: '127.0.0.1', headers }), false, JSON.stringify(headers));
    }
  });

  test('a local reverse proxy naming a local client is fine', () => {
    for (const headers of [
      { 'x-forwarded-for': '127.0.0.1' },
      { forwarded: 'for="[::1]:3000"' },
      { forwarded: 'for=127.0.0.1:4711' },
      { host: 'example.com', origin: 'https://example.com' },   // Host and Origin are never consulted
    ]) {
      assert.equal(aiServerAllowed({ nodeEnv: 'development', ip: '127.0.0.1', headers }), true, JSON.stringify(headers));
    }
    assert.equal(forwardedForSomeoneElse({}), false);
  });

  test('isLoopbackAddress is exact', () => {
    for (const ip of LOOPBACK) assert.equal(isLoopbackAddress(ip), true, ip);
    for (const ip of ['128.0.0.1', '127.0.0', '127.0.0.1.5', '::2', 'localhost', '1.127.0.0.1']) {
      assert.equal(isLoopbackAddress(ip), false, ip);
    }
  });
});

describe('every spelling of the three routes is covered', () => {
  test('the three routes', () => {
    assert.deepEqual([...AI_FALLBACK_ROUTES], ['/api/ai/text', '/api/ai/image', '/api/ai/echo']);
  });

  test('spellings that normalise to a fallback route', () => {
    for (const p of [
      '/api/ai/text', '/api/ai/image', '/api/ai/echo',
      '/API/AI/TEXT', '/api/ai/text/', '/api/ai/text//', '//api//ai//text',
      '/api/ai/%74ext', '/api/ai/%2574ext', '/api%2Fai%2Ftext', '/api/ai/text;jsessionid=1',
      '/api\\ai\\text', '/api/ai/image?prompt=x', '/api/ai/echo#x', '/api/ai/text/anything',
    ]) {
      assert.equal(isAiFallbackPath(p), true, `${p} was not recognised`);
    }
  });

  test('routes that are not fallbacks are left alone', () => {
    for (const p of ['/api/ai/health', '/api/ai/providers', '/api/ai/key', '/api/ai/textual',
      '/api/ai', '/api/aitext', '/', '/api/ai/%zz']) {
      assert.equal(isAiFallbackPath(p), false, `${p} was caught`);
    }
    assert.equal(normalizeRoutePath('/API//Ai/Text/'), '/api/ai/text');
  });

  test('server.js refuses them before CORS, the body parser and the rate limiter', () => {
    const server = readFileSync(join(ROOT, 'server.js'), 'utf8');
    const guard = server.indexOf('if (!isAiFallbackPath(req.path)) return next();');
    assert.ok(guard > 0, 'the early guard is missing');
    for (const later of ['app.use(cors(', 'const JSON_PARSER = express.json(', 'app.use(masqrMiddleware(']) {
      const at = server.indexOf(later);
      assert.ok(at > guard, `${later} runs before the AI guard`);
    }
  });
});
