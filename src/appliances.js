// -----------------------------------------------------------------------------
// Appliance registry: the moving part of the integration.
//
// It owns the in-memory picture of every Home Connect appliance and is the only
// place that talks to both sides at once:
//
//   Home Connect                       Gladys
//   ------------                       ------
//   GET /homeappliances       ──▶ refresh()      ──▶ publishDiscoveredDevices
//   GET /settings /status     ──▶ snapshot       ──▶ publishStates
//   SSE STATUS/NOTIFY/EVENT   ──▶ handleEvent()  ──▶ publishState
//   PUT /settings, /programs  ◀── setValue()     ◀── onSetValue
//
// Everything about "which Gladys feature does this Home Connect key feed" is
// resolved once, at refresh time, into a `FeatureModel` list per appliance —
// the event path then costs one Map lookup, not a catalog walk.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { RateLimitedError } from './homeconnect/api.js';
import { ReauthorizationRequiredError } from './homeconnect/oauth.js';
import { OPERATION_STATE, ROOT, SSE_TYPES, STATUSES } from './homeconnect/constants.js';
import { SETTING_FEATURES, SYNTHETIC_FEATURES } from './mapping/catalog.js';
import {
  DEVICE_TYPE,
  buildDevice,
  buildFeatureModels,
  buildStates,
  toState,
} from './mapping/appliance.js';

const logger = createLogger({ name: 'appliances' });

// PAIRED / DEPAIRED mean the appliance list changed. Several of them arrive
// together when a user adds a hub full of appliances, so the re-discovery they
// trigger is debounced into one call.
const REDISCOVERY_DEBOUNCE_MS = 5_000;

export class ApplianceRegistry {
  /**
   * @param {object} options
   * @param {object} options.gladys SDK instance
   * @param {import('./homeconnect/api.js').HomeConnectApi} options.api
   * @param {() => object} options.getConfig
   */
  constructor({ gladys, api, getConfig }) {
    this.gladys = gladys;
    this.api = api;
    this.getConfig = getConfig;
    /** @type {Map<string, {snapshot: object, models: object[], byKey: Map<string, object[]>, byFeatureId: Map<string, object>}>} */
    this.appliances = new Map();
    this.rediscoveryTimer = null;
  }

  /** Every appliance as a Gladys discovery payload (used by onScanRequest). */
  buildDiscoveredDevices() {
    return [...this.appliances.values()].map(({ snapshot, models }) =>
      buildDevice(this.gladys, snapshot, this.getConfig(), models),
    );
  }

  // --- Discovery -------------------------------------------------------------

  /**
   * Re-read the whole account: appliance list, then a full snapshot of each.
   * Publishes the devices, their transport badge and their current states.
   *
   * @returns {Promise<number>} number of appliances found
   */
  async refresh() {
    const appliances = await this.api.getAppliances();
    logger.info(`${appliances.length} appliance(s) found on the Home Connect account`);

    const seen = new Set();
    for (const appliance of appliances) {
      if (!appliance?.haId) {
        continue;
      }
      seen.add(appliance.haId);
      await this.refreshAppliance(appliance);
    }

    // An appliance unpaired from the Home Connect account stops being
    // published. Gladys keeps the device the user created (its history is
    // theirs), it simply no longer shows up in Discovery.
    for (const haId of [...this.appliances.keys()]) {
      if (!seen.has(haId)) {
        logger.info(`Appliance ${haId} is gone from the account`);
        this.appliances.delete(haId);
      }
    }

    await this.publishAll();
    return this.appliances.size;
  }

  /**
   * Read one appliance and store its snapshot + feature models.
   * @param {object} appliance the envelope from GET /homeappliances
   */
  async refreshAppliance(appliance) {
    const previous = this.appliances.get(appliance.haId);
    const snapshot = await this.fetchSnapshot(appliance, previous?.snapshot?.constraints);
    const models = buildFeatureModels(snapshot);

    // Two indexes, because the two hot paths ask different questions: the event
    // stream has a Home Connect key, the command handler has a Gladys feature.
    const byKey = new Map();
    const byFeatureId = new Map();
    for (const model of models) {
      byFeatureId.set(model.featureId, model);
      if (model.hcKey) {
        const list = byKey.get(model.hcKey) ?? [];
        list.push(model);
        byKey.set(model.hcKey, list);
      }
    }

    this.appliances.set(appliance.haId, { snapshot, models, byKey, byFeatureId });
  }

