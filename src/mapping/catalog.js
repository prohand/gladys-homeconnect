// -----------------------------------------------------------------------------
// Home Connect key -> Gladys feature catalog.
//
// The whole integration is data-driven from this file. Home Connect describes
// every appliance with the same vocabulary — a flat list of dotted keys — so
// instead of writing one module per appliance kind (dishwasher.js, oven.js…),
// there is ONE appliance module that walks the keys the appliance actually
// reports and looks each of them up here. Supporting a new key is adding one
// entry; supporting a new appliance family is usually nothing at all.
//
// Each entry declares:
//   - id            : short, STABLE suffix of the Gladys feature external_id.
//                     Never rename one: it is what ties a created feature to
//                     its history in the user's Gladys.
//   - name          : multi-language feature name
//   - category/type : the standard Gladys constants
//   - unit/min/max  : bounds; `constraints()` can refine them per appliance
//   - decode(value) : Home Connect value -> Gladys state (number, or `{ text }`)
//   - write         : how a command is applied ('setting' | 'program'), absent
//                     for read-only features
//   - encode(value) : Gladys command value -> Home Connect value
//   - appliesTo     : appliance types this entry is offered to. Only needed for
//                     EVENT keys: settings, statuses and program options are
//                     discovered from the appliance itself, but events are
//                     never listed by any endpoint — they only ever arrive on
//                     the stream, so they have to be declared up front.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import {
  DOOR_STATE,
  EVENTS,
  EVENT_PRESENT_STATE,
  OPTIONS,
  POWER_STATE,
  REFRIGERATION_DOOR_STATE,
  RUNNING_OPERATION_STATES,
  ROOT,
  SETTINGS,
  STATUSES,
  shortName,
} from '../homeconnect/constants.js';

// --- Shared decoders ---------------------------------------------------------

/** Home Connect booleans arrive as real JSON booleans. */
const decodeBoolean = (value) => (value === true || value === 'true' ? 1 : 0);

/** Numeric settings/statuses/options; anything unparsable is dropped. */
const decodeNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
};

/** Percentages and temperatures are published rounded to the nearest integer. */
const decodeInteger = (value) => {
  const num = decodeNumber(value);
  return num === undefined ? undefined : Math.round(num);
};

/** Enum -> binary, `trueValues` listing the values that mean 1. */
const decodeEnumBinary =
  (...trueValues) =>
  (value) =>
    trueValues.includes(value) ? 1 : 0;

/** Enum -> readable text feature (`Run`, `Open`, `Auto2`…). */
const decodeText = (value) => ({ text: shortName(value) });

// --- Shared feature shapes ---------------------------------------------------

/** A read-only binary status: doors, alarms, permissions. */
const binarySensor = (category = DEVICE_FEATURE_CATEGORIES.INPUT) => ({
  category,
  type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
  readOnly: true,
  min: 0,
  max: 1,
});

/** A writable on/off setting. */
const binarySwitch = (category = DEVICE_FEATURE_CATEGORIES.SWITCH) => ({
  category,
  type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
  readOnly: false,
  min: 0,
  max: 1,
  write: 'setting',
  decode: decodeBoolean,
  encode: (value) => value === 1,
});

/** A duration in seconds (remaining time, elapsed time, program duration). */
const durationSensor = {
  category: DEVICE_FEATURE_CATEGORIES.DURATION,
  type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
  unit: DEVICE_FEATURE_UNITS.SECONDS,
  readOnly: true,
  min: 0,
  max: 86_400,
  decode: decodeInteger,
};

/**
 * A percentage with no dedicated Gladys category (progress, forecasts).
 *
 * Gladys names a feature in its device/discovery views from the CATEGORY+TYPE
 * pair (`deviceFeatureCategory.<category>.<type>`), and there is no translation
 * for `unknown` + `integer`: those features showed up as nameless chips. The
 * `unknown` category only ever translates its own `unknown` type, so that is
 * the pair used here — the value is still an integer percentage, and read-only
 * features are rendered by the generic sensor row whatever their type is.
 */
