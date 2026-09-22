import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createFakeGladys, invoke } from './helpers/fakeGladys.js';
import { DISHWASHER, FRIDGE, createFakeApi } from './helpers/fixtures.js';
import { normalizeConfig } from '../src/config.js';
import { ApplianceRegistry } from '../src/appliances.js';
import { WIDGETS, WidgetBridge } from '../src/widgets.js';
import { OPERATION_STATE, STATUSES } from '../src/homeconnect/constants.js';

const config = normalizeConfig({ language: 'fr' });
const DISHWASHER_DEVICE = `ext:home-connect:appliance:${DISHWASHER.haId}`;
const FRIDGE_DEVICE = `ext:home-connect:appliance:${FRIDGE.haId}`;

async function createWidgets(apiOverrides = {}) {
  const gladys = createFakeGladys();
  const api = createFakeApi(apiOverrides);
  const registry = new ApplianceRegistry({
    gladys,
    api,
    getConfig: () => config,
    onApplianceChanged: () => widgets.nudge(),
  });
  const widgets = new WidgetBridge({ gladys, registry, api });
  widgets.register();
  await registry.refresh();
  return { gladys, api, registry, widgets };
}

/**
 * The same wiring, with the account NEVER read: a container that restarted
 * while Home Connect was unreachable, or whose first read hit the daily quota.
 */
function createColdWidgets({ api: apiOverrides = {}, config: widgetConfig = config } = {}) {
  const gladys = createFakeGladys();
  const api = createFakeApi(apiOverrides);
  const registry = new ApplianceRegistry({ gladys, api, getConfig: () => config });
  const widgets = new WidgetBridge({ gladys, registry, api, getConfig: () => widgetConfig });
  widgets.register();
  return { gladys, api, registry, widgets };
}

/**
 * Every content this integration produces must be renderable EXACTLY as sent:
 * the Gladys core silently trims what does not fit its budget, so a widget
 * that ships is a widget the SDK validator accepts with zero findings.
 */
function assertRenderable(content) {
  assert.deepEqual(validateWidgetContent(content), []);
}

test('the overview lists every appliance with what it is doing', async () => {
  const { gladys } = await createWidgets();

  const content = await invoke(gladys, `widget:${WIDGETS.OVERVIEW}`, {
    settings: {},
    language: 'fr',
    units: 'metric',
  });

  assertRenderable(content);
  const status = content.components.find((component) => component.type === 'status');
  assert.equal(status.items.length, 2);
  // The running appliance comes first: a card is read from across the kitchen.
  assert.equal(status.items[0].label, DISHWASHER.name);
  assert.equal(status.items[0].value, 'En marche · Auto2 · 30 min');
  assert.equal(status.items[0].color, 'primary');
  const running = content.components.find((component) => component.type === 'value');
  assert.equal(running.value, 1);
});

test('the overview honours the appliances chosen in the widget settings', async () => {
  const { gladys } = await createWidgets();

  const content = await invoke(gladys, `widget:${WIDGETS.OVERVIEW}`, {
    settings: { appliances: [FRIDGE_DEVICE] },
    language: 'en',
    units: 'metric',
  });

  assertRenderable(content);
  const status = content.components.find((component) => component.type === 'status');
  assert.deepEqual(
    status.items.map((item) => item.label),
    [FRIDGE.name],
  );
});

test('an empty account renders an empty state, not an empty card', async () => {
  const { gladys, registry } = await createWidgets();
  registry.appliances.clear();

  const content = await invoke(gladys, `widget:${WIDGETS.OVERVIEW}`, {
    settings: {},
    language: 'fr',
    units: 'metric',
  });

  assertRenderable(content);
  assert.equal(content.components[0].type, 'text');
});

test('the appliance card binds the moving numbers to their live features', async () => {
  const { gladys } = await createWidgets();

  const content = await invoke(gladys, `widget:${WIDGETS.APPLIANCE}`, {
    settings: { appliance: DISHWASHER_DEVICE },
    language: 'fr',
    units: 'metric',
  });

  assertRenderable(content);
  const tile = content.components.find((component) => component.type === 'value');
  assert.equal(tile.device_feature, `${DISHWASHER_DEVICE}:remaining-time`);
  const gauge = content.components.find((component) => component.type === 'gauge');
  assert.equal(gauge.device_feature, `${DISHWASHER_DEVICE}:program-progress`);
  const status = content.components.find((component) => component.type === 'status');
  assert.deepEqual(
    status.items.map((item) => item.value),
    ['En marche', 'Auto2', 'Fermée'],
  );
});

