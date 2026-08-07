// -----------------------------------------------------------------------------
// Home Connect protocol constants.
//
// Home Connect (BSH: Bosch, Siemens, Neff, Gaggenau, Constructa, Thermador,
// Balay, Profilo) exposes every appliance through ONE cloud REST API. Nothing
// is local: an appliance that is not linked to the user's Home Connect account
// simply does not exist for this integration.
//
// Everything the appliance publishes is a dotted key with a stable, documented
// shape:
//
//   <Domain>.<Sub>.<Kind>.<Name>          e.g. BSH.Common.Status.DoorState
//   <Domain>.<Sub>.EnumType.<Name>.<Value> e.g. BSH.Common.EnumType.DoorState.Open
//
// `Kind` is one of Setting (writable), Status (read-only), Option (attached to
// a program), Event (transient notification), Command (write-only trigger) or
// Root (the active/selected program itself). The mapping catalog in
// ../mapping/catalog.js keys off those strings, so they all live here.
// -----------------------------------------------------------------------------

export const PRODUCTION_BASE_URL = 'https://api.home-connect.com';
export const SIMULATOR_BASE_URL = 'https://simulator.home-connect.com';

export const OAUTH_AUTHORIZE_PATH = '/security/oauth/authorize';
export const OAUTH_TOKEN_PATH = '/security/oauth/token';

// `IdentifyAppliance` is mandatory for every call; the three others are the
// "columns" of the Home Connect scope matrix, granting Monitor/Settings/Control
// on every appliance family the user owns.
export const DEFAULT_SCOPE = 'IdentifyAppliance Monitor Settings Control';

// Home Connect answers `application/vnd.bsh.sdk.v1+json`, not plain JSON.
export const BSH_JSON_V1 = 'application/vnd.bsh.sdk.v1+json';

export const API_PATH = '/api/homeappliances';

// --- Settings (writable) -----------------------------------------------------
export const SETTINGS = {
  POWER_STATE: 'BSH.Common.Setting.PowerState',
  CHILD_LOCK: 'BSH.Common.Setting.ChildLock',
  ALARM_CLOCK: 'BSH.Common.Setting.AlarmClock',
  AMBIENT_LIGHT_ENABLED: 'BSH.Common.Setting.AmbientLightEnabled',
  AMBIENT_LIGHT_BRIGHTNESS: 'BSH.Common.Setting.AmbientLightBrightness',
  LIGHTING: 'Cooking.Common.Setting.Lighting',
  LIGHTING_BRIGHTNESS: 'Cooking.Common.Setting.LightingBrightness',
  FRIDGE_SETPOINT: 'Refrigeration.FridgeFreezer.Setting.SetpointTemperatureRefrigerator',
  FREEZER_SETPOINT: 'Refrigeration.FridgeFreezer.Setting.SetpointTemperatureFreezer',
  FRIDGE_SUPER_MODE: 'Refrigeration.FridgeFreezer.Setting.SuperModeRefrigerator',
  FREEZER_SUPER_MODE: 'Refrigeration.FridgeFreezer.Setting.SuperModeFreezer',
  ECO_MODE: 'Refrigeration.Common.Setting.EcoMode',
  VACATION_MODE: 'Refrigeration.Common.Setting.VacationMode',
  SABBATH_MODE: 'Refrigeration.Common.Setting.SabbathMode',
  FRESH_MODE: 'Refrigeration.Common.Setting.FreshMode',
  DISPENSER_ENABLED: 'Refrigeration.Common.Setting.Dispenser.Enabled',
  INTERNAL_LIGHT_POWER: 'Refrigeration.Common.Setting.Light.Internal.Power',
  INTERNAL_LIGHT_BRIGHTNESS: 'Refrigeration.Common.Setting.Light.Internal.Brightness',
  EXTERNAL_LIGHT_POWER: 'Refrigeration.Common.Setting.Light.External.Power',
  WINE_COMPARTMENT_SETPOINT: 'Refrigeration.Common.Setting.WineCompartment.SetpointTemperature',
  BOTTLE_COOLER_SETPOINT: 'Refrigeration.Common.Setting.BottleCooler.SetpointTemperature',
  CHILLER_SETPOINT: 'Refrigeration.Common.Setting.ChillerCommon.SetpointTemperature',
};