const percentSensor = {
  category: DEVICE_FEATURE_CATEGORIES.UNKNOWN,
  type: DEVICE_FEATURE_TYPES.SENSOR.UNKNOWN,
  unit: DEVICE_FEATURE_UNITS.PERCENT,
  readOnly: true,
  min: 0,
  max: 100,
  decode: decodeInteger,
};

/** A read-only temperature reading. */
const temperatureSensor = {
  category: DEVICE_FEATURE_CATEGORIES.TEMPERATURE_SENSOR,
  type: DEVICE_FEATURE_TYPES.SENSOR.DECIMAL,
  unit: DEVICE_FEATURE_UNITS.CELSIUS,
  readOnly: true,
  min: -50,
  max: 500,
  decode: decodeNumber,
};

/** A writable temperature setpoint (fridge, freezer, wine compartment…). */
const temperatureSetpoint = {
  category: DEVICE_FEATURE_CATEGORIES.THERMOSTAT,
  type: DEVICE_FEATURE_TYPES.THERMOSTAT.TARGET_TEMPERATURE,
  unit: DEVICE_FEATURE_UNITS.CELSIUS,
  readOnly: false,
  min: -30,
  max: 30,
  write: 'setting',
  decode: decodeNumber,
  encode: decodeNumber,
  // The real bounds are per appliance (a wine cooler is not a freezer): read
  // them from the setting's own constraints at discovery time.
  needsConstraints: true,
};

/** A writable 0-100 % light level. */
const brightnessSetting = {
  category: DEVICE_FEATURE_CATEGORIES.LIGHT,
  type: DEVICE_FEATURE_TYPES.LIGHT.BRIGHTNESS,
  unit: DEVICE_FEATURE_UNITS.PERCENT,
  readOnly: false,
  min: 0,
  max: 100,
  write: 'setting',
  decode: decodeInteger,
  encode: decodeInteger,
  needsConstraints: true,
};

/** A monotonic counter (coffee machine beverage counters). */
const counterSensor = {
  category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
  type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
  readOnly: true,
  min: 0,
  max: 1_000_000,
  decode: decodeInteger,
};

/** A transient Home Connect event, held as a binary "present / cleared". */
const eventSensor = {
  ...binarySensor(),
  decode: decodeEnumBinary(EVENT_PRESENT_STATE.PRESENT),
};

// --- Settings ----------------------------------------------------------------