  /**
   * Build the full picture of one appliance.
   *
   * A disconnected appliance answers 409 to everything: skip the detail calls
   * entirely rather than burn quota on five guaranteed failures, and keep the
   * previous snapshot's shape so its Gladys features do not disappear from
   * Discovery while it is unplugged.
   *
   * @param {object} appliance
   * @param {Record<string, object>} [knownConstraints] constraints already read
   */
  async fetchSnapshot(appliance, knownConstraints) {
    const base = {
      haId: appliance.haId,
      name: appliance.name,
      brand: appliance.brand,
      type: appliance.type,
      vib: appliance.vib,
      enumber: appliance.enumber,
      connected: appliance.connected !== false,
      settings: [],
      statuses: [],
      constraints: knownConstraints ?? {},
      activeProgram: null,
      selectedProgram: null,
    };

    if (!base.connected) {
      logger.info(`Appliance ${appliance.haId} is offline, keeping the last known shape`);
      const previous = this.appliances.get(appliance.haId)?.snapshot;
      return previous ? { ...previous, connected: false } : base;
    }

    base.settings = await this.readSafely(
      () => this.api.getSettings(appliance.haId),
      [],
      `settings of ${appliance.haId}`,
    );
    base.statuses = await this.readSafely(
      () => this.api.getStatuses(appliance.haId),
      [],
      `status of ${appliance.haId}`,
    );

    // Constraints are what make a feature accurate (setpoint bounds, the "off"
    // value PowerState accepts). They never change for a given appliance, so
    // they are read once and carried over on every later refresh.
    base.constraints = { ...(knownConstraints ?? {}) };
    for (const { key } of base.settings) {
      if (!SETTING_FEATURES[key]?.needsConstraints || base.constraints[key]) {
        continue;
      }
      const detail = await this.readSafely(
        () => this.api.getSettingDetail(appliance.haId, key),
        null,
        `constraints of ${key}`,
      );
      if (detail?.constraints) {
        base.constraints[key] = { ...detail.constraints, unit: detail.unit };
      }
    }

    base.activeProgram = await this.readSafely(
      () => this.api.getActiveProgram(appliance.haId),
      null,
      `active program of ${appliance.haId}`,
    );
    base.selectedProgram = await this.readSafely(
      () => this.api.getSelectedProgram(appliance.haId),
      null,
      `selected program of ${appliance.haId}`,
    );

    return base;
  }

  /**
   * Run a read that is allowed to fail. Appliances legitimately refuse parts of
   * the API (no programs on a fridge, no status while powered off), and one
   * refusal must never abort the discovery of everything else. A rate limit is
   * the exception: it concerns every following call, so it propagates.
   */
  async readSafely(read, fallback, what) {
    try {
      return await read();
    } catch (err) {
      if (err instanceof RateLimitedError || err instanceof ReauthorizationRequiredError) {
        throw err;
      }
      logger.debug(`Could not read the ${what}: ${err.message}`);
      return fallback;
    }
  }

  // --- Publishing ------------------------------------------------------------

  /** Publish the devices, their transport badge and their current states. */
  async publishAll() {
    await this.gladys.publishDiscoveredDevices(this.buildDiscoveredDevices());
    await this.publishTransports();
    for (const haId of this.appliances.keys()) {
      await this.publishSnapshotStates(haId);
    }
  }

  /**
   * Home Connect is a cloud-only API: there is no local channel to prefer, so
   * the badge carries the one thing that does vary — whether the appliance is
   * currently reachable at all.
   */
  async publishTransports() {
    const entries = [...this.appliances.values()].map(({ snapshot }) => ({
      external_id: this.gladys.externalIds(DEVICE_TYPE, snapshot.haId).device,
      transport: snapshot.connected ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
      ...(snapshot.connected
        ? {}
        : {
            degraded: true,
            message: {
              en: 'Appliance offline: Home Connect cannot reach it.',
              fr: 'Appareil hors ligne : Home Connect ne le joint pas.',
            },
          }),
    }));
    if (entries.length > 0) {
      await this.gladys.publishTransports(entries);
    }
  }

  /** Publish every state readable from the stored snapshot of one appliance. */
  async publishSnapshotStates(haId) {
    const appliance = this.appliances.get(haId);
    if (!appliance) {
      return;
    }
    const states = buildStates(this.gladys, appliance.snapshot, appliance.models);
    if (states.length > 0) {
      // publishStates batches up to 100 states per request; an appliance never
      // gets close, so one call per appliance is enough.
      await this.gladys.publishStates(states);
    }
  }

