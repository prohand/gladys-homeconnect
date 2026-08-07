import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeGladys, lastStateOf } from './helpers/fakeGladys.js';
import { DISHWASHER, FRIDGE, createFakeApi } from './helpers/fixtures.js';
import { normalizeConfig } from '../src/config.js';
import {
  ApplianceRegistry,
  featureIdFromExternalId,
  haIdFromExternalId,
} from '../src/appliances.js';
import {
  DOOR_STATE,
  OPERATION_STATE,
  POWER_STATE,
  SETTINGS,
  SSE_TYPES,
  STATUSES,
} from '../src/homeconnect/constants.js';

const config = normalizeConfig({ language: 'en' });

async function createRegistry(apiOverrides = {}) {
  const gladys = createFakeGladys();
  const api = createFakeApi(apiOverrides);
  const registry = new ApplianceRegistry({ gladys, api, getConfig: () => config });
  await registry.refresh();
  return { gladys, api, registry };
}

function deviceOf(haId) {
  return { external_id: `ext:home-connect:appliance:${haId}` };
}

function featureOf(haId, featureId) {
  return { external_id: `ext:home-connect:appliance:${haId}:${featureId}` };
}

test('refresh publishes every appliance of the account with its states', async () => {
  const { gladys, registry } = await createRegistry();

  assert.equal(registry.appliances.size, 2);
  const [devices] = gladys.discovered;
  assert.deepEqual(
    devices.map((device) => device.external_id).sort(),
    [
      `ext:home-connect:appliance:${DISHWASHER.haId}`,
      `ext:home-connect:appliance:${FRIDGE.haId}`,
    ].sort(),
  );
  assert.equal(lastStateOf(gladys, 'remaining-time').state, 1800);
  assert.equal(lastStateOf(gladys, 'operation-state').text, 'Run');
});

test('refresh reads the constraints of a setpoint exactly once', async () => {
  const { api, registry } = await createRegistry();

  const constraintCalls = () =>
    api.calls.filter(
      ([method, , key]) => method === 'getSettingDetail' && key === SETTINGS.FRIDGE_SETPOINT,
    ).length;
  assert.equal(constraintCalls(), 1);

  await registry.refresh();
  assert.equal(constraintCalls(), 1, 'constraints never change, so they are not read again');
});

test('a disconnected appliance is published as unreachable and degraded', async () => {
  const { gladys } = await createRegistry({
    async getAppliances() {
      return [{ ...DISHWASHER, connected: false }];
    },
  });

  const badge = gladys.transports.at(-1);
  assert.equal(badge.transport, 'unreachable');
  assert.equal(badge.degraded, true);
});

test('an appliance removed from the account stops being published', async () => {
  let appliances = [DISHWASHER, FRIDGE];
  const { registry } = await createRegistry({
    async getAppliances() {
      return appliances;
    },
  });

  appliances = [DISHWASHER];
  await registry.refresh();

  assert.deepEqual([...registry.appliances.keys()], [DISHWASHER.haId]);
});

test('a STATUS event updates the matching feature', async () => {
  const { gladys, registry } = await createRegistry();

  await registry.handleEvent({
    haId: DISHWASHER.haId,
    type: SSE_TYPES.STATUS,
    key: STATUSES.DOOR_STATE,
    value: DOOR_STATE.OPEN,
  });

  assert.equal(lastStateOf(gladys, 'door').state, 1);
});

test('an operation state event drives both the text and the program switch', async () => {
  const { gladys, registry } = await createRegistry();

  await registry.handleEvent({
    haId: DISHWASHER.haId,
    type: SSE_TYPES.STATUS,
    key: STATUSES.OPERATION_STATE,
    value: OPERATION_STATE.PAUSE,
  });

  assert.equal(lastStateOf(gladys, 'operation-state').text, 'Pause');
  assert.equal(lastStateOf(gladys, 'program').state, 1);
});

test('going back to Ready clears the leftover program options', async () => {
  const { gladys, registry } = await createRegistry();

  await registry.handleEvent({
    haId: DISHWASHER.haId,
    type: SSE_TYPES.STATUS,
    key: STATUSES.OPERATION_STATE,
    value: OPERATION_STATE.READY,
  });

  assert.equal(lastStateOf(gladys, 'program').state, 0);
  assert.equal(lastStateOf(gladys, 'remaining-time').state, 0);
  assert.equal(lastStateOf(gladys, 'program-progress').state, 0);
});

test('an EVENT frame raises then clears its binary feature', async () => {
  const { gladys, registry } = await createRegistry();

  await registry.handleEvent({
    haId: DISHWASHER.haId,
    type: SSE_TYPES.EVENT,
    key: 'Dishcare.Dishwasher.Event.SaltNearlyEmpty',
    value: 'BSH.Common.EnumType.EventPresentState.Present',
  });
  assert.equal(lastStateOf(gladys, 'event-salt-nearly-empty').state, 1);

  await registry.handleEvent({
    haId: DISHWASHER.haId,
    type: SSE_TYPES.EVENT,
    key: 'Dishcare.Dishwasher.Event.SaltNearlyEmpty',
    value: 'BSH.Common.EnumType.EventPresentState.Off',
  });
  assert.equal(lastStateOf(gladys, 'event-salt-nearly-empty').state, 0);
});

