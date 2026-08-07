import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import {
  AUTHORIZATION_EXCHANGE_TIMEOUT_MS,
  ReauthorizationRequiredError,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
} from '../src/homeconnect/oauth.js';
import {
  OAUTH_STATE_TTL_MS,
  createPendingState,
  matchesPendingState,
  pendingStateConfig,
  readPendingState,
} from '../src/oauth-session.js';

const REDIRECT_URI = 'https://my.gladysassistant.com/redirect/oauth';

/** Capture the calls made to `fetch` and answer them with a canned response. */
function stubFetch(t, respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return respond(calls.length);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('buildAuthorizeUrl carries the client id, the redirect URI, the scopes and the state', () => {
  const config = normalizeConfig({ client_id: 'abc' });
  const url = new URL(buildAuthorizeUrl(config, REDIRECT_URI, 'st4te'));

  assert.equal(url.origin + url.pathname, 'https://api.home-connect.com/security/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), 'IdentifyAppliance Monitor Settings Control');
  assert.equal(url.searchParams.get('state'), 'st4te');
});

test('exchangeCode posts a form body and returns an absolute expiry', async (t) => {
  const calls = stubFetch(t, () =>
    jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 86400 }),
  );
  const config = normalizeConfig({ client_id: 'abc', client_secret: 'sec' });

  const before = Date.now();
  const tokens = await exchangeCode(config, { code: 'c0de', redirectUri: REDIRECT_URI });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.home-connect.com/security/oauth/token');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const body = new URLSearchParams(calls[0].options.body.toString());
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), 'abc');
  assert.equal(body.get('client_secret'), 'sec');
  assert.equal(body.get('redirect_uri'), REDIRECT_URI);
  assert.equal(body.get('code'), 'c0de');

  assert.equal(tokens.access_token, 'at');
  assert.equal(tokens.refresh_token, 'rt');
  assert.ok(tokens.token_expires_at >= before + 86400 * 1000);
});

test('exchangeCode fits in the acknowledgement budget of the Gladys command', async (t) => {
  // Gladys drops the oauth-callback command after 5 s and the browser then
  // reports a refused connection whatever we answer: overrunning is pointless.
  const calls = stubFetch(t, () => jsonResponse(200, { access_token: 'at', expires_in: 100 }));
  const config = normalizeConfig({ client_id: 'abc', client_secret: 'sec' });

  await exchangeCode(config, { code: 'c0de', redirectUri: REDIRECT_URI });

  assert.ok(AUTHORIZATION_EXCHANGE_TIMEOUT_MS < 5000);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.ok(config.request_timeout_ms > AUTHORIZATION_EXCHANGE_TIMEOUT_MS);
});

test('a refused grant asks for a new authorization instead of retrying', async (t) => {
  stubFetch(t, () =>
    jsonResponse(400, { error: 'invalid_grant', error_description: 'Invalid authorization code' }),
  );
  const config = normalizeConfig({ client_id: 'abc', client_secret: 'sec' });

  await assert.rejects(() => exchangeCode(config, { code: 'stale', redirectUri: REDIRECT_URI }), {
    name: 'ReauthorizationRequiredError',
    message: /Invalid authorization code/,
  });
});

test('a refusal without a Client Secret names the missing Client Secret', async (t) => {
  stubFetch(t, () => jsonResponse(400, { error: 'invalid_client' }));
  const config = normalizeConfig({ client_id: 'abc' });

  await assert.rejects(
    () => exchangeCode(config, { code: 'c0de', redirectUri: REDIRECT_URI }),
    (err) => {
      assert.ok(err instanceof ReauthorizationRequiredError);
      assert.match(err.message, /Client Secret/);
      return true;
    },
  );
});

test('a refused authorization code names the redirect URI to register', async (t) => {
  stubFetch(t, () => jsonResponse(400, { error: 'invalid_grant' }));
  const config = normalizeConfig({ client_id: 'abc', client_secret: 'sec' });

  await assert.rejects(() => exchangeCode(config, { code: 'c0de', redirectUri: REDIRECT_URI }), {
    message: new RegExp(REDIRECT_URI.replace(/[/.]/g, '\\$&')),
  });
});

test('refreshTokens keeps the previous refresh token when the provider omits it', async (t) => {
  stubFetch(t, () => jsonResponse(200, { access_token: 'at2', expires_in: 86400 }));
  const config = normalizeConfig({ client_id: 'abc', client_secret: 'sec' });

  const tokens = await refreshTokens(config, 'rt1');

  assert.equal(tokens.access_token, 'at2');
  assert.equal(tokens.refresh_token, 'rt1');
});

test('a pending state survives a round trip through the config', () => {
  const pending = createPendingState(1000);
  const stored = pendingStateConfig(pending);

  assert.deepEqual(readPendingState(stored), pending);
  assert.equal(matchesPendingState(readPendingState(stored), pending.state, 2000), true);
});

test('clearing the pending state leaves nothing to match', () => {
  assert.equal(readPendingState(pendingStateConfig(null)), null);
  assert.equal(readPendingState({}), null);
  assert.equal(matchesPendingState(null, 'anything'), false);
});

test('a state that does not match, is empty or has expired is refused', () => {
  const pending = createPendingState(1000);

  assert.equal(matchesPendingState(pending, 'someone-elses-state', 2000), false);
  assert.equal(matchesPendingState(pending, '', 2000), false);
  assert.equal(matchesPendingState(pending, undefined, 2000), false);
  assert.equal(matchesPendingState(pending, pending.state, 1000 + OAUTH_STATE_TTL_MS + 1), false);
});