// --- Statuses (read-only) ----------------------------------------------------
export const STATUSES = {
  OPERATION_STATE: 'BSH.Common.Status.OperationState',
  DOOR_STATE: 'BSH.Common.Status.DoorState',
  REMOTE_CONTROL_ACTIVE: 'BSH.Common.Status.RemoteControlActive',
  REMOTE_CONTROL_START_ALLOWED: 'BSH.Common.Status.RemoteControlStartAllowed',
  LOCAL_CONTROL_ACTIVE: 'BSH.Common.Status.LocalControlActive',
  BATTERY_LEVEL: 'BSH.Common.Status.BatteryLevel',
  OVEN_CAVITY_TEMPERATURE: 'Cooking.Oven.Status.CurrentCavityTemperature',
  DOOR_REFRIGERATOR: 'Refrigeration.Common.Status.Door.Refrigerator',
  DOOR_FREEZER: 'Refrigeration.Common.Status.Door.Freezer',
  DOOR_BOTTLE_COOLER: 'Refrigeration.Common.Status.Door.BottleCooler',
  DOOR_CHILLER: 'Refrigeration.Common.Status.Door.ChillerCommon',
  DOOR_WINE_COMPARTMENT: 'Refrigeration.Common.Status.Door.WineCompartment',
  COFFEE_COUNTER: 'ConsumerProducts.CoffeeMaker.Status.BeverageCounterCoffee',
  ESPRESSO_COUNTER: 'ConsumerProducts.CoffeeMaker.Status.BeverageCounterRistrettoEspresso',
  HOT_WATER_COUNTER: 'ConsumerProducts.CoffeeMaker.Status.BeverageCounterHotWater',
  FROTHY_MILK_COUNTER: 'ConsumerProducts.CoffeeMaker.Status.BeverageCounterFrothyMilk',
  POWDER_COFFEE_COUNTER: 'ConsumerProducts.CoffeeMaker.Status.BeverageCounterPowderCoffee',
};

// --- Program options ---------------------------------------------------------
// Options belong to the ACTIVE (or selected) program, not to the appliance:
// they only carry a value while a program is loaded, and the SSE stream pushes
// them as they change.
export const OPTIONS = {
  REMAINING_PROGRAM_TIME: 'BSH.Common.Option.RemainingProgramTime',
  ELAPSED_PROGRAM_TIME: 'BSH.Common.Option.ElapsedProgramTime',
  PROGRAM_PROGRESS: 'BSH.Common.Option.ProgramProgress',
  DURATION: 'BSH.Common.Option.Duration',
  START_IN_RELATIVE: 'BSH.Common.Option.StartInRelative',
  FINISH_IN_RELATIVE: 'BSH.Common.Option.FinishInRelative',
  ENERGY_FORECAST: 'BSH.Common.Option.EnergyForecast',
  WATER_FORECAST: 'BSH.Common.Option.WaterForecast',
  OVEN_SETPOINT_TEMPERATURE: 'Cooking.Oven.Option.SetpointTemperature',
  HOOD_VENTING_LEVEL: 'Cooking.Common.Option.Hood.VentingLevel',
  HOOD_INTENSIVE_LEVEL: 'Cooking.Common.Option.Hood.IntensiveLevel',
  WASHER_TEMPERATURE: 'LaundryCare.Washer.Option.Temperature',
  WASHER_SPIN_SPEED: 'LaundryCare.Washer.Option.SpinSpeed',
  DRYER_DRYING_TARGET: 'LaundryCare.Dryer.Option.DryingTarget',
};

// --- Events (transient notifications pushed on the SSE stream) ---------------
export const EVENTS = {
  PROGRAM_FINISHED: 'BSH.Common.Event.ProgramFinished',
  PROGRAM_ABORTED: 'BSH.Common.Event.ProgramAborted',
  ALARM_CLOCK_ELAPSED: 'BSH.Common.Event.AlarmClockElapsed',
  PREHEAT_FINISHED: 'Cooking.Oven.Event.PreheatFinished',
  REGULAR_PREHEAT_FINISHED: 'Cooking.Oven.Event.RegularPreheatFinished',
  GREASE_FILTER_NEARLY_SATURATED:
    'Cooking.Common.Event.Hood.GreaseFilterMaxSaturationNearlyReached',
  GREASE_FILTER_SATURATED: 'Cooking.Common.Event.Hood.GreaseFilterMaxSaturationReached',
  SALT_NEARLY_EMPTY: 'Dishcare.Dishwasher.Event.SaltNearlyEmpty',
  RINSE_AID_NEARLY_EMPTY: 'Dishcare.Dishwasher.Event.RinseAidNearlyEmpty',
  BEAN_CONTAINER_EMPTY: 'ConsumerProducts.CoffeeMaker.Event.BeanContainerEmpty',
  WATER_TANK_EMPTY: 'ConsumerProducts.CoffeeMaker.Event.WaterTankEmpty',
  DRIP_TRAY_FULL: 'ConsumerProducts.CoffeeMaker.Event.DripTrayFull',
  IDOS1_FILL_LEVEL_POOR: 'LaundryCare.Washer.Event.IDos1FillLevelPoor',
  IDOS2_FILL_LEVEL_POOR: 'LaundryCare.Washer.Event.IDos2FillLevelPoor',
  DOOR_ALARM_FREEZER: 'Refrigeration.FridgeFreezer.Event.DoorAlarmFreezer',
  DOOR_ALARM_REFRIGERATOR: 'Refrigeration.FridgeFreezer.Event.DoorAlarmRefrigerator',
  TEMPERATURE_ALARM_FREEZER: 'Refrigeration.FridgeFreezer.Event.TemperatureAlarmFreezer',
  EMPTY_DUST_BOX: 'ConsumerProducts.CleaningRobot.Event.EmptyDustBoxAndCleanFilter',
  ROBOT_IS_STUCK: 'ConsumerProducts.CleaningRobot.Event.RobotIsStuck',
  DOCKING_STATION_NOT_FOUND: 'ConsumerProducts.CleaningRobot.Event.DockingStationNotFound',
};

