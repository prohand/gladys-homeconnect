import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeGladys, invoke } from './helpers/fakeGladys.js';
import { DISHWASHER, FRIDGE, createFakeApi } from './helpers/fixtures.js';
import { normalizeConfig } from '../src/config.js';
import { ApplianceRegistry } from '../src/appliances.js';
import { SCENE_ACTIONS, SCENE_TRIGGERS, SceneBridge } from '../src/scenes.js';
import {
  COMMANDS,
  EVENTS,
  EVENT_PRESENT_STATE,
  OPERATION_STATE,
  SSE_TYPES,
  STATUSES,
} from '../src/homeconnect/constants.js';

const config = normalizeConfig({ language: 'en' });
const DISHWASHER_DEVICE = `ext:home-connect:appliance:${DISHWASHER.haId}`;

async function createBridge(apiOverrides = {}) {
  const gladys = createFakeGladys();
  const api = createFakeApi(apiOverrides);
  let scenes;
  const registry = new ApplianceRegistry({
    gladys,
    api,
    getConfig: () => config,
    onApplianceEvent: (event, snapshot) => scenes.handleApplianceEvent(event, snapshot),
  });
  scenes = new SceneBridge({ gladys, api, registry, getConfig: () => config });
  scenes.register();
  await registry.refresh();
  return { gladys, api, registry, scenes };
}

/** One event as the Home Connect stream delivers it. */
function event(haId, key, value, type = SSE_TYPES.NOTIFY) {
  return { haId, key, value, type };
}

// --- Triggers ----------------------------------------------------------------

test('a program that finishes fires the program_finished trigger with its name', async () => {
  const { gladys, registry } = await createBridge();

  await registry.handleEvent(
    event(DISHWASHER.haId, EVENTS.PROGRAM_FINISHED, EVENT_PRESENT_STATE.PRESENT, SSE_TYPES.EVENT),
  );

  assert.deepEqual(gladys.sceneEvents, [
    {
      key: SCENE_TRIGGERS.PROGRAM_FINISHED,
      data: {
        appliance: DISHWASHER_DEVICE,
        appliance_name: DISHWASHER.name,
        appliance_type: 'Dishwasher',
        program: 'Auto2',
        program_key: 'Dishcare.Dishwasher.Program.Auto2',
      },
    },
  ]);
});

test('an alert going away fires nothing: only the raising edge is an event', async () => {
  const { gladys, registry } = await createBridge();

  await registry.handleEvent(
    event(DISHWASHER.haId, EVENTS.SALT_NEARLY_EMPTY, EVENT_PRESENT_STATE.PRESENT, SSE_TYPES.EVENT),
  );
  await registry.handleEvent(
    event(DISHWASHER.haId, EVENTS.SALT_NEARLY_EMPTY, EVENT_PRESENT_STATE.OFF, SSE_TYPES.EVENT),
  );

  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.sceneEvents[0].key, SCENE_TRIGGERS.NOTIFICATION);
  assert.equal(gladys.sceneEvents[0].data.notification, 'event-salt-nearly-empty');
  assert.equal(gladys.sceneEvents[0].data.notification_name, 'Salt nearly empty');
});

test('a program start is a transition, not the operation state being restated', async () => {
  const { gladys, registry } = await createBridge();

  // The fixture dishwasher is already running: restating Run changes nothing.
  await registry.handleEvent(event(DISHWASHER.haId, STATUSES.OPERATION_STATE, OPERATION_STATE.RUN));
  assert.deepEqual(gladys.sceneEvents, []);

  // Back to idle, then running again: THAT is a start.
  await registry.handleEvent(
    event(DISHWASHER.haId, STATUSES.OPERATION_STATE, OPERATION_STATE.READY),
  );
  await registry.handleEvent(event(DISHWASHER.haId, STATUSES.OPERATION_STATE, OPERATION_STATE.RUN));

  assert.equal(gladys.sceneEvents.length, 1);
  assert.equal(gladys.sceneEvents[0].key, SCENE_TRIGGERS.PROGRAM_STARTED);
  assert.equal(gladys.sceneEvents[0].data.appliance, DISHWASHER_DEVICE);
});