export const SETTING_FEATURES = {
  [SETTINGS.POWER_STATE]: {
    id: 'power',
    name: { en: 'Power', fr: 'Alimentation' },
    ...binarySwitch(),
    decode: decodeEnumBinary(POWER_STATE.ON),
    // Which "off" an appliance accepts is appliance-specific: an oven only
    // goes to Standby, a coffee machine really switches Off. Ask the appliance
    // (constraints.allowedvalues) instead of guessing, and fall back to
    // Standby — refusing a command is better than powering something down in
    // a way the appliance cannot come back from over the network.
    encode: (value, { constraints } = {}) => {
      if (value === 1) {
        return POWER_STATE.ON;
      }
      const allowed = constraints?.allowedvalues ?? [];
      if (allowed.includes(POWER_STATE.OFF)) {
        return POWER_STATE.OFF;
      }
      if (allowed.includes(POWER_STATE.STANDBY)) {
        return POWER_STATE.STANDBY;
      }
      return POWER_STATE.STANDBY;
    },
    needsConstraints: true,
  },
  [SETTINGS.CHILD_LOCK]: {
    id: 'child-lock',
    name: { en: 'Child lock', fr: 'Sécurité enfant' },
    ...binarySwitch(DEVICE_FEATURE_CATEGORIES.CHILD_LOCK),
    type: DEVICE_FEATURE_TYPES.CHILD_LOCK.BINARY,
  },
  [SETTINGS.LIGHTING]: {
    id: 'light',
    name: { en: 'Light', fr: 'Éclairage' },
    ...binarySwitch(DEVICE_FEATURE_CATEGORIES.LIGHT),
    type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
  },
  [SETTINGS.LIGHTING_BRIGHTNESS]: {
    id: 'light-brightness',
    name: { en: 'Light brightness', fr: "Luminosité de l'éclairage" },
    ...brightnessSetting,
  },
  [SETTINGS.AMBIENT_LIGHT_ENABLED]: {
    id: 'ambient-light',
    name: { en: 'Ambient light', fr: 'Éclairage d’ambiance' },
    ...binarySwitch(DEVICE_FEATURE_CATEGORIES.LIGHT),
    type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
    decode: decodeBoolean,
  },
  [SETTINGS.AMBIENT_LIGHT_BRIGHTNESS]: {
    id: 'ambient-light-brightness',
    name: { en: 'Ambient light brightness', fr: "Luminosité d'ambiance" },
    ...brightnessSetting,
  },
  [SETTINGS.INTERNAL_LIGHT_POWER]: {
    id: 'internal-light',
    name: { en: 'Internal light', fr: 'Éclairage intérieur' },
    ...binarySwitch(DEVICE_FEATURE_CATEGORIES.LIGHT),
    type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
  },
  [SETTINGS.INTERNAL_LIGHT_BRIGHTNESS]: {
    id: 'internal-light-brightness',
    name: { en: 'Internal light brightness', fr: 'Luminosité intérieure' },
    ...brightnessSetting,
  },
  [SETTINGS.EXTERNAL_LIGHT_POWER]: {
    id: 'external-light',
    name: { en: 'External light', fr: 'Éclairage extérieur' },
    ...binarySwitch(DEVICE_FEATURE_CATEGORIES.LIGHT),
    type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
  },
  [SETTINGS.FRIDGE_SETPOINT]: {
    id: 'fridge-setpoint',
    name: { en: 'Refrigerator setpoint', fr: 'Consigne réfrigérateur' },
    ...temperatureSetpoint,
    min: 0,
    max: 15,
  },
  [SETTINGS.FREEZER_SETPOINT]: {
    id: 'freezer-setpoint',
    name: { en: 'Freezer setpoint', fr: 'Consigne congélateur' },
    ...temperatureSetpoint,
    min: -30,
    max: -5,
  },
  [SETTINGS.WINE_COMPARTMENT_SETPOINT]: {
    id: 'wine-setpoint',
    name: { en: 'Wine compartment setpoint', fr: 'Consigne cave à vin' },
    ...temperatureSetpoint,
    min: 5,
    max: 20,
  },
  [SETTINGS.BOTTLE_COOLER_SETPOINT]: {
    id: 'bottle-cooler-setpoint',
    name: { en: 'Bottle cooler setpoint', fr: 'Consigne rafraîchisseur' },
    ...temperatureSetpoint,
    min: 0,
    max: 15,
  },
  [SETTINGS.CHILLER_SETPOINT]: {
    id: 'chiller-setpoint',
    name: { en: 'Chiller setpoint', fr: 'Consigne compartiment frais' },
    ...temperatureSetpoint,
    min: -5,
    max: 15,
  },
  [SETTINGS.FRIDGE_SUPER_MODE]: {
    id: 'fridge-super-mode',
    name: { en: 'Refrigerator super mode', fr: 'Super réfrigération' },
    ...binarySwitch(),
  },
  [SETTINGS.FREEZER_SUPER_MODE]: {
    id: 'freezer-super-mode',
    name: { en: 'Freezer super mode', fr: 'Super congélation' },
    ...binarySwitch(),
  },
  [SETTINGS.ECO_MODE]: {
    id: 'eco-mode',
    name: { en: 'Eco mode', fr: 'Mode éco' },
    ...binarySwitch(),
  },
  [SETTINGS.VACATION_MODE]: {
    id: 'vacation-mode',
    name: { en: 'Holiday mode', fr: 'Mode vacances' },
    ...binarySwitch(),
  },
  [SETTINGS.SABBATH_MODE]: {
    id: 'sabbath-mode',
    name: { en: 'Sabbath mode', fr: 'Mode Sabbat' },
    ...binarySwitch(),
  },
  [SETTINGS.FRESH_MODE]: {
    id: 'fresh-mode',
    name: { en: 'Fresh mode', fr: 'Mode fraîcheur' },
    ...binarySwitch(),
  },
  [SETTINGS.DISPENSER_ENABLED]: {
    id: 'dispenser',
    name: { en: 'Ice/water dispenser', fr: 'Distributeur glace/eau' },
    ...binarySwitch(),
  },
};

