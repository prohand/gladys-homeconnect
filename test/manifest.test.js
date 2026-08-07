import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url)),
);
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

const fieldsByKey = new Map(manifest.config_schema.map((field) => [field.key, field]));

test('the manifest carries the fields the store requires', () => {
  for (const key of [
    'manifest_version',
    'type',
    'name',
    'description',
    'version',
    'docker_image',
    'gladys_version',
  ]) {
    assert.ok(manifest[key], `manifest.${key} is missing`);
  }
  assert.equal(manifest.type, 'device');
  assert.deepEqual(manifest.transports, ['cloud'], 'Home Connect has no local API');
});

test('the manifest version matches package.json and the image tag', () => {
  assert.equal(manifest.version, packageJson.version);
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    'the image tag must follow the manifest version',
  );
});

test('the OAuth2 flow is declared so Gladys renders the Connect button', () => {
  assert.equal(fieldsByKey.get('account')?.type, 'oauth2');
  assert.equal(fieldsByKey.get('client_id')?.type, 'string');
  assert.equal(fieldsByKey.get('client_secret')?.type, 'secret');
});

test('the manifest defaults match the code defaults', () => {
  assert.equal(fieldsByKey.get('poll_frequency').default, DEFAULT_CONFIG.poll_frequency);
  assert.equal(fieldsByKey.get('language').default, DEFAULT_CONFIG.language);
  assert.equal(fieldsByKey.get('scope').default, DEFAULT_CONFIG.scope);
  assert.equal(fieldsByKey.get('use_simulator').default, DEFAULT_CONFIG.use_simulator);
});

test('the polling bounds of the manifest are the ones the code clamps to', () => {
  assert.equal(fieldsByKey.get('poll_frequency').min, 120);
  assert.equal(fieldsByKey.get('poll_frequency').max, 3600);
});

test('every declared action has a handler-friendly key and a timeout', () => {
  const keys = manifest.actions.map((action) => action.key);
  assert.deepEqual(keys, ['test_connection', 'refresh_devices']);
  for (const action of manifest.actions) {
    assert.ok(action.label.en && action.label.fr);
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
  }
});

test('every config field is labelled in both languages', () => {
  for (const field of manifest.config_schema) {
    assert.ok(field.label.en, `${field.key} has no English label`);
    assert.ok(field.label.fr, `${field.key} has no French label`);
  }
});
