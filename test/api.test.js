import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import { HomeConnectApi } from '../src/homeconnect/api.js';
import { OAUTH_TOKEN_PATH } from '../src/homeconnect/constants.js';

const config = normalizeConfig({ client_id: 'abc', client_secret: 'sec', language: 'en' });

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Home Connect: a token endpoint that rotates the pair, and an empty account. */
function stubHomeConnect(t) {
  const original = globalThis.fetch;
  let rotation = 0;
  globalThis.fetch = async (url) => {
    if (new URL(url).pathname === OAUTH_TOKEN_PATH) {
      rotation += 1;
      return jsonResponse(200, {
        access_token: `at${rotation}`,
        refresh_token: `rt${rotation}`,
        expires_in: 86400,
      });
    }
    return jsonResponse(200, { data: { homeappliances: [] } });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
}

/**
 * The API wired the way index.js wires it: the in-memory copy is updated
 * first, then written to Gladys — and that write fails `failures` times.
 */
function createApi(failures) {
  const state = {
    tokens: { access_token: 'at0', refresh_token: 'rt0', token_expires_at: 0 },
    writes: [],
  };
  const api = new HomeConnectApi({
    getConfig: () => config,
    getTokens: () => state.tokens,
    persistTokens: async (tokens) => {
      state.tokens = { ...state.tokens, ...tokens };
      state.writes.push(tokens.refresh_token);
      if (state.writes.length <= failures) {
        throw new Error('Gladys did not answer');
      }
    },
  });
  return { api, state };
}

test('a token pair Gladys fails to store does not fail the request', async (t) => {
  stubHomeConnect(t);
  const { api, state } = createApi(1);

  // The access token is expired: the call refreshes it, the write fails.
  assert.deepEqual(await api.getAppliances(), []);
  assert.equal(state.tokens.access_token, 'at1', 'the new token is kept in memory');

  // The next request uses it without refreshing again (which would rotate the
  // refresh token a second time), and stores the pair once the delay is over.
  api.persistRetryAt = 0;
  await api.getAppliances();
  assert.deepEqual(state.writes, ['rt1', 'rt1']);
  assert.equal(api.unpersistedTokens, null);

  // Stored now: later requests write nothing more.
  await api.getAppliances();
  assert.equal(state.writes.length, 2);
});

test('the failed write is not retried on every request', async (t) => {
  stubHomeConnect(t);
  const { api, state } = createApi(Infinity);

  await api.getAppliances();
  await api.getAppliances();
  await api.getAppliances();

  assert.equal(state.writes.length, 1, 'retries wait for the retry delay');
});

test('an older unstored pair is never written over a newer one', async (t) => {
  stubHomeConnect(t);
  const { api, state } = createApi(1);

  await api.getAppliances();
  // The user linked the account again meanwhile: another pair is in use.
  state.tokens = { access_token: 'new', refresh_token: 'new-rt', token_expires_at: Infinity };
  api.persistRetryAt = 0;
  await api.getAppliances();

  assert.deepEqual(state.writes, ['rt1']);
  assert.equal(api.unpersistedTokens, null);
});
