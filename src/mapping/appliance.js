// -----------------------------------------------------------------------------
// Home Connect appliance -> Gladys device.
//
// Turns the SNAPSHOT of an appliance (its envelope + the settings, statuses and
// programs read from the API) into the discovery payload Gladys expects, and
// into the batch of states that go with it.
//
// The device external_id is built on the `haId`, the identifier Home Connect
// assigns to the physical appliance (`BOSCH-HCS01OVN1-1234567890`): unique,
// stable across renames and re-pairings, exactly what `externalIds` wants. The
// device TYPE segment is the constant 'appliance' and not the Home Connect
// appliance type, so a fridge that starts reporting itself as a FridgeFreezer
// does not orphan the device the user already created.
// -----------------------------------------------------------------------------

import {
  EVENT_FEATURES,
  OPTION_FEATURES,
  PROGRAM_SWITCH_ID,
  ROOT_FEATURE_IDS,
  SETTING_FEATURES,
  STATUS_FEATURES,
  SYNTHETIC_FEATURES,
  eventAppliesTo,
  hasPrograms,
  mapUnit,
} from './catalog.js';
import { ROOT, STATUSES } from '../homeconnect/constants.js';
import { GLADYS_POLL_TICK_MS } from '../config.js';

export const DEVICE_TYPE = 'appliance';

/** @returns {string} the Gladys device external_id of an appliance. */
export function deviceExternalId(gladys, haId) {
  return gladys.externalIds(DEVICE_TYPE, haId).device;
}

/** @returns {string} the Gladys feature external_id of one appliance feature. */
export function featureExternalId(gladys, haId, featureId) {
  return gladys.externalIds(DEVICE_TYPE, haId).feature(featureId);
}

/**
 * A feature the appliance actually has, ready to be published and updated.
 * @typedef {object} FeatureModel
 * @property {string} featureId stable suffix of the external_id
 * @property {string|null} hcKey Home Connect key feeding it (null: synthetic)
 * @property {'setting'|'status'|'option'|'event'|'synthetic'} source
 * @property {object} entry catalog entry
 * @property {object} [constraints] appliance-specific constraints of the key
 * @property {string} [unit] Gladys unit, refined from the appliance answer
 * @property {string} [hcUnit] raw Home Connect unit (`"°C"`), echoed back on write
 */

/**
 * Decide which features an appliance exposes.
 *
 * Settings and statuses come from what the appliance ACTUALLY reports, so a
 * fridge without a wine compartment simply has no wine setpoint. Program
 * options and events cannot be discovered that way — options only exist while a
 * program is loaded and events are never listed at all — so those come from the
 * catalog, gated by whether the appliance runs programs and by its type.
 *
 * @param {object} snapshot
 * @returns {FeatureModel[]}
 */
