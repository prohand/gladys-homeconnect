// -----------------------------------------------------------------------------
// Home Connect API fixtures, shaped exactly like the real answers (the `data`
// envelope already unwrapped, since that is what the API client returns).
// -----------------------------------------------------------------------------

import {
  DOOR_STATE,
  OPERATION_STATE,
  OPTIONS,
  POWER_STATE,
  SETTINGS,
  STATUSES,
} from '../../src/homeconnect/constants.js';

export const DISHWASHER = {
  haId: 'BOSCH-HCS03DWH-1234567890AB',
  name: 'Dishwasher',
  brand: 'BOSCH',
  vib: 'HCS03DWH',
  enumber: 'HCS03DWH/03',
  type: 'Dishwasher',
  connected: true,
};

export const FRIDGE = {
  haId: 'SIEMENS-HCS05FRF-CDEF12345678',
  name: 'Fridge freezer',
  brand: 'SIEMENS',
  vib: 'HCS05FRF',
  enumber: 'HCS05FRF/03',
  type: 'FridgeFreezer',
  connected: true,
};

export const DISHWASHER_SETTINGS = [
  { key: SETTINGS.POWER_STATE, value: POWER_STATE.ON },
  { key: SETTINGS.CHILD_LOCK, value: false },
];

export const DISHWASHER_STATUSES = [
  { key: STATUSES.OPERATION_STATE, value: OPERATION_STATE.RUN },
  { key: STATUSES.DOOR_STATE, value: DOOR_STATE.CLOSED },
  { key: STATUSES.REMOTE_CONTROL_START_ALLOWED, value: true },
];

export const DISHWASHER_ACTIVE_PROGRAM = {
  key: 'Dishcare.Dishwasher.Program.Auto2',
  options: [
    { key: OPTIONS.REMAINING_PROGRAM_TIME, value: 1800, unit: 'seconds' },
    { key: OPTIONS.PROGRAM_PROGRESS, value: 42, unit: '%' },
  ],
};

export const FRIDGE_SETTINGS = [
  { key: SETTINGS.FRIDGE_SETPOINT, value: 6, unit: '°C' },
  { key: SETTINGS.FREEZER_SETPOINT, value: -18, unit: '°C' },
  { key: SETTINGS.FRIDGE_SUPER_MODE, value: false },
];

export const FRIDGE_STATUSES = [
  { key: STATUSES.DOOR_REFRIGERATOR, value: 'Refrigeration.Common.EnumType.Door.States.Closed' },
];

/**
 * A fake HomeConnectApi: same method surface, canned answers, and a call log so
 * a test can assert what was written.
 */
export function createFakeApi(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    isAuthorized: () => true,
    async getAppliances() {
      calls.push(['getAppliances']);
      return [DISHWASHER, FRIDGE];
    },
    async getAppliance(haId) {
      calls.push(['getAppliance', haId]);
      return [DISHWASHER, FRIDGE].find((appliance) => appliance.haId === haId);
    },
    async getSettings(haId) {
      calls.push(['getSettings', haId]);
      return copy(haId === DISHWASHER.haId ? DISHWASHER_SETTINGS : FRIDGE_SETTINGS);
    },
    async getStatuses(haId) {
      calls.push(['getStatuses', haId]);
      return copy(haId === DISHWASHER.haId ? DISHWASHER_STATUSES : FRIDGE_STATUSES);
    },
    async getSettingDetail(haId, key) {
      calls.push(['getSettingDetail', haId, key]);
      if (key === SETTINGS.POWER_STATE) {
        return {
          key,
          value: POWER_STATE.ON,
          constraints: { allowedvalues: [POWER_STATE.ON, POWER_STATE.OFF] },
        };
      }
      if (key === SETTINGS.FRIDGE_SETPOINT) {
        return { key, value: 6, unit: '°C', constraints: { min: 2, max: 8 } };
      }
      if (key === SETTINGS.FREEZER_SETPOINT) {
        return { key, value: -18, unit: '°C', constraints: { min: -24, max: -16 } };
      }
      return null;
    },
    async getActiveProgram(haId) {
      calls.push(['getActiveProgram', haId]);
      return haId === DISHWASHER.haId ? copy(DISHWASHER_ACTIVE_PROGRAM) : null;
    },
    async getSelectedProgram(haId) {
      calls.push(['getSelectedProgram', haId]);
      return haId === DISHWASHER.haId ? copy(DISHWASHER_ACTIVE_PROGRAM) : null;
    },
    async setSetting(haId, key, value, unit) {
      calls.push(['setSetting', haId, key, value, unit]);
    },
    async startSelectedProgram(haId) {
      calls.push(['startSelectedProgram', haId]);
    },
    async stopProgram(haId) {
      calls.push(['stopProgram', haId]);
    },
    ...overrides,
  };
  return api;
}

/**
 * The registry writes into the snapshot it is given (an event updates a value
 * in place), so every call hands out its own copy — otherwise one test would
 * change what the next one reads.
 */
function copy(value) {
  return structuredClone(value);
}