  // --- Polling ---------------------------------------------------------------

  /**
   * Refresh ONE appliance, on the schedule Gladys drives through
   * `poll_frequency`. This is the safety net behind the event stream: the cloud
   * closes the stream about once a day, and a reconnection that lands badly
   * must not leave the devices frozen on yesterday's values.
   *
   * @param {object} device the Gladys device being polled
   */
  async poll(device) {
    const haId = haIdFromExternalId(device.external_id);
    const known = this.appliances.get(haId);
    if (!known) {
      // The user created the device from a previous discovery and the appliance
      // is not in our map yet (fresh container, refresh still failing): pull the
      // whole account rather than guess.
      logger.info(`Polled an unknown appliance (${haId}), refreshing the account`);
      await this.refresh();
      return;
    }
    // One call for the envelope (name, connected flag), not the whole account:
    // Gladys polls each device on its own timer and the quota is shared.
    const envelope = await this.api.getAppliance(haId);
    await this.refreshAppliance({ ...envelope, haId });
    await this.publishTransports();
    await this.publishSnapshotStates(haId);
  }

  // --- Event stream ----------------------------------------------------------

  /**
   * Apply one event of the Home Connect stream.
   *
   * Unlike a webhook relay, this stream is authenticated, ordered and complete,
   * so its values are applied directly instead of merely triggering a re-read —
   * that is the whole point of holding the connection open.
   *
   * @param {import('./homeconnect/events.js').HomeConnectEvent} event
   */
  async handleEvent(event) {
    const appliance = this.appliances.get(event.haId);

    switch (event.type) {
      case SSE_TYPES.CONNECTED:
      case SSE_TYPES.DISCONNECTED: {
        if (!appliance) {
          return;
        }
        appliance.snapshot.connected = event.type === SSE_TYPES.CONNECTED;
        await this.publishFeature(event.haId, SYNTHETIC_FEATURES.connected.id, {
          state: appliance.snapshot.connected ? 1 : 0,
        });
        await this.publishTransports();
        // Coming back online, the appliance may have changed everything while
        // it was away: re-read it instead of trusting stale values.
        if (appliance.snapshot.connected) {
          this.scheduleRediscovery();
        }
        return;
      }
      case SSE_TYPES.PAIRED:
      case SSE_TYPES.DEPAIRED:
        this.scheduleRediscovery();
        return;
      default:
        break;
    }

    if (!appliance || !event.key) {
      return;
    }

    // Keep the snapshot in sync so a later poll or re-publish starts from the
    // truth, not from the last full read.
    this.rememberValue(appliance.snapshot, event.key, event.value);

    const states = [];
    for (const model of appliance.byKey.get(event.key) ?? []) {
      const decoded = toState(model.entry.decode(event.value));
      if (decoded) {
        states.push({
          device_feature_external_id: this.featureExternalId(event.haId, model.featureId),
          ...decoded,
        });
      }
    }

    if (states.length > 0) {
      await this.gladys.publishStates(states);
    }

    // A finished or aborted program leaves its options behind: Home Connect
    // stops sending them but never sends a zero, so the "remaining time" would
    // stay stuck at whatever it last was. Clear them on the way out.
    if (event.key === STATUSES.OPERATION_STATE && isIdleState(event.value)) {
      await this.clearProgramOptions(event.haId);
    }
  }

  /** Mirror an event value into the stored snapshot. */
  rememberValue(snapshot, key, value) {
    if (key === ROOT.ACTIVE_PROGRAM) {
      snapshot.activeProgram = value ? { key: value, options: [] } : null;
      return;
    }
    if (key === ROOT.SELECTED_PROGRAM) {
      snapshot.selectedProgram = value ? { key: value, options: [] } : null;
      return;
    }
    for (const collection of ['settings', 'statuses']) {
      const existing = snapshot[collection]?.find((item) => item.key === key);
      if (existing) {
        existing.value = value;
        return;
      }
    }
  }

  /** Reset the program option features once nothing is running. */
  async clearProgramOptions(haId) {
    const appliance = this.appliances.get(haId);
    if (!appliance) {
      return;
    }
    const states = appliance.models
      .filter((model) => model.source === 'option' && model.entry.category !== 'text')
      .map((model) => ({
        device_feature_external_id: this.featureExternalId(haId, model.featureId),
        state: 0,
      }));
    if (states.length > 0) {
      await this.gladys.publishStates(states);
    }
  }

