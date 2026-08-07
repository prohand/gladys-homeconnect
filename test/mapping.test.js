import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  DISHWASHER,
  DISHWASHER_ACTIVE_PROGRAM,
  DISHWASHER_SETTINGS,
  DISHWASHER_STATUSES,
  FRIDGE,
  FRIDGE_SETTINGS,
  FRIDGE_STATUSES,
} from './helpers/fixtures.js';
import { GLADYS_POLL_TICK_MS, normalizeConfig } from '../src/config.js';
import { buildDevice, buildFeatureModels, buildStates, toState } from '../src/mapping/appliance.js';
import {
  OPTION_FEATURES,
  PROGRAM_SWITCH_ID,
  SETTING_FEATURES,
  mapUnit,
} from '../src/mapping/catalog.js';
import { OPTIONS, POWER_STATE, SETTINGS } from '../src/homeconnect/constants.js';

const config = normalizeConfig({ language: 'en' });

function dishwasherSnapshot(overrides = {}) {
  return {
    ...DISHWASHER,
    settings: DISHWASHER_SETTINGS,
    statuses: DISHWASHER_STATUSES,
    constraints: {},
    activeProgram: DISHWASHER_ACTIVE_PROGRAM,
    selectedProgram: DISHWASHER_ACTIVE_PROGRAM,
    ...overrides,
  };
}

function fridgeSnapshot(overrides = {}) {
  return {
    ...FRIDGE,
    settings: FRIDGE_SETTINGS,
    statuses: FRIDGE_STATUSES,
    constraints: {},
    activeProgram: null,
    selectedProgram: null,
    ...overrides,
  };
}

test('an appliance only gets the features it actually reports', () => {
  const ids = buildFeatureModels(fridgeSnapshot()).map((model) => model.featureId);

  assert.ok(ids.includes('fridge-setpoint'));
  assert.ok(ids.includes('freezer-setpoint'));
  assert.ok(ids.includes('door-refrigerator'));
  // The fridge reports no PowerState setting, so no power switch is invented.
  assert.equal(ids.includes('power'), false);
  // A fridge runs no program: no program switch, no progress features.
  assert.equal(ids.includes(PROGRAM_SWITCH_ID), false);
  assert.equal(ids.includes('remaining-time'), false);
});

test('an appliance with programs gets the program switch and the core options', () => {
  const ids = buildFeatureModels(dishwasherSnapshot()).map((model) => model.featureId);

  assert.ok(ids.includes(PROGRAM_SWITCH_ID));
  assert.ok(ids.includes('active-program'));
  assert.ok(ids.includes('selected-program'));
  assert.ok(ids.includes('remaining-time'));
  assert.ok(ids.includes('program-progress'));
});

test('the core program options exist even when nothing is running', () => {
  const ids = buildFeatureModels(
    dishwasherSnapshot({ activeProgram: null, selectedProgram: null }),
  ).map((model) => model.featureId);

  assert.ok(ids.includes('remaining-time'));
  assert.ok(ids.includes('program-progress'));
});

test('event features are gated by appliance type', () => {
  const dishwasherIds = buildFeatureModels(dishwasherSnapshot()).map((model) => model.featureId);
  const fridgeIds = buildFeatureModels(fridgeSnapshot()).map((model) => model.featureId);

  assert.ok(dishwasherIds.includes('event-salt-nearly-empty'));
  assert.equal(dishwasherIds.includes('event-bean-container-empty'), false);
  assert.ok(fridgeIds.includes('event-door-alarm-freezer'));
  assert.equal(fridgeIds.includes('event-salt-nearly-empty'), false);
  // Program finished applies to every appliance.
  assert.ok(dishwasherIds.includes('event-program-finished'));
  assert.ok(fridgeIds.includes('event-program-finished'));
});

test('buildDevice produces a Gladys discovery payload with stable external ids', () => {
  const gladys = createFakeGladys();
  const device = buildDevice(gladys, dishwasherSnapshot(), config);

  assert.equal(device.external_id, `ext:home-connect:appliance:${DISHWASHER.haId}`);
  assert.equal(device.name, 'Dishwasher');
  // Gladys validates poll_frequency against its own enum of milliseconds, so
  // the device carries its slowest tick, not the interval configured in seconds.
  assert.equal(device.poll_frequency, GLADYS_POLL_TICK_MS);
  assert.deepEqual(
    device.params.find((param) => param.name === 'haId'),
    { name: 'haId', value: DISHWASHER.haId },
  );

  const power = device.features.find((feature) => feature.external_id.endsWith(':power'));
  assert.equal(power.name, 'Power');
  assert.equal(power.read_only, false);
  assert.equal(power.has_feedback, true);
});