test('a DISCONNECTED event flips the connected feature and the transport badge', async () => {
  const { gladys, registry } = await createRegistry();

  await registry.handleEvent({ haId: DISHWASHER.haId, type: SSE_TYPES.DISCONNECTED });

  assert.equal(lastStateOf(gladys, 'connected').state, 0);
  const badge = gladys.transports.findLast(
    (entry) => entry.external_id === `ext:home-connect:appliance:${DISHWASHER.haId}`,
  );
  assert.equal(badge.transport, 'unreachable');
});

test('an event about an unknown appliance is ignored, not thrown', async () => {
  const { registry } = await createRegistry();
  await registry.handleEvent({ haId: 'NOPE-1', type: SSE_TYPES.STATUS, key: STATUSES.DOOR_STATE });
});

test('setValue writes the setting and echoes the value optimistically', async () => {
  const { gladys, api, registry } = await createRegistry();

  await registry.setValue(deviceOf(DISHWASHER.haId), featureOf(DISHWASHER.haId, 'power'), 0);

  assert.deepEqual(
    api.calls.findLast(([method]) => method === 'setSetting'),
    ['setSetting', DISHWASHER.haId, SETTINGS.POWER_STATE, POWER_STATE.OFF, undefined],
  );
  assert.equal(lastStateOf(gladys, 'power').state, 0);
});

test('setValue passes the Home Connect unit along on a setpoint', async () => {
  const { api, registry } = await createRegistry();

  await registry.setValue(deviceOf(FRIDGE.haId), featureOf(FRIDGE.haId, 'fridge-setpoint'), 4);

  assert.deepEqual(
    api.calls.findLast(([method]) => method === 'setSetting'),
    ['setSetting', FRIDGE.haId, SETTINGS.FRIDGE_SETPOINT, 4, '°C'],
  );
});

test('the program switch starts and stops the selected program', async () => {
  const { api, registry } = await createRegistry();

  await registry.setValue(deviceOf(DISHWASHER.haId), featureOf(DISHWASHER.haId, 'program'), 1);
  assert.ok(api.calls.some(([method]) => method === 'startSelectedProgram'));

  await registry.setValue(deviceOf(DISHWASHER.haId), featureOf(DISHWASHER.haId, 'program'), 0);
  assert.ok(api.calls.some(([method]) => method === 'stopProgram'));
});

test('setValue refuses a read-only feature and an offline appliance', async () => {
  const { registry } = await createRegistry();

  await assert.rejects(
    () => registry.setValue(deviceOf(DISHWASHER.haId), featureOf(DISHWASHER.haId, 'door'), 1),
    /read-only/,
  );
  await assert.rejects(
    () => registry.setValue(deviceOf(DISHWASHER.haId), featureOf(DISHWASHER.haId, 'nope'), 1),
    /Unknown Home Connect feature/,
  );

  registry.appliances.get(DISHWASHER.haId).snapshot.connected = false;
  await assert.rejects(
    () => registry.setValue(deviceOf(DISHWASHER.haId), featureOf(DISHWASHER.haId, 'power'), 1),
    /offline/,
  );
});

test('polling one device only reads that appliance', async () => {
  const { api, registry } = await createRegistry();
  api.calls.length = 0;
  registry.lastPollAt.clear();

  await registry.poll(deviceOf(FRIDGE.haId));

  assert.equal(
    api.calls.filter(([method]) => method === 'getAppliances').length,
    0,
    'the whole account is not re-read to poll one device',
  );
  assert.ok(api.calls.some(([method, haId]) => method === 'getAppliance' && haId === FRIDGE.haId));
});

test('polling an appliance we never saw falls back to a full refresh', async () => {
  const { api, registry } = await createRegistry();
  registry.appliances.clear();
  registry.lastPollAt.clear();
  api.calls.length = 0;

  await registry.poll(deviceOf(FRIDGE.haId));

  assert.ok(api.calls.some(([method]) => method === 'getAppliances'));
  assert.equal(registry.appliances.size, 2);
});

test('polling honours the configured interval instead of the Gladys tick', async () => {
  // Gladys only accepts its own poll frequency enum (one minute at the
  // slowest), so the configured interval is enforced here — otherwise every
  // appliance would be read once a minute and burn the Home Connect quota.
  const { api, registry } = await createRegistry();
  api.calls.length = 0;

  // The discovery read that just happened counts: the next tick is too early.
  await registry.poll(deviceOf(FRIDGE.haId));
  assert.equal(
    api.calls.filter(([method]) => method === 'getAppliance').length,
    0,
    'a tick inside the configured interval must not call Home Connect',
  );

  registry.lastPollAt.set(FRIDGE.haId, Date.now() - config.poll_frequency * 1000);
  await registry.poll(deviceOf(FRIDGE.haId));
  assert.equal(
    api.calls.filter(([method, haId]) => method === 'getAppliance' && haId === FRIDGE.haId).length,
    1,
    'once the interval has elapsed the appliance is read again',
  );
});