// --- Statuses ----------------------------------------------------------------

export const STATUS_FEATURES = {
  [STATUSES.OPERATION_STATE]: {
    id: 'operation-state',
    name: { en: 'Operation state', fr: 'État de fonctionnement' },
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    readOnly: true,
    min: 0,
    max: 0,
    decode: decodeText,
  },
  [STATUSES.DOOR_STATE]: {
    id: 'door',
    name: { en: 'Door', fr: 'Porte' },
    ...binarySensor(DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR),
    // Gladys reads an opening sensor the closed way round: 0 is "Open", 1 is
    // "Closed". So the state that maps to 1 is CLOSED, not OPEN — and Locked is
    // a closed door the appliance additionally bolted, still closed.
    decode: decodeEnumBinary(DOOR_STATE.CLOSED, DOOR_STATE.LOCKED),
  },
  [STATUSES.REMOTE_CONTROL_ACTIVE]: {
    id: 'remote-control-active',
    name: { en: 'Remote control allowed', fr: 'Commande à distance autorisée' },
    ...binarySensor(),
    decode: decodeBoolean,
  },
  [STATUSES.REMOTE_CONTROL_START_ALLOWED]: {
    id: 'remote-start-allowed',
    name: { en: 'Remote start allowed', fr: 'Démarrage à distance autorisé' },
    ...binarySensor(),
    decode: decodeBoolean,
  },
  [STATUSES.LOCAL_CONTROL_ACTIVE]: {
    id: 'local-control-active',
    name: { en: 'Being operated locally', fr: 'Utilisé sur place' },
    ...binarySensor(),
    decode: decodeBoolean,
  },
  [STATUSES.BATTERY_LEVEL]: {
    id: 'battery',
    name: { en: 'Battery', fr: 'Batterie' },
    category: DEVICE_FEATURE_CATEGORIES.BATTERY,
    type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
    unit: DEVICE_FEATURE_UNITS.PERCENT,
    readOnly: true,
    min: 0,
    max: 100,
    decode: decodeInteger,
  },
  [STATUSES.OVEN_CAVITY_TEMPERATURE]: {
    id: 'cavity-temperature',
    name: { en: 'Cavity temperature', fr: 'Température du four' },
    ...temperatureSensor,
    min: 0,
    max: 500,
  },
  [STATUSES.DOOR_REFRIGERATOR]: {
    id: 'door-refrigerator',
    name: { en: 'Refrigerator door', fr: 'Porte du réfrigérateur' },
    ...binarySensor(DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR),
    // Same polarity as the appliance door above: 1 is the CLOSED compartment.
    decode: decodeEnumBinary(REFRIGERATION_DOOR_STATE.CLOSED),
  },
  [STATUSES.DOOR_FREEZER]: {
    id: 'door-freezer',
    name: { en: 'Freezer door', fr: 'Porte du congélateur' },
    ...binarySensor(DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR),
    // Same polarity as the appliance door above: 1 is the CLOSED compartment.
    decode: decodeEnumBinary(REFRIGERATION_DOOR_STATE.CLOSED),
  },
  [STATUSES.DOOR_BOTTLE_COOLER]: {
    id: 'door-bottle-cooler',
    name: { en: 'Bottle cooler door', fr: 'Porte du rafraîchisseur' },
    ...binarySensor(DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR),
    // Same polarity as the appliance door above: 1 is the CLOSED compartment.
    decode: decodeEnumBinary(REFRIGERATION_DOOR_STATE.CLOSED),
  },
  [STATUSES.DOOR_CHILLER]: {
    id: 'door-chiller',
    name: { en: 'Chiller door', fr: 'Porte du compartiment frais' },
    ...binarySensor(DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR),
    // Same polarity as the appliance door above: 1 is the CLOSED compartment.
    decode: decodeEnumBinary(REFRIGERATION_DOOR_STATE.CLOSED),
  },
  [STATUSES.DOOR_WINE_COMPARTMENT]: {
    id: 'door-wine',
    name: { en: 'Wine compartment door', fr: 'Porte de la cave à vin' },
    ...binarySensor(DEVICE_FEATURE_CATEGORIES.OPENING_SENSOR),
    // Same polarity as the appliance door above: 1 is the CLOSED compartment.
    decode: decodeEnumBinary(REFRIGERATION_DOOR_STATE.CLOSED),
  },
  [STATUSES.COFFEE_COUNTER]: {
    id: 'counter-coffee',
    name: { en: 'Coffees served', fr: 'Cafés servis' },
    ...counterSensor,
  },
  [STATUSES.ESPRESSO_COUNTER]: {
    id: 'counter-espresso',
    name: { en: 'Espressos served', fr: 'Espressos servis' },
    ...counterSensor,
  },
  [STATUSES.HOT_WATER_COUNTER]: {
    id: 'counter-hot-water',
    name: { en: 'Hot waters served', fr: 'Eaux chaudes servies' },
    ...counterSensor,
  },
  [STATUSES.FROTHY_MILK_COUNTER]: {
    id: 'counter-frothy-milk',
    name: { en: 'Frothy milks served', fr: 'Laits moussés servis' },
    ...counterSensor,
  },
  [STATUSES.POWDER_COFFEE_COUNTER]: {
    id: 'counter-powder-coffee',
    name: { en: 'Ground coffees served', fr: 'Cafés moulus servis' },
    ...counterSensor,
  },
};