export function buildFeatureModels(snapshot) {
  const models = [];
  const seen = new Set();

  const push = (model) => {
    if (seen.has(model.featureId)) {
      return;
    }
    seen.add(model.featureId);
    models.push(model);
  };

  // Always: is the appliance reachable through the Home Connect cloud at all.
  push({
    featureId: SYNTHETIC_FEATURES.connected.id,
    hcKey: null,
    source: 'synthetic',
    entry: SYNTHETIC_FEATURES.connected,
  });

  for (const { key, unit } of snapshot.settings ?? []) {
    const entry = SETTING_FEATURES[key];
    if (entry) {
      // Home Connect validates a written value against the unit it declared,
      // so the RAW unit string is kept next to the translated Gladys one.
      const hcUnit = unit ?? snapshot.constraints?.[key]?.unit;
      push({
        featureId: entry.id,
        hcKey: key,
        source: 'setting',
        entry,
        constraints: snapshot.constraints?.[key],
        hcUnit,
        unit: mapUnit(hcUnit) ?? entry.unit,
      });
    }
  }

  for (const { key, unit } of snapshot.statuses ?? []) {
    const entry = STATUS_FEATURES[key];
    if (entry) {
      push({
        featureId: entry.id,
        hcKey: key,
        source: 'status',
        entry,
        unit: mapUnit(unit) ?? entry.unit,
      });
    }
  }

  if (hasPrograms(snapshot.type)) {
    push({
      featureId: PROGRAM_SWITCH_ID,
      hcKey: STATUSES.OPERATION_STATE,
      source: 'synthetic',
      entry: SYNTHETIC_FEATURES[PROGRAM_SWITCH_ID],
    });
    push({
      featureId: SYNTHETIC_FEATURES['active-program'].id,
      hcKey: ROOT.ACTIVE_PROGRAM,
      source: 'synthetic',
      entry: SYNTHETIC_FEATURES['active-program'],
    });
    push({
      featureId: SYNTHETIC_FEATURES['selected-program'].id,
      hcKey: ROOT.SELECTED_PROGRAM,
      source: 'synthetic',
      entry: SYNTHETIC_FEATURES['selected-program'],
    });

    // Options the appliance is currently advertising, plus the handful every
    // program-driven appliance ends up publishing (`core: true`) so an idle
    // appliance still gets its progress features.
    const advertised = new Set(
      [
        ...(snapshot.activeProgram?.options ?? []),
        ...(snapshot.selectedProgram?.options ?? []),
      ].map((option) => option.key),
    );
    for (const [key, entry] of Object.entries(OPTION_FEATURES)) {
      if (entry.core || advertised.has(key)) {
        push({ featureId: entry.id, hcKey: key, source: 'option', entry, unit: entry.unit });
      }
    }
  }

  for (const [key, entry] of Object.entries(EVENT_FEATURES)) {
    if (eventAppliesTo(entry, snapshot.type)) {
      push({ featureId: entry.id, hcKey: key, source: 'event', entry });
    }
  }

  return models;
}

/**
 * Build the Gladys discovery payload of one appliance.
 *
 * @param {object} gladys SDK instance
 * @param {object} snapshot appliance snapshot
 * @param {object} config normalized integration config
 * @param {FeatureModel[]} [models] pre-computed models (avoids rebuilding them)
 */
export function buildDevice(gladys, snapshot, config, models = buildFeatureModels(snapshot)) {
  const ids = gladys.externalIds(DEVICE_TYPE, snapshot.haId);

  return {
    name: snapshot.name || `${snapshot.brand ?? 'Home Connect'} ${snapshot.type ?? ''}`.trim(),
    external_id: ids.device,
    // The event stream is the primary channel; polling is the safety net for
    // the windows where it is down (the cloud cuts it about once a day).
    //
    // Gladys only accepts its own enum of poll frequencies (in milliseconds,
    // one minute at the slowest), so the device is published on that tick and
    // the registry drops the ticks that come before `config.poll_frequency`
    // seconds have passed. Sending the configured interval directly is what
    // Gladys rejects with `devices[0].poll_frequency: invalid poll frequency`.
    poll_frequency: GLADYS_POLL_TICK_MS,
    // Free key/value pairs shown on the device page — the identity of the
    // physical appliance, useful when two identical ovens sit side by side.
    params: buildParams(snapshot),
    features: models.map((model) => buildFeature(ids, model, config)),
  };
}

function buildParams(snapshot) {
  const params = [
    { name: 'haId', value: String(snapshot.haId) },
    { name: 'type', value: String(snapshot.type ?? '') },
  ];
  if (snapshot.brand) {
    params.push({ name: 'brand', value: String(snapshot.brand) });
  }
  if (snapshot.vib) {
    params.push({ name: 'model', value: String(snapshot.vib) });
  }
  if (snapshot.enumber) {
    params.push({ name: 'enumber', value: String(snapshot.enumber) });
  }
  return params;
}

function buildFeature(ids, model, config) {
  const { entry, constraints } = model;
  const feature = {
    name: localizedName(entry.name, config.language),
    external_id: ids.feature(model.featureId),
    category: entry.category,
    type: entry.type,
    read_only: entry.readOnly !== false,
    // Writable features publish the value the appliance confirms (through the
    // event stream), not the one we asked for — that is what has_feedback means.
    has_feedback: entry.readOnly === false,
    // Text features hold names, not measurements: charting them is noise.
    keep_history: entry.category !== 'text',
    min: numberOr(constraints?.min, entry.min),
    max: numberOr(constraints?.max, entry.max),
  };
  const unit = model.unit ?? entry.unit;
  if (unit) {
    feature.unit = unit;
  }
  return feature;
}