  /** Debounced full re-discovery, for the events that change the appliance list. */
  scheduleRediscovery() {
    clearTimeout(this.rediscoveryTimer);
    this.rediscoveryTimer = setTimeout(() => {
      this.refresh().catch((err) => logger.error('Re-discovery failed', err));
    }, REDISCOVERY_DEBOUNCE_MS);
    this.rediscoveryTimer.unref?.();
  }

  // --- Commands --------------------------------------------------------------

  /**
   * Apply a user command on one feature.
   *
   * Throwing is meaningful here: the SDK turns it into a `success: false`
   * acknowledgement, and Gladys shows the message. Home Connect refuses
   * commands for good reasons — door open, remote start not armed, appliance
   * powered off — and the user deserves to read that reason rather than watch a
   * toggle silently spring back.
   *
   * @param {object} device
   * @param {object} feature
   * @param {number} value
   */
  async setValue(device, feature, value) {
    const haId = haIdFromExternalId(device.external_id);
    const featureId = featureIdFromExternalId(device.external_id, feature.external_id);
    const appliance = this.appliances.get(haId);
    const model = appliance?.byFeatureId.get(featureId);

    if (!model) {
      throw new Error(`Unknown Home Connect feature: ${feature.external_id}`);
    }
    if (!model.entry.write) {
      throw new Error(`Feature ${featureId} is read-only`);
    }
    if (!appliance.snapshot.connected) {
      throw new Error('Appliance is offline in Home Connect');
    }

    if (model.entry.write === 'program') {
      await this.setProgramState(haId, value);
      return;
    }

    const encoded = model.entry.encode(value, { constraints: model.constraints });
    logger.info(`${haId}: ${model.hcKey} = ${encoded}`);
    await this.api.setSetting(haId, model.hcKey, encoded, model.hcUnit);

    // Optimistic echo so the UI settles immediately; the event stream sends the
    // value the appliance actually adopted a moment later and wins.
    this.rememberValue(appliance.snapshot, model.hcKey, encoded);
    const decoded = toState(model.entry.decode(encoded));
    if (decoded) {
      await this.publishFeature(haId, featureId, decoded);
    }
  }

  /**
   * Start or stop the program. Starting runs whatever the user selected on the
   * appliance (or in the Home Connect app) — Gladys does not pick a program, it
   * pulls the trigger, which is also the only start the appliance accepts
   * without re-declaring every option.
   */
  async setProgramState(haId, value) {
    // A refusal propagates as-is: `HomeConnectApiError` already carries Home
    // Connect's own wording ("Remote start is not enabled"), which is far more
    // useful to the user than anything this integration could invent, and the
    // SDK turns the thrown message into the failed acknowledgement.
    if (value === 1) {
      logger.info(`${haId}: starting the selected program`);
      await this.api.startSelectedProgram(haId);
    } else {
      logger.info(`${haId}: stopping the running program`);
      await this.api.stopProgram(haId);
    }
    // No optimistic echo: the appliance goes through DelayedStart/Aborting
    // before settling, and the event stream reports each step accurately.
  }

  // --- Helpers ---------------------------------------------------------------

  featureExternalId(haId, featureId) {
    return this.gladys.externalIds(DEVICE_TYPE, haId).feature(featureId);
  }

  publishFeature(haId, featureId, state) {
    return this.gladys.publishStates([
      { device_feature_external_id: this.featureExternalId(haId, featureId), ...state },
    ]);
  }
}

/**
 * `ext:<selector>:appliance:<haId>` -> `<haId>`.
 * A Home Connect haId never contains a colon, so the last segment is it.
 * @param {string} externalId
 */
export function haIdFromExternalId(externalId) {
  const parts = String(externalId).split(':');
  return parts[parts.length - 1];
}

/**
 * The feature suffix, i.e. what the device external_id is followed by.
 * @param {string} deviceExternalId
 * @param {string} featureExternalId
 */
export function featureIdFromExternalId(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId).startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : String(featureExternalId).split(':').pop();
}

function isIdleState(operationState) {
  return (
    operationState === OPERATION_STATE.FINISHED ||
    operationState === OPERATION_STATE.READY ||
    operationState === OPERATION_STATE.INACTIVE
  );
}
