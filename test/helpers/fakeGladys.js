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

  return {
    published,
    discovered,
    transports,
    connectionStatuses,
    configPatches,

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

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async setConfig(patch) {
      configPatches.push(patch);
    },
  };
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