test('feature names follow the configured language', () => {
  const gladys = createFakeGladys();
  const device = buildDevice(gladys, dishwasherSnapshot(), normalizeConfig({ language: 'fr' }));
  const power = device.features.find((feature) => feature.external_id.endsWith(':power'));
  assert.equal(power.name, 'Alimentation');
});

test('appliance constraints refine the bounds of a setpoint', () => {
  const gladys = createFakeGladys();
  const snapshot = fridgeSnapshot({
    constraints: { [SETTINGS.FRIDGE_SETPOINT]: { min: 2, max: 8, unit: '°C' } },
  });
  const device = buildDevice(gladys, snapshot, config);
  const setpoint = device.features.find((feature) =>
    feature.external_id.endsWith(':fridge-setpoint'),
  );

  assert.equal(setpoint.min, 2);
  assert.equal(setpoint.max, 8);
  assert.equal(setpoint.unit, 'celsius');
});

test('buildStates decodes settings, statuses and program options together', () => {
  const gladys = createFakeGladys();
  const snapshot = dishwasherSnapshot();
  const states = buildStates(gladys, snapshot, buildFeatureModels(snapshot));
  const byFeature = new Map(
    states.map((state) => [state.device_feature_external_id.split(':').pop(), state]),
  );

  assert.equal(byFeature.get('power').state, 1);
  assert.equal(byFeature.get('door').state, 0);
  assert.equal(byFeature.get('child-lock').state, 0);
  assert.equal(byFeature.get('remaining-time').state, 1800);
  assert.equal(byFeature.get('program-progress').state, 42);
  assert.equal(byFeature.get('operation-state').text, 'Run');
  assert.equal(byFeature.get('active-program').text, 'Auto2');
  assert.equal(byFeature.get(PROGRAM_SWITCH_ID).state, 1);
  assert.equal(byFeature.get('connected').state, 1);
});

test('buildStates leaves unreported values alone instead of publishing zero', () => {
  const gladys = createFakeGladys();
  const snapshot = dishwasherSnapshot({ statuses: [] });
  const states = buildStates(gladys, snapshot, buildFeatureModels(snapshot));
  const ids = states.map((state) => state.device_feature_external_id.split(':').pop());

  assert.equal(ids.includes('door'), false);
  // Events never come from a snapshot: they only ever arrive on the stream.
  assert.equal(ids.includes('event-program-finished'), false);
});

test('an empty program publishes an empty text, not a stale one', () => {
  const gladys = createFakeGladys();
  const snapshot = dishwasherSnapshot({ activeProgram: null });
  const states = buildStates(gladys, snapshot, buildFeatureModels(snapshot));
  const active = states.find((state) =>
    state.device_feature_external_id.endsWith(':active-program'),
  );

  assert.deepEqual(active.text, '');
});

test('the power encoder honours the off value the appliance allows', () => {
  const entry = SETTING_FEATURES[SETTINGS.POWER_STATE];

  assert.equal(entry.encode(1, {}), POWER_STATE.ON);
  assert.equal(
    entry.encode(0, { constraints: { allowedvalues: [POWER_STATE.ON, POWER_STATE.OFF] } }),
    POWER_STATE.OFF,
  );
  // An oven only ever accepts Standby — and that is also the safe default when
  // the appliance told us nothing.
  assert.equal(
    entry.encode(0, { constraints: { allowedvalues: [POWER_STATE.ON, POWER_STATE.STANDBY] } }),
    POWER_STATE.STANDBY,
  );
  assert.equal(entry.encode(0, {}), POWER_STATE.STANDBY);
});

test('the hood venting level decodes its enum stage into a number', () => {
  const entry = OPTION_FEATURES[OPTIONS.HOOD_VENTING_LEVEL];

  assert.equal(entry.decode('Cooking.Hood.EnumType.Stage.FanStage03'), 3);
  assert.equal(entry.decode('Cooking.Hood.EnumType.Stage.FanOff'), 0);
});

test('mapUnit translates the Home Connect units Gladys knows', () => {
  assert.equal(mapUnit('°C'), 'celsius');
  assert.equal(mapUnit('°F'), 'fahrenheit');
  assert.equal(mapUnit('seconds'), 'seconds');
  assert.equal(mapUnit('rpm'), undefined);
});

test('toState rejects the values a decoder could not make sense of', () => {
  assert.deepEqual(toState(12), { state: 12 });
  assert.deepEqual(toState({ text: 'Run' }), { text: 'Run' });
  assert.equal(toState(undefined), undefined);
  assert.equal(toState(Number.NaN), undefined);
  assert.equal(toState({}), undefined);
});