// --- Program options ---------------------------------------------------------
// Options only carry a value while a program is loaded. They are offered to
// every appliance that has programs at all (`hasPrograms` below), because an
// appliance sitting idle at discovery time would otherwise never get the
// features it publishes the moment its first program starts.

export const OPTION_FEATURES = {
  [OPTIONS.REMAINING_PROGRAM_TIME]: {
    id: 'remaining-time',
    name: { en: 'Remaining time', fr: 'Temps restant' },
    ...durationSensor,
    core: true,
  },
  [OPTIONS.ELAPSED_PROGRAM_TIME]: {
    id: 'elapsed-time',
    name: { en: 'Elapsed time', fr: 'Temps écoulé' },
    ...durationSensor,
    core: true,
  },
  [OPTIONS.PROGRAM_PROGRESS]: {
    id: 'program-progress',
    name: { en: 'Program progress', fr: 'Progression du programme' },
    ...percentSensor,
    core: true,
  },
  [OPTIONS.DURATION]: {
    id: 'program-duration',
    name: { en: 'Program duration', fr: 'Durée du programme' },
    ...durationSensor,
  },
  [OPTIONS.START_IN_RELATIVE]: {
    id: 'start-in',
    name: { en: 'Starts in', fr: 'Démarre dans' },
    ...durationSensor,
  },
  [OPTIONS.FINISH_IN_RELATIVE]: {
    id: 'finish-in',
    name: { en: 'Finishes in', fr: 'Se termine dans' },
    ...durationSensor,
  },
  [OPTIONS.ENERGY_FORECAST]: {
    id: 'energy-forecast',
    name: { en: 'Energy forecast', fr: "Prévision d'énergie" },
    ...percentSensor,
  },
  [OPTIONS.WATER_FORECAST]: {
    id: 'water-forecast',
    name: { en: 'Water forecast', fr: "Prévision d'eau" },
    ...percentSensor,
  },
  [OPTIONS.OVEN_SETPOINT_TEMPERATURE]: {
    id: 'program-setpoint',
    name: { en: 'Program setpoint', fr: 'Consigne du programme' },
    ...temperatureSensor,
    min: 0,
    max: 500,
  },
  [OPTIONS.HOOD_VENTING_LEVEL]: {
    id: 'venting-level',
    name: { en: 'Venting level', fr: "Niveau d'aspiration" },
    category: DEVICE_FEATURE_CATEGORIES.FAN,
    type: DEVICE_FEATURE_TYPES.FAN.SPEED,
    readOnly: true,
    min: 0,
    max: 5,
    // `Cooking.Hood.EnumType.Stage.FanStage03` -> 3, `FanOff` -> 0.
    decode: (value) => {
      const tail = shortName(value);
      const match = /(\d+)$/.exec(tail);
      return match ? Number(match[1]) : 0;
    },
  },
  [OPTIONS.HOOD_INTENSIVE_LEVEL]: {
    id: 'intensive-level',
    name: { en: 'Intensive level', fr: 'Niveau intensif' },
    category: DEVICE_FEATURE_CATEGORIES.FAN,
    type: DEVICE_FEATURE_TYPES.FAN.SPEED,
    readOnly: true,
    min: 0,
    max: 2,
    decode: (value) => {
      const match = /(\d+)$/.exec(shortName(value));
      return match ? Number(match[1]) : 0;
    },
  },
  [OPTIONS.WASHER_TEMPERATURE]: {
    id: 'washer-temperature',
    name: { en: 'Wash temperature', fr: 'Température de lavage' },
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    readOnly: true,
    min: 0,
    max: 0,
    decode: decodeText,
  },
  [OPTIONS.WASHER_SPIN_SPEED]: {
    id: 'washer-spin-speed',
    name: { en: 'Spin speed', fr: 'Vitesse d’essorage' },
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    readOnly: true,
    min: 0,
    max: 0,
    decode: decodeText,
  },
  [OPTIONS.DRYER_DRYING_TARGET]: {
    id: 'drying-target',
    name: { en: 'Drying target', fr: 'Niveau de séchage' },
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    readOnly: true,
    min: 0,
    max: 0,
    decode: decodeText,
  },
};