test('a trigger that cannot be published never breaks the state publishing', async () => {
  const { gladys, registry } = await createBridge();
  gladys.publishSceneEvent = async () => {
    throw new Error('host API is down');
  };

  await registry.handleEvent(
    event(DISHWASHER.haId, EVENTS.PROGRAM_FINISHED, EVENT_PRESENT_STATE.PRESENT, SSE_TYPES.EVENT),
  );

  const published = gladys.published.filter((entry) =>
    entry.featureExternalId.endsWith(':event-program-finished'),
  );
  assert.equal(published[published.length - 1].state, 1);
});

// --- Actions -----------------------------------------------------------------

test('start_program runs the selected program and names it back to the scene', async () => {
  const { gladys, api } = await createBridge({
    async startSelectedProgram(haId) {
      api.calls.push(['startSelectedProgram', haId]);
      return 'Dishcare.Dishwasher.Program.Auto2';
    },
  });

  const outputs = await invoke(gladys, `sceneAction:${SCENE_ACTIONS.START}`, {
    appliance: DISHWASHER_DEVICE,
  });

  assert.deepEqual(outputs, {
    program: 'Auto2',
    program_key: 'Dishcare.Dishwasher.Program.Auto2',
  });
});

test('pause and resume go through the Home Connect commands endpoint', async () => {
  const commands = [];
  const { gladys } = await createBridge({
    async putCommand(haId, key) {
      commands.push([haId, key]);
    },
  });

  await invoke(gladys, `sceneAction:${SCENE_ACTIONS.PAUSE}`, { appliance: DISHWASHER_DEVICE });
  await invoke(gladys, `sceneAction:${SCENE_ACTIONS.RESUME}`, { appliance: DISHWASHER_DEVICE });

  assert.deepEqual(commands, [
    [DISHWASHER.haId, COMMANDS.PAUSE_PROGRAM],
    [DISHWASHER.haId, COMMANDS.RESUME_PROGRAM],
  ]);
});

test('an action on an unknown appliance fails with a message, and only that action', async () => {
  const { gladys } = await createBridge();

  await assert.rejects(
    () => invoke(gladys, `sceneAction:${SCENE_ACTIONS.STOP}`, { appliance: 'ext:other:device:1' }),
    /Unknown Home Connect appliance/,
  );
});

test('an action on an offline appliance says so instead of timing out on the cloud', async () => {
  const { gladys, registry } = await createBridge();
  registry.appliances.get(FRIDGE.haId).snapshot.connected = false;

  await assert.rejects(
    () =>
      invoke(gladys, `sceneAction:${SCENE_ACTIONS.STOP}`, {
        appliance: `ext:home-connect:appliance:${FRIDGE.haId}`,
      }),
    /offline in Home Connect/,
  );
});

test('appliance_status answers from the snapshot, without a Home Connect call', async () => {
  const { gladys, api } = await createBridge();
  const before = api.calls.length;

  const outputs = await invoke(gladys, `sceneAction:${SCENE_ACTIONS.STATUS}`, {
    appliance: DISHWASHER_DEVICE,
  });

  assert.equal(api.calls.length, before, 'reading a status must not cost quota');
  assert.equal(outputs.state, 'Run');
  assert.equal(outputs.state_label, 'Running');
  assert.equal(outputs.program, 'Auto2');
  assert.equal(outputs.running, true);
  assert.equal(outputs.remaining_seconds, 1800);
  assert.equal(outputs.remaining_label, '30 min');
  assert.equal(outputs.progress, 42);
  assert.equal(outputs.door, 'Closed');
  assert.equal(outputs.connected, true);
  assert.equal(outputs.summary, 'Dishwasher: Running · Auto2 · 30 min');
});

test('every output an action resolves is declared in the manifest', async () => {
  const { gladys } = await createBridge();
  const manifest = JSON.parse(
    await (
      await import('node:fs/promises')
    ).readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
  );
  const declared = new Set(
    manifest.scene_actions
      .find((action) => action.key === SCENE_ACTIONS.STATUS)
      .outputs.map((output) => output.key),
  );

  const outputs = await invoke(gladys, `sceneAction:${SCENE_ACTIONS.STATUS}`, {
    appliance: DISHWASHER_DEVICE,
  });

  for (const key of Object.keys(outputs)) {
    assert.ok(declared.has(key), `${key} is resolved but not declared, the core would drop it`);
  }
});
