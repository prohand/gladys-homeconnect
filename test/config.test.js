import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, hasCredentials, normalizeConfig, readTokens } from '../src/config.js';
import { PRODUCTION_BASE_URL, SIMULATOR_BASE_URL } from '../src/homeconnect/constants.js';

test('normalizeConfig applies the defaults on an empty config', () => {
  const config = normalizeConfig();
  assert.equal(config.poll_frequency, DEFAULT_CONFIG.poll_frequency);
  assert.equal(config.language, 'en');
  assert.equal(config.base_url, PRODUCTION_BASE_URL);
});

test('normalizeConfig forces the types coming from the form', () => {
  const config = normalizeConfig({
    client_id: '  abc  ',
    poll_frequency: '600',
    use_simulator: 'true',
  });
  assert.equal(config.client_id, 'abc');
  assert.equal(config.poll_frequency, 600);
  assert.equal(config.use_simulator, true);
  assert.equal(config.base_url, SIMULATOR_BASE_URL);
});

test('normalizeConfig clamps the polling interval into the manifest bounds', () => {
  assert.equal(normalizeConfig({ poll_frequency: 5 }).poll_frequency, 120);
  assert.equal(normalizeConfig({ poll_frequency: 99999 }).poll_frequency, 3600);
  assert.equal(normalizeConfig({ poll_frequency: 'nonsense' }).poll_frequency, 120);
});

test('normalizeConfig falls back to English on an unknown language', () => {
  assert.equal(normalizeConfig({ language: 'de' }).language, 'en');
  assert.equal(normalizeConfig({ language: 'fr' }).language, 'fr');
});

test('readTokens only keeps a usable token triplet', () => {
  assert.deepEqual(readTokens({ access_token: 42, refresh_token: 'r', token_expires_at: '10' }), {
    access_token: undefined,
    refresh_token: 'r',
    token_expires_at: 10,
  });
});

test('hasCredentials only requires the client id', () => {
  assert.equal(hasCredentials(normalizeConfig({})), false);
  assert.equal(hasCredentials(normalizeConfig({ client_id: 'x' })), true);
});