// --- Events ------------------------------------------------------------------
// Home Connect never lists the events an appliance can raise, so unlike
// settings/statuses these cannot be discovered — they are declared per
// appliance type. `appliesTo: null` means "every appliance".

export const EVENT_FEATURES = {
  [EVENTS.PROGRAM_FINISHED]: {
    id: 'event-program-finished',
    name: { en: 'Program finished', fr: 'Programme terminé' },
    ...eventSensor,
    appliesTo: null,
  },
  [EVENTS.PROGRAM_ABORTED]: {
    id: 'event-program-aborted',
    name: { en: 'Program aborted', fr: 'Programme interrompu' },
    ...eventSensor,
    appliesTo: null,
  },
  [EVENTS.ALARM_CLOCK_ELAPSED]: {
    id: 'event-alarm-clock',
    name: { en: 'Timer elapsed', fr: 'Minuteur écoulé' },
    ...eventSensor,
    appliesTo: ['Oven', 'Hob', 'CookProcessor'],
  },
  [EVENTS.PREHEAT_FINISHED]: {
    id: 'event-preheat-finished',
    name: { en: 'Preheating finished', fr: 'Préchauffage terminé' },
    ...eventSensor,
    appliesTo: ['Oven'],
  },
  [EVENTS.REGULAR_PREHEAT_FINISHED]: {
    id: 'event-regular-preheat-finished',
    name: { en: 'Regular preheating finished', fr: 'Préchauffage standard terminé' },
    ...eventSensor,
    appliesTo: ['Oven'],
  },
  [EVENTS.GREASE_FILTER_NEARLY_SATURATED]: {
    id: 'event-grease-filter-nearly-saturated',
    name: { en: 'Grease filter nearly saturated', fr: 'Filtre à graisse presque saturé' },
    ...eventSensor,
    appliesTo: ['Hood'],
  },
  [EVENTS.GREASE_FILTER_SATURATED]: {
    id: 'event-grease-filter-saturated',
    name: { en: 'Grease filter saturated', fr: 'Filtre à graisse saturé' },
    ...eventSensor,
    appliesTo: ['Hood'],
  },
  [EVENTS.SALT_NEARLY_EMPTY]: {
    id: 'event-salt-nearly-empty',
    name: { en: 'Salt nearly empty', fr: 'Sel presque vide' },
    ...eventSensor,
    appliesTo: ['Dishwasher'],
  },
  [EVENTS.RINSE_AID_NEARLY_EMPTY]: {
    id: 'event-rinse-aid-nearly-empty',
    name: { en: 'Rinse aid nearly empty', fr: 'Liquide de rinçage presque vide' },
    ...eventSensor,
    appliesTo: ['Dishwasher'],
  },
  [EVENTS.BEAN_CONTAINER_EMPTY]: {
    id: 'event-bean-container-empty',
    name: { en: 'Bean container empty', fr: 'Bac à grains vide' },
    ...eventSensor,
    appliesTo: ['CoffeeMaker'],
  },
  [EVENTS.WATER_TANK_EMPTY]: {
    id: 'event-water-tank-empty',
    name: { en: 'Water tank empty', fr: "Réservoir d'eau vide" },
    ...eventSensor,
    appliesTo: ['CoffeeMaker'],
  },
  [EVENTS.DRIP_TRAY_FULL]: {
    id: 'event-drip-tray-full',
    name: { en: 'Drip tray full', fr: 'Bac récolte-gouttes plein' },
    ...eventSensor,
    appliesTo: ['CoffeeMaker'],
  },
  [EVENTS.IDOS1_FILL_LEVEL_POOR]: {
    id: 'event-idos1-low',
    name: { en: 'i-Dos 1 nearly empty', fr: 'i-Dos 1 presque vide' },
    ...eventSensor,
    appliesTo: ['Washer', 'WasherDryer'],
  },
  [EVENTS.IDOS2_FILL_LEVEL_POOR]: {
    id: 'event-idos2-low',
    name: { en: 'i-Dos 2 nearly empty', fr: 'i-Dos 2 presque vide' },
    ...eventSensor,
    appliesTo: ['Washer', 'WasherDryer'],
  },
  [EVENTS.DOOR_ALARM_FREEZER]: {
    id: 'event-door-alarm-freezer',
    name: { en: 'Freezer door alarm', fr: 'Alarme porte congélateur' },
    ...eventSensor,
    appliesTo: ['FridgeFreezer', 'Freezer'],
  },
  [EVENTS.DOOR_ALARM_REFRIGERATOR]: {
    id: 'event-door-alarm-refrigerator',
    name: { en: 'Refrigerator door alarm', fr: 'Alarme porte réfrigérateur' },
    ...eventSensor,
    appliesTo: ['FridgeFreezer', 'Refrigerator'],
  },
  [EVENTS.TEMPERATURE_ALARM_FREEZER]: {
    id: 'event-temperature-alarm-freezer',
    name: { en: 'Freezer temperature alarm', fr: 'Alarme température congélateur' },
    ...eventSensor,
    appliesTo: ['FridgeFreezer', 'Freezer'],
  },
  [EVENTS.EMPTY_DUST_BOX]: {
    id: 'event-empty-dust-box',
    name: { en: 'Dust box full', fr: 'Bac à poussière plein' },
    ...eventSensor,
    appliesTo: ['CleaningRobot'],
  },
  [EVENTS.ROBOT_IS_STUCK]: {
    id: 'event-robot-stuck',
    name: { en: 'Robot stuck', fr: 'Robot bloqué' },
    ...eventSensor,
    appliesTo: ['CleaningRobot'],
  },
  [EVENTS.DOCKING_STATION_NOT_FOUND]: {
    id: 'event-docking-station-not-found',
    name: { en: 'Docking station not found', fr: 'Station de charge introuvable' },
    ...eventSensor,
    appliesTo: ['CleaningRobot'],
  },
};