function numberOr(candidate, fallback) {
  const num = Number(candidate);
  return Number.isFinite(num) ? num : fallback;
}

/**
 * Gladys stores ONE feature name per feature, so the catalog's multi-language
 * names collapse here, in the language the user picked in the config.
 * @param {{en: string} & Record<string, string>} name
 * @param {string} language
 */
export function localizedName(name, language) {
  return name[language] ?? name.en;
}

/**
 * Read every value of a snapshot through the catalog and produce the Gladys
 * state batch. Values the appliance does not report are skipped rather than
 * published as zero: "unknown" and "off" are not the same thing.
 *
 * @param {object} gladys
 * @param {object} snapshot
 * @param {FeatureModel[]} models
 * @returns {Array<{device_feature_external_id: string, state?: number, text?: string}>}
 */
export function buildStates(gladys, snapshot, models) {
  const ids = gladys.externalIds(DEVICE_TYPE, snapshot.haId);
  const values = snapshotValues(snapshot);
  const states = [];

  for (const model of models) {
    const decoded = decodeFor(model, values, snapshot);
    if (decoded === undefined) {
      continue;
    }
    states.push({ device_feature_external_id: ids.feature(model.featureId), ...decoded });
  }

  return states;
}

/**
 * Flatten a snapshot into a single `Home Connect key -> value` map, so the
 * decoding loop never has to care which endpoint a value came from.
 */
function snapshotValues(snapshot) {
  const values = new Map();
  for (const { key, value } of snapshot.settings ?? []) {
    values.set(key, value);
  }
  for (const { key, value } of snapshot.statuses ?? []) {
    values.set(key, value);
  }
  // Selected first, active second: while a program runs, its options are the
  // ones that describe reality.
  for (const { key, value } of snapshot.selectedProgram?.options ?? []) {
    values.set(key, value);
  }
  for (const { key, value } of snapshot.activeProgram?.options ?? []) {
    values.set(key, value);
  }
  if (snapshot.activeProgram?.key) {
    values.set(ROOT.ACTIVE_PROGRAM, snapshot.activeProgram.key);
  }
  if (snapshot.selectedProgram?.key) {
    values.set(ROOT.SELECTED_PROGRAM, snapshot.selectedProgram.key);
  }
  // Events are not readable from any endpoint, so the registry mirrors the ones
  // the stream delivered into the snapshot: without that, re-publishing a
  // snapshot would reset a still-standing alert back to "cleared".
  for (const [key, value] of Object.entries(snapshot.events ?? {})) {
    values.set(key, value);
  }
  return values;
}

function decodeFor(model, values, snapshot) {
  if (model.featureId === SYNTHETIC_FEATURES.connected.id) {
    return { state: snapshot.connected ? 1 : 0 };
  }
  // A program feature with nothing running reads "none", not "stale value".
  if (model.hcKey === ROOT.ACTIVE_PROGRAM && !snapshot.activeProgram?.key) {
    return { text: '' };
  }
  if (model.hcKey === ROOT.SELECTED_PROGRAM && !snapshot.selectedProgram?.key) {
    return { text: '' };
  }
  if (!values.has(model.hcKey)) {
    // An event nobody raised is not an unknown value: it is an alert that is
    // not standing. Home Connect only ever sends the "present" edge, so a
    // dishwasher that has never run low on salt would otherwise sit forever on
    // "no recent value" instead of reading a plain, honest zero.
    if (model.source === 'event') {
      return { state: 0 };
    }
    return undefined;
  }
  return toState(model.entry.decode(values.get(model.hcKey)));
}

/**
 * Normalize what a decoder returns into a Gladys state fragment. Decoders
 * return either a number (numeric feature), a `{ text }` object (text feature),
 * or `undefined` when the value made no sense.
 * @param {number|{text: string}|undefined} decoded
 */
export function toState(decoded) {
  if (decoded === undefined || decoded === null) {
    return undefined;
  }
  if (typeof decoded === 'object') {
    return typeof decoded.text === 'string' ? { text: decoded.text } : undefined;
  }
  return Number.isFinite(decoded) ? { state: decoded } : undefined;
}

/** Re-exported for the dispatcher, which needs the roots by key. */
export { ROOT_FEATURE_IDS };