test('a running appliance is offered pause and stop, an idle one start', async () => {
  const { gladys, registry } = await createWidgets();
  const buttonKeys = async () => {
    const content = await invoke(gladys, `widget:${WIDGETS.APPLIANCE}`, {
      settings: { appliance: DISHWASHER_DEVICE },
      language: 'en',
      units: 'metric',
    });
    assertRenderable(content);
    return content.components
      .filter((component) => component.type === 'button')
      .map((component) => component.action.key);
  };

  assert.deepEqual(await buttonKeys(), ['pause', 'stop']);

  await registry.handleEvent({
    haId: DISHWASHER.haId,
    type: 'NOTIFY',
    key: STATUSES.OPERATION_STATE,
    value: OPERATION_STATE.READY,
  });
  assert.deepEqual(await buttonKeys(), ['start']);
});

test('the controls can be turned off in the widget settings', async () => {
  const { gladys } = await createWidgets();

  const content = await invoke(gladys, `widget:${WIDGETS.APPLIANCE}`, {
    settings: { appliance: DISHWASHER_DEVICE, controls: false },
    language: 'en',
    units: 'metric',
  });

  assertRenderable(content);
  assert.equal(content.components.filter((component) => component.type === 'button').length, 0);
});

test('an offline appliance reads offline and offers no button to be refused', async () => {
  const { gladys, registry } = await createWidgets();
  registry.appliances.get(DISHWASHER.haId).snapshot.connected = false;

  const content = await invoke(gladys, `widget:${WIDGETS.APPLIANCE}`, {
    settings: { appliance: DISHWASHER_DEVICE },
    language: 'en',
    units: 'metric',
  });

  assertRenderable(content);
  const status = content.components.find((component) => component.type === 'status');
  assert.equal(status.items[0].value, 'Offline');
  assert.equal(status.items[0].color, 'warning');
  assert.equal(
    content.components.some((component) => component.type === 'button'),
    false,
  );
});

test('a widget pointing at a deleted appliance says so instead of rendering a lie', async () => {
  const { gladys } = await createWidgets();

  await assert.rejects(
    () =>
      invoke(gladys, `widget:${WIDGETS.APPLIANCE}`, {
        settings: { appliance: 'ext:home-connect:appliance:GONE' },
        language: 'en',
        units: 'metric',
      }),
    /no longer exists/,
  );
});

test('a button tap acts on the appliance of the SETTINGS, never on the tap payload', async () => {
  const started = [];
  const { gladys } = await createWidgets({
    async startSelectedProgram(haId) {
      started.push(haId);
      return 'Dishcare.Dishwasher.Program.Auto2';
    },
  });

  const toast = await invoke(
    gladys,
    `widgetAction:${WIDGETS.APPLIANCE}`,
    'start',
    { appliance: FRIDGE_DEVICE },
    { settings: { appliance: DISHWASHER_DEVICE } },
  );

  assert.deepEqual(started, [DISHWASHER.haId]);
  assert.equal(toast.fr, 'Programme lancé');
});

test('an unknown button action is refused rather than silently ignored', async () => {
  const { gladys } = await createWidgets();

  await assert.rejects(
    () =>
      invoke(
        gladys,
        `widgetAction:${WIDGETS.APPLIANCE}`,
        'self_destruct',
        {},
        {
          settings: { appliance: DISHWASHER_DEVICE },
        },
      ),
    /Unknown widget action/,
  );
});

test('publishing states nudges the widgets instead of waiting for the TTL', async () => {
  const { gladys, widgets, registry } = await createWidgets();
  gladys.widgetRefreshes.length = 0;
  // The account read of the setup just nudged; a change landing inside the
  // throttle window is deferred, never dropped.
  widgets.lastNudgeAt = 0;

  await registry.handleEvent({
    haId: DISHWASHER.haId,
    type: 'NOTIFY',
    key: STATUSES.OPERATION_STATE,
    value: OPERATION_STATE.FINISHED,
  });

  assert.deepEqual([...new Set(gladys.widgetRefreshes)].sort(), ['appliance', 'appliances']);
});