// --- Roots (the program itself) ----------------------------------------------
export const ROOT = {
  ACTIVE_PROGRAM: 'BSH.Common.Root.ActiveProgram',
  SELECTED_PROGRAM: 'BSH.Common.Root.SelectedProgram',
};

// --- Enum values we compare against ------------------------------------------
export const POWER_STATE = {
  ON: 'BSH.Common.EnumType.PowerState.On',
  OFF: 'BSH.Common.EnumType.PowerState.Off',
  STANDBY: 'BSH.Common.EnumType.PowerState.Standby',
};

export const DOOR_STATE = {
  OPEN: 'BSH.Common.EnumType.DoorState.Open',
  CLOSED: 'BSH.Common.EnumType.DoorState.Closed',
  LOCKED: 'BSH.Common.EnumType.DoorState.Locked',
};

// Refrigeration compartments report their door with their OWN enum, distinct
// from the appliance-level BSH.Common one.
export const REFRIGERATION_DOOR_STATE = {
  OPEN: 'Refrigeration.Common.EnumType.Door.States.Open',
  CLOSED: 'Refrigeration.Common.EnumType.Door.States.Closed',
};

export const OPERATION_STATE = {
  INACTIVE: 'BSH.Common.EnumType.OperationState.Inactive',
  READY: 'BSH.Common.EnumType.OperationState.Ready',
  DELAYED_START: 'BSH.Common.EnumType.OperationState.DelayedStart',
  RUN: 'BSH.Common.EnumType.OperationState.Run',
  PAUSE: 'BSH.Common.EnumType.OperationState.Pause',
  ACTION_REQUIRED: 'BSH.Common.EnumType.OperationState.ActionRequired',
  FINISHED: 'BSH.Common.EnumType.OperationState.Finished',
  ERROR: 'BSH.Common.EnumType.OperationState.Error',
  ABORTING: 'BSH.Common.EnumType.OperationState.Aborting',
};

// Operation states in which a program occupies the appliance. Used to derive
// the synthetic "program running" feature (see ../mapping/catalog.js).
export const RUNNING_OPERATION_STATES = new Set([
  OPERATION_STATE.DELAYED_START,
  OPERATION_STATE.RUN,
  OPERATION_STATE.PAUSE,
  OPERATION_STATE.ACTION_REQUIRED,
  OPERATION_STATE.ABORTING,
]);

export const EVENT_PRESENT_STATE = {
  PRESENT: 'BSH.Common.EnumType.EventPresentState.Present',
  OFF: 'BSH.Common.EnumType.EventPresentState.Off',
  CONFIRMED: 'BSH.Common.EnumType.EventPresentState.Confirmed',
};

// Commands are write-only triggers: PUT the key with `true`.
export const COMMANDS = {
  PAUSE_PROGRAM: 'BSH.Common.Command.PauseProgram',
  RESUME_PROGRAM: 'BSH.Common.Command.ResumeProgram',
};

// Server-Sent-Events types of the Home Connect event stream.
export const SSE_TYPES = {
  KEEP_ALIVE: 'KEEP-ALIVE',
  STATUS: 'STATUS',
  EVENT: 'EVENT',
  NOTIFY: 'NOTIFY',
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED',
  PAIRED: 'PAIRED',
  DEPAIRED: 'DEPAIRED',
};

/**
 * Short, human-readable tail of a Home Connect dotted key or enum value.
 * `BSH.Common.EnumType.OperationState.Run` -> `Run`, so a Gladys `text`
 * feature shows "Run" instead of a 45-character identifier.
 * @param {unknown} key
 * @returns {string}
 */
export function shortName(key) {
  if (typeof key !== 'string' || key.length === 0) {
    return '';
  }
  const parts = key.split('.');
  return parts[parts.length - 1];
}