// --- Synthetic features ------------------------------------------------------
// These have no single Home Connect key behind them: they are the useful view
// Gladys wants (a switch to run the program, the program name as text, a
// reachability flag) built from several keys or from the appliance envelope.

/** Feature id of the program on/off switch, referenced by the dispatcher. */
export const PROGRAM_SWITCH_ID = 'program';

export const SYNTHETIC_FEATURES = {
  [PROGRAM_SWITCH_ID]: {
    id: PROGRAM_SWITCH_ID,
    name: { en: 'Program running', fr: 'Programme en cours' },
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    readOnly: false,
    min: 0,
    max: 1,
    write: 'program',
    // Derived from the operation state rather than from the presence of an
    // active program: an appliance in DelayedStart has no active program yet
    // but is very much committed to running one.
    decode: (operationState) => (RUNNING_OPERATION_STATES.has(operationState) ? 1 : 0),
  },
  'active-program': {
    id: 'active-program',
    name: { en: 'Active program', fr: 'Programme actif' },
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    readOnly: true,
    min: 0,
    max: 0,
    decode: decodeText,
  },
  'selected-program': {
    id: 'selected-program',
    name: { en: 'Selected program', fr: 'Programme sélectionné' },
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
    readOnly: true,
    min: 0,
    max: 0,
    decode: decodeText,
  },
  connected: {
    id: 'connected',
    name: { en: 'Connected', fr: 'Connecté' },
    ...binarySensor(),
    decode: decodeBoolean,
  },
};