test('creating the device republishes every value of the appliance', async () => {
  // The states sent while reading the account landed nowhere: the device did
  // not exist in Gladys yet. This is what fills a first-login device in.
  const { gladys, api, registry } = await createRegistry();
  gladys.published.length = 0;
  api.calls.length = 0;

  await registry.handleDeviceCreated(deviceOf(DISHWASHER.haId));

  assert.equal(lastStateOf(gladys, 'remaining-time').state, 1800);
  assert.equal(lastStateOf(gladys, 'operation-state').text, 'Run');
  assert.equal(lastStateOf(gladys, 'power').state, 1);
  assert.equal(api.calls.length, 0, 'the snapshot is enough, no Home Connect call is needed');
});

test('creating a device for an appliance we never read pulls the account first', async () => {
  const { gladys, api, registry } = await createRegistry();
  registry.appliances.clear();
  gladys.published.length = 0;
  api.calls.length = 0;

  await registry.handleDeviceCreated(deviceOf(FRIDGE.haId));

  assert.ok(api.calls.some(([method]) => method === 'getAppliances'));
  assert.equal(lastStateOf(gladys, 'fridge-setpoint').state, 6);
});

test('a tick inside the interval still fills a device created since the last read', async () => {
  const { gladys, api, registry } = await createRegistry();
  gladys.published.length = 0;
  api.calls.length = 0;

  // The discovery read just happened, so no Home Connect call is due — but the
  // device the user created in the meantime has to get its values.
  await registry.poll(deviceOf(FRIDGE.haId));

  assert.equal(api.calls.length, 0, 'a tick inside the interval must not call Home Connect');
  assert.equal(lastStateOf(gladys, 'fridge-setpoint').state, 6);
});

test('unchanged values are not republished tick after tick', async () => {
  const { gladys, registry } = await createRegistry();
  await registry.poll(deviceOf(FRIDGE.haId));
  gladys.published.length = 0;

  await registry.poll(deviceOf(FRIDGE.haId));
  assert.equal(gladys.published.length, 0, 'nothing changed, nothing is published');

  registry.appliances.get(FRIDGE.haId).snapshot.settings[0].value = 4;
  await registry.poll(deviceOf(FRIDGE.haId));
  assert.equal(lastStateOf(gladys, 'fridge-setpoint').state, 4, 'a change is published');
});

test('deleting the device makes a later recreation publish everything again', async () => {
  const { gladys, registry } = await createRegistry();
  await registry.poll(deviceOf(FRIDGE.haId));

  registry.handleDeviceDeleted(deviceOf(FRIDGE.haId));
  gladys.published.length = 0;
  await registry.handleDeviceCreated(deviceOf(FRIDGE.haId));

  assert.equal(lastStateOf(gladys, 'fridge-setpoint').state, 6);
});

test('polling an appliance gone from the account does not re-read it every tick', async () => {
  let appliances = [DISHWASHER, FRIDGE];
  const accountCalls = [];
  const { api, registry } = await createRegistry({
    async getAppliances() {
      accountCalls.push(['getAppliances']);
      return appliances;
    },
  });

  appliances = [DISHWASHER];
  await registry.refresh();
  accountCalls.length = 0;
  api.calls.length = 0;

  // The device the user created survives the appliance leaving the account, and
  // Gladys keeps polling it: the fallback refresh must stay on the interval.
  await registry.poll(deviceOf(FRIDGE.haId));
  assert.equal(accountCalls.length, 1, 'the first tick falls back to a full account read');

  await registry.poll(deviceOf(FRIDGE.haId));
  assert.equal(
    accountCalls.length,
    1,
    'the second tick is inside the interval and must not re-read the account',
  );
});

test('a stream reconnection re-reads the account only once the values are stale', async () => {
  const { api, registry } = await createRegistry();
  api.calls.length = 0;

  // The daily clean cycle of the stream reconnects right away: nothing to re-read.
  await registry.refreshAfterStreamGap();
  assert.equal(api.calls.filter(([method]) => method === 'getAppliances').length, 0);

  for (const haId of registry.appliances.keys()) {
    registry.lastPollAt.set(haId, Date.now() - config.poll_frequency * 1000);
  }
  await registry.refreshAfterStreamGap();
  assert.equal(
    api.calls.filter(([method]) => method === 'getAppliances').length,
    1,
    'a real gap re-reads the account',
  );
});

test('external ids round-trip back to the haId and the feature suffix', () => {
  const device = `ext:home-connect:appliance:${DISHWASHER.haId}`;
  assert.equal(haIdFromExternalId(device), DISHWASHER.haId);
  assert.equal(featureIdFromExternalId(device, `${device}:fridge-setpoint`), 'fridge-setpoint');
});