test('a burst of state batches collapses into one deferred nudge', async () => {
  const { gladys, widgets } = await createWidgets();
  gladys.widgetRefreshes.length = 0;

  // Inside the window opened by the account read of the setup.
  const armed = [];
  widgets.nudge();
  armed.push(widgets.pendingNudge);
  widgets.nudge();
  widgets.nudge();
  armed.push(widgets.pendingNudge);

  assert.deepEqual(gladys.widgetRefreshes, [], 'the burst stays off the socket');
  assert.equal(armed[0], armed[1], 'three nudges arm one trailing edge, not three');

  widgets.sendNudge();
  assert.deepEqual([...new Set(gladys.widgetRefreshes)].sort(), ['appliance', 'appliances']);
  clearTimeout(widgets.pendingNudge);
});

test('a card pulled before the account was read says so and reads it', async () => {
  const { gladys, api, registry, widgets } = createColdWidgets({
    config: normalizeConfig({ language: 'fr', client_id: 'id', client_secret: 'secret' }),
  });

  const content = await invoke(gladys, `widget:${WIDGETS.OVERVIEW}`, {
    settings: {},
    language: 'fr',
    units: 'metric',
  });

  assertRenderable(content);
  assert.match(content.components[0].text.fr, /Lecture de vos appareils/);
  // Short TTL: the card must come back on its own once the read lands.
  assert.ok(content.ttl_seconds <= 15);

  await widgets.reloading;
  assert.equal(registry.appliances.size, 2);
  assert.ok(api.calls.some(([name]) => name === 'getAppliances'));
});

test('the appliance card waits for the account instead of blaming the setting', async () => {
  const { gladys, widgets } = createColdWidgets({
    config: normalizeConfig({ language: 'fr', client_id: 'id', client_secret: 'secret' }),
  });

  // The device exists in Gladys — the user picked it from the list — only the
  // account has not been read yet: "pick another one" would send them fixing
  // a setting that is perfectly fine.
  const content = await invoke(gladys, `widget:${WIDGETS.APPLIANCE}`, {
    settings: { appliance: DISHWASHER_DEVICE },
    language: 'fr',
    units: 'metric',
  });

  assertRenderable(content);
  assert.match(content.components[0].text.fr, /Lecture de vos appareils/);
  await widgets.reloading;
});

test('an account that is not connected says which screen to go to', async () => {
  const notConfigured = createColdWidgets({ config: normalizeConfig({ language: 'fr' }) });
  const noCredentials = await invoke(notConfigured.gladys, `widget:${WIDGETS.OVERVIEW}`, {
    settings: {},
    language: 'fr',
    units: 'metric',
  });
  assertRenderable(noCredentials);
  assert.match(noCredentials.components[0].text.fr, /Client ID/);
  assert.equal(notConfigured.api.calls.length, 0);

  const notAuthorized = createColdWidgets({
    api: { isAuthorized: () => false },
    config: normalizeConfig({ language: 'fr', client_id: 'id', client_secret: 'secret' }),
  });
  const content = await invoke(notAuthorized.gladys, `widget:${WIDGETS.OVERVIEW}`, {
    settings: {},
    language: 'fr',
    units: 'metric',
  });
  assertRenderable(content);
  assert.match(content.components[0].text.fr, /Connecter/);
  assert.equal(notAuthorized.api.calls.length, 0);
});

test('a failing account is not re-read on every single pull', async () => {
  let attempts = 0;
  const { gladys, widgets } = createColdWidgets({
    api: {
      async getAppliances() {
        attempts += 1;
        throw new Error('429 Too Many Requests');
      },
    },
    config: normalizeConfig({ language: 'fr', client_id: 'id', client_secret: 'secret' }),
  });

  for (let i = 0; i < 3; i += 1) {
    const content = await invoke(gladys, `widget:${WIDGETS.OVERVIEW}`, {
      settings: {},
      language: 'en',
      units: 'metric',
    });
    assertRenderable(content);
    await widgets.reloading;
  }

  assert.equal(attempts, 1);
});
