// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the integration relies on, so the mapping and
// dispatch logic can be tested without a running Gladys server, a WebSocket, or
// a Home Connect account.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const discovered = [];
  const transports = [];
  const connectionStatuses = [];
  const configPatches = [];
  // Gladys 5.1: the scene events fired, the widget nudges sent, and the
  // handlers the integration registered (so a test can call them the way the
  // core would).
  const sceneEvents = [];
  const widgetRefreshes = [];
  const handlers = new Map();
  // SDK 0.15 deduplication memory: last value Gladys accepted per feature.
  const publishedStates = new Map();

  return {
    published,
    discovered,
    transports,
    connectionStatuses,
    configPatches,
    sceneEvents,
    widgetRefreshes,
    handlers,
    publishedStates,

    externalIds(type, platformId) {
      const device = `ext:home-connect:${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishDiscoveredDevices(devices) {
      discovered.push(devices);
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const state of states) {
        published.push({
          featureExternalId: state.device_feature_external_id,
          state: state.state,
          text: state.text,
        });
      }
    },

    // Same rules as the SDK method: an entry equal (same state, same text) to
    // the last value ACCEPTED for its feature is skipped, within the call too;
    // `heartbeat` re-sends an unchanged value that old; a value is remembered
    // only if publishStates (overridable by a test) accepted it.
    async publishChangedStates(states, { heartbeat } = {}) {
      const now = Date.now();
      const previous = new Map();
      const changed = states.filter(({ device_feature_external_id: id, state, text }) => {
        const last = previous.has(id) ? previous.get(id) : publishedStates.get(id);
        previous.set(id, { state, text, at: now });
        return (
          last === undefined ||
          last.state !== state ||
          last.text !== text ||
          (heartbeat !== undefined && now - last.at >= heartbeat)
        );
      });
      for (let start = 0; start < changed.length; start += 100) {
        const batch = changed.slice(start, start + 100);
        batch.forEach(({ device_feature_external_id: id, state, text }) =>
          publishedStates.set(id, { state, text, at: now }),
        );
        try {
          await this.publishStates(batch);
        } catch (err) {
          batch.forEach(({ device_feature_external_id: id }) => publishedStates.delete(id));
          throw err;
        }
      }
      return { success: true, count: changed.length };
    },

    // The SDK also calls it itself when Gladys creates, updates or deletes a
    // device; a test plays that part by calling it.
    forgetPublishedStates(externalId) {
      if (externalId === undefined) {
        publishedStates.clear();
        return;
      }
      for (const id of [...publishedStates.keys()]) {
        if (id === externalId || id.startsWith(`${externalId}:`)) {
          publishedStates.delete(id);
        }
      }
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async setConfig(patch) {
      configPatches.push(patch);
    },

    // --- Gladys 5.1: scene triggers, scene actions, dashboard widgets --------

    async publishSceneEvent(key, data) {
      sceneEvents.push({ key, data });
      return { success: true };
    },

    onSceneAction(key, callback) {
      handlers.set(`sceneAction:${key}`, callback);
    },

    onWidgetGet(key, callback) {
      handlers.set(`widget:${key}`, callback);
    },

    onWidgetAction(key, callback) {
      handlers.set(`widgetAction:${key}`, callback);
    },

    requestWidgetRefresh(key) {
      widgetRefreshes.push(key);
    },
  };
}

/**
 * Call a handler the integration registered, the way the Gladys core would.
 * @param {ReturnType<typeof createFakeGladys>} gladys
 * @param {string} name `sceneAction:<key>`, `widget:<key>`, `widgetAction:<key>`
 * @param {...unknown} args
 */
export function invoke(gladys, name, ...args) {
  const handler = gladys.handlers.get(name);
  if (!handler) {
    throw new Error(`No handler registered for ${name}`);
  }
  return handler(...args);
}

/**
 * The state published for one feature suffix, or undefined.
 * @param {ReturnType<typeof createFakeGladys>} gladys
 * @param {string} featureId
 */
export function lastStateOf(gladys, featureId) {
  const entries = gladys.published.filter((entry) =>
    entry.featureExternalId.endsWith(`:${featureId}`),
  );
  return entries.length === 0 ? undefined : entries[entries.length - 1];
}
