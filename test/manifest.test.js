import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_CONFIG } from '../src/config.js';
import { SCENE_ACTIONS, SCENE_TRIGGERS } from '../src/scenes.js';
import { WIDGETS } from '../src/widgets.js';
import { EVENT_FEATURES } from '../src/mapping/catalog.js';
import { EVENTS } from '../src/homeconnect/constants.js';

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

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // The vocabulary itself is checked by the store validator (unknown keys are
  // dropped with a warning there) — what this test pins is the coupling rule:
  // older cores validate manifests with a strict field allowlist and reject any
  // unknown top-level field, so a manifest declaring `categories` must not
  // claim compatibility below the first release that accepts it.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
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

// --- Gladys 5.1: scene triggers, scene actions, dashboard widgets ------------
//
// A key published in one of those three lists is stored by the scenes and the
// dashboards that use it: renaming one is removing it for every user. So the
// tests below are less about "is the JSON valid" (the store validator does
// that) than about "does the code still answer exactly what the manifest
// promises" — a handler registered under a key the manifest does not declare
// is a card that 404s, and a declared key with no handler is a card that hangs.

test('declaring widgets, scene triggers and scene actions requires Gladys >= 5.1.0', () => {
  // Same coupling rule as `categories`: an older core validates manifests with
  // a strict field allowlist and refuses to install one carrying a field it
  // does not know. The store indexer enforces it, and so does this test.
  assert.ok(manifest.widgets.length >= 1 && manifest.widgets.length <= 5);
  assert.ok(manifest.scene_triggers.length >= 1);
  assert.ok(manifest.scene_actions.length >= 1);
  const [, major, minor] = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/).map(Number);
  assert.ok(
    major > 5 || (major === 5 && minor >= 1),
    `capability fields require gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('the declared keys are the ones the code registers', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((trigger) => trigger.key).sort(),
    Object.values(SCENE_TRIGGERS).sort(),
  );
  assert.deepEqual(
    manifest.scene_actions.map((action) => action.key).sort(),
    Object.values(SCENE_ACTIONS).sort(),
  );
  assert.deepEqual(
    manifest.widgets.map((widget) => widget.key).sort(),
    Object.values(WIDGETS).sort(),
  );
});

test('every scene declaration is labelled in both languages and bounded', () => {
  for (const declaration of [...manifest.scene_triggers, ...manifest.scene_actions]) {
    assert.ok(declaration.label.en && declaration.label.fr, `${declaration.key} is not translated`);
    for (const field of declaration.fields ?? []) {
      assert.ok(field.label.en && field.label.fr, `${declaration.key}.${field.key} has no label`);
    }
    for (const output of [...(declaration.variables ?? []), ...(declaration.outputs ?? [])]) {
      assert.ok(['string', 'number', 'boolean'].includes(output.type), 'scalars only');
    }
  }
  for (const action of manifest.scene_actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
    // Every action acts on one appliance, and a scene cannot guess which:
    // the field is required, so the core never relays an action without it.
    assert.equal(action.fields[0].key, 'appliance');
    assert.equal(action.fields[0].source, 'devices');
    assert.equal(action.fields[0].required, true);
  }
});

test('the notification filter offers exactly the events the catalog can raise', () => {
  // The scene editor renders these as checkboxes and stores the values the user
  // ticks; the bridge answers with the catalog `id` of the event it received.
  // If the two lists drift apart, a scene stops firing without a single error.
  const options = manifest.scene_triggers
    .find((trigger) => trigger.key === SCENE_TRIGGERS.NOTIFICATION)
    .fields.find((field) => field.key === 'notification')
    .options.map((option) => option.value);
  const dedicated = [EVENTS.PROGRAM_FINISHED, EVENTS.PROGRAM_ABORTED];
  const catalog = Object.entries(EVENT_FEATURES)
    .filter(([key]) => !dedicated.includes(key))
    .map(([, entry]) => entry.id);

  assert.deepEqual(options.sort(), catalog.sort());
});

test('a widget setting can live in a dashboard every user of the house can open', () => {
  const allowed = new Set(['string', 'number', 'boolean', 'select', 'multi_select', 'section']);
  for (const widget of manifest.widgets) {
    assert.ok(widget.label.en && widget.label.fr);
    assert.ok(widget.label.en.length >= 3 && widget.label.en.length <= 30);
    for (const setting of widget.settings ?? []) {
      // `secret`, `oauth2` and `account_link` are refused by the core here: a
      // dashboard JSON is readable by every user, admin or not.
      assert.ok(allowed.has(setting.type), `${widget.key}.${setting.key}: ${setting.type}`);
    }
  }
});