/** The two Home Connect roots that feed the program text features. */
export const ROOT_FEATURE_IDS = {
  [ROOT.ACTIVE_PROGRAM]: 'active-program',
  [ROOT.SELECTED_PROGRAM]: 'selected-program',
};

/**
 * Appliance types that run programs. Anything else (a plain refrigerator, a
 * wine cooler) gets no program switch and no program option features.
 */
const APPLIANCES_WITH_PROGRAMS = new Set([
  'AirConditioner',
  'CleaningRobot',
  'CoffeeMaker',
  'CookProcessor',
  'Dishwasher',
  'Dryer',
  'Hob',
  'Hood',
  'Microwave',
  'Oven',
  'WarmingDrawer',
  'Washer',
  'WasherDryer',
]);

/** @param {string} applianceType Home Connect `type` of the appliance */
export function hasPrograms(applianceType) {
  return APPLIANCES_WITH_PROGRAMS.has(applianceType);
}

/**
 * Whether an event feature is offered to this appliance type.
 * @param {{appliesTo: string[]|null}} entry
 * @param {string} applianceType
 */
export function eventAppliesTo(entry, applianceType) {
  return entry.appliesTo === null || entry.appliesTo.includes(applianceType);
}

/**
 * Home Connect unit string -> Gladys unit constant. Home Connect answers
 * `"°C"`, `"%"`, `"seconds"`… — mapping it lets a US appliance reporting °F
 * keep its own unit instead of being mislabelled.
 * @param {string|undefined} unit
 * @returns {string|undefined}
 */
export function mapUnit(unit) {
  switch (unit) {
    case '°C':
      return DEVICE_FEATURE_UNITS.CELSIUS;
    case '°F':
      return DEVICE_FEATURE_UNITS.FAHRENHEIT;
    case '%':
      return DEVICE_FEATURE_UNITS.PERCENT;
    case 'seconds':
      return DEVICE_FEATURE_UNITS.SECONDS;
    case 'ml':
      return DEVICE_FEATURE_UNITS.MILLILITER;
    default:
      return undefined;
  }
}
