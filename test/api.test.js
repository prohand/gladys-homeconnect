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

test('getCommands answers the keys of the commands the appliance lists', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse(200, {
      data: { commands: [{ key: 'BSH.Common.Command.PauseProgram', name: 'Pause' }] },
    });
  t.after(() => {
    globalThis.fetch = original;
  });
  const api = new HomeConnectApi({
    getConfig: () => config,
    getTokens: () => ({ access_token: 'at', refresh_token: 'rt', token_expires_at: Infinity }),
    persistTokens: async () => {},
  });

  assert.deepEqual(await api.getCommands('HA1'), ['BSH.Common.Command.PauseProgram']);
});

/** An appliance whose start refuses some options, answering like Home Connect. */
function stubStart(t, { options, refused, otherError }) {
  const original = globalThis.fetch;
  const starts = [];
  globalThis.fetch = async (url, init) => {
    if (init.method === 'GET') {
      return jsonResponse(200, { data: { key: 'Dishcare.Dishwasher.Program.Eco50', options } });
    }
    const sent = JSON.parse(init.body).data.options;
    starts.push(sent.map((option) => option.key));
    if (otherError) {
      return jsonResponse(409, {
        error: { key: 'SDK.Error.RemoteStartNotActivated', description: otherError },
      });
    }
    const bad = sent.find((option) => refused.includes(option.key));
    if (bad) {
      return jsonResponse(409, {
        error: {
          key: 'SDK.Error.UnsupportedOption',
          description: `Option ${bad.key} not supported`,
        },
      });
    }
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  const api = new HomeConnectApi({
    getConfig: () => config,
    getTokens: () => ({ access_token: 'at', refresh_token: 'rt', token_expires_at: Infinity }),
    persistTokens: async () => {},
  });
  return { api, starts };
}

const SMART_START = 'BSH.Common.Option.SmartEnergyService.SmartStartEnabled';

test('a start refused over an option is retried without that option only', async (t) => {
  const { api, starts } = stubStart(t, {
    options: [
      { key: SMART_START, value: false },
      { key: 'Dishcare.Dishwasher.Option.ExtraDry', value: true },
    ],
    refused: [SMART_START],
  });

  assert.equal(await api.startSelectedProgram('HA1'), 'Dishcare.Dishwasher.Program.Eco50');
  assert.deepEqual(starts, [
    [SMART_START, 'Dishcare.Dishwasher.Option.ExtraDry'],
    ['Dishcare.Dishwasher.Option.ExtraDry'],
  ]);
});

test('a start refused for another reason is not retried', async (t) => {
  const { api, starts } = stubStart(t, {
    options: [{ key: SMART_START, value: false }],
    refused: [],
    otherError: 'Remote start is not enabled',
  });

  await assert.rejects(api.startSelectedProgram('HA1'), /Remote start is not enabled/);
  assert.equal(starts.length, 1);
});

const SILENCE = 'Dishcare.Dishwasher.Option.SilenceOnDemand';
const EXTRA_DRY = 'Dishcare.Dishwasher.Option.ExtraDry';

test('options the appliance only reports are never sent back at start', async (t) => {
  // The dishwasher of the forum report: five refusals in a row used to burn
  // the five starts Home Connect allows per minute, and the sixth got a 429.
  const { api, starts } = stubStart(t, {
    options: [
      { key: SMART_START, value: false },
      { key: 'BSH.Common.Option.EnergyForecast', value: 60 },
      { key: 'BSH.Common.Option.WaterForecast', value: 50 },
      { key: 'BSH.Common.Option.RemainingProgramTimeIsEstimated', value: true },
      { key: SILENCE, value: 0 },
      { key: EXTRA_DRY, value: true },
    ],
    refused: [
      SMART_START,
      'BSH.Common.Option.EnergyForecast',
      'BSH.Common.Option.WaterForecast',
      'BSH.Common.Option.RemainingProgramTimeIsEstimated',
      SILENCE,
    ],
  });

  await api.startSelectedProgram('HA1');
  assert.deepEqual(starts, [[SMART_START, SILENCE, EXTRA_DRY], [SILENCE, EXTRA_DRY], [EXTRA_DRY]]);
});

test('an option refused once is left out of the next starts', async (t) => {
  const { api, starts } = stubStart(t, {
    options: [
      { key: SMART_START, value: false },
      { key: EXTRA_DRY, value: true },
    ],
    refused: [SMART_START],
  });

  await api.startSelectedProgram('HA1');
  starts.length = 0;
  await api.startSelectedProgram('HA1');
  assert.deepEqual(starts, [[EXTRA_DRY]], 'one request, without the refused option');
});

test('a start stops under the Home Connect start limit, the next one goes on', async (t) => {
  const refused = ['A', 'B', 'C', 'D', 'E'].map((letter) => `Dishcare.Dishwasher.Option.${letter}`);
  const { api, starts } = stubStart(t, {
    options: refused.map((key) => ({ key, value: true })),
    refused,
  });

  await assert.rejects(api.startSelectedProgram('HA1'), /try again in a minute/);
  assert.equal(starts.length, 4);

  starts.length = 0;
  await api.startSelectedProgram('HA1');
  assert.deepEqual(starts, [[refused[4]], []]);
});
