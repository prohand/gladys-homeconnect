// -----------------------------------------------------------------------------
// Scene triggers and actions (Gladys 5.1).
//
// Gladys 5.1 lets an integration extend the scene editor without a core
// update: the manifest declares what can HAPPEN (`scene_triggers`) and what a
// scene can DO (`scene_actions`), the core renders the cards, matches the
// events against the filters the scene author filled in, and relays the
// actions. The integration never learns which scenes exist.
//
// The line this module holds:
//
//   - a VALUE is a device feature (the registry publishes states for that);
//     "the dishwasher is running" is a feature, and a scene reads it as a
//     condition. Nothing of the sort is fired here.
//   - an EVENT says "this happened, with these details": a program finished,
//     on THIS appliance, with THAT program name. Those details exist nowhere
//     in the feature world — a binary "program finished" sensor cannot carry
//     the program name — which is exactly what a scene trigger is for.
//
// Home Connect gives both on the same Server-Sent-Events stream, so the
// registry hands every event here BEFORE it merges it into the snapshot: the
// previous operation state is what tells a start from a state being restated.
//
// Only the stream fires triggers — never a poll, never a full account read.
// Those replace the snapshot wholesale, and a fresh container holds no previous
// state at all: firing from there would announce "the oven just started" for
// every appliance already running at boot. A start missed during the few
// seconds the cloud takes to reopen the stream is the price, and it is the
// right one to pay.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  COMMANDS,
  EVENTS,
  EVENT_PRESENT_STATE,
  RUNNING_OPERATION_STATES,
  STATUSES,
  shortName,
} from './homeconnect/constants.js';
import { EVENT_FEATURES } from './mapping/catalog.js';
import { snapshotValues } from './mapping/appliance.js';
import { describeAppliance, pick } from './mapping/describe.js';

const logger = createLogger({ name: 'scenes' });

/** Trigger keys, as declared in `scene_triggers` of the manifest. */
export const SCENE_TRIGGERS = {
  PROGRAM_STARTED: 'program_started',
  PROGRAM_FINISHED: 'program_finished',
  PROGRAM_ABORTED: 'program_aborted',
  NOTIFICATION: 'appliance_notification',
};

/** Action keys, as declared in `scene_actions` of the manifest. */
export const SCENE_ACTIONS = {
  START: 'start_program',
  STOP: 'stop_program',
  PAUSE: 'pause_program',
  RESUME: 'resume_program',
  STATUS: 'appliance_status',
};

// The two events that have their own trigger: everything else in the catalog
// is relayed through the generic "notification" one.
const DEDICATED_EVENTS = new Set([EVENTS.PROGRAM_FINISHED, EVENTS.PROGRAM_ABORTED]);

// A Home Connect event key carries its own lifecycle: `Present` when it is
// raised, `Off` / `Confirmed` when it is cleared or acknowledged. Only the
// raising edge is an event worth a scene — the rest is the alert going away.
const CLEARED_STATES = new Set([EVENT_PRESENT_STATE.OFF, EVENT_PRESENT_STATE.CONFIRMED]);

export class SceneBridge {
  /**
   * @param {object} options
   * @param {object} options.gladys SDK instance
   * @param {import('./homeconnect/api.js').HomeConnectApi} options.api
   * @param {import('./appliances.js').ApplianceRegistry} options.registry
   * @param {() => object} options.getConfig
   */
  constructor({ gladys, api, registry, getConfig }) {
    this.gladys = gladys;
    this.api = api;
    this.registry = registry;
    this.getConfig = getConfig;
  }

  /** Register the five scene actions. Call it BEFORE `connect()`. */
  register() {
    this.gladys.onSceneAction(SCENE_ACTIONS.START, (fields) => this.startProgram(fields));
    this.gladys.onSceneAction(SCENE_ACTIONS.STOP, (fields) => this.stopProgram(fields));
    this.gladys.onSceneAction(SCENE_ACTIONS.PAUSE, (fields) =>
      this.command(fields, COMMANDS.PAUSE_PROGRAM),
    );
    this.gladys.onSceneAction(SCENE_ACTIONS.RESUME, (fields) =>
      this.command(fields, COMMANDS.RESUME_PROGRAM),
    );
    this.gladys.onSceneAction(SCENE_ACTIONS.STATUS, (fields) => this.readStatus(fields));
  }

  // --- Triggers --------------------------------------------------------------

  /**
   * One Home Connect stream event, seen BEFORE the registry merges it into the
   * snapshot: `snapshot` still holds the previous values, which is what turns
   * "the operation state is Run" into "a program just started".
   *
   * Never throws: a trigger that cannot be fired must not break the state
   * publishing that follows it on the same event.
   *
   * @param {import('./homeconnect/events.js').HomeConnectEvent} event
   * @param {object} snapshot appliance snapshot, still un-updated
   */
  async handleApplianceEvent(event, snapshot) {
    try {
      const payload = this.buildTrigger(event, snapshot);
      if (!payload) {
        return;
      }
      logger.info(`Scene trigger ${payload.key} for ${snapshot.haId}`);
      await this.gladys.publishSceneEvent(payload.key, payload.data);
    } catch (err) {
      logger.error(`Could not fire the scene trigger of ${snapshot?.haId}`, err);
    }
  }

  /**
   * Which trigger — if any — this event fires.
   * @returns {{key: string, data: object}|null}
   */
  buildTrigger(event, snapshot) {
    if (!event?.key) {
      return null;
    }

    if (DEDICATED_EVENTS.has(event.key)) {
      if (CLEARED_STATES.has(event.value)) {
        return null;
      }
      return {
        key:
          event.key === EVENTS.PROGRAM_FINISHED
            ? SCENE_TRIGGERS.PROGRAM_FINISHED
            : SCENE_TRIGGERS.PROGRAM_ABORTED,
        data: this.programData(snapshot),
      };
    }

    const notification = EVENT_FEATURES[event.key];
    if (notification) {
      if (CLEARED_STATES.has(event.value)) {
        return null;
      }
      return {
        key: SCENE_TRIGGERS.NOTIFICATION,
        data: {
          ...this.applianceData(snapshot),
          notification: notification.id,
          notification_name: pick(this.getConfig().language, notification.name),
        },
      };
    }

    // A program start is a TRANSITION, not a state: Home Connect restates the
    // operation state on every reconnection and after every full read, and a
    // scene that notifies "the washing machine started" must not fire again
    // because the stream hiccupped.
    if (event.key === STATUSES.OPERATION_STATE) {
      const previous = snapshotValues(snapshot).get(STATUSES.OPERATION_STATE);
      if (RUNNING_OPERATION_STATES.has(event.value) && !RUNNING_OPERATION_STATES.has(previous)) {
        return { key: SCENE_TRIGGERS.PROGRAM_STARTED, data: this.programData(snapshot) };
      }
    }

    return null;
  }

  /** The flat data every appliance trigger carries. */
  applianceData(snapshot) {
    return {
      appliance: this.registry.deviceExternalId(snapshot.haId),
      appliance_name: snapshot.name ?? '',
      appliance_type: snapshot.type ?? '',
    };
  }

  /** Appliance data plus the program the event is about. */
  programData(snapshot) {
    const programKey = snapshot.activeProgram?.key ?? snapshot.selectedProgram?.key ?? null;
    return {
      ...this.applianceData(snapshot),
      program: programKey ? shortName(programKey) : null,
      program_key: programKey,
    };
  }

  // --- Actions ---------------------------------------------------------------

  /**
   * Resolve the `appliance` field — the external_id of a device the user
   * created — into the appliance the registry holds.
   *
   * Throwing here fails THIS action and nothing else: Gladys logs it and the
   * scene carries on, which is the documented behaviour of a scene action.
   * @param {object} fields resolved fields of the action
   */
  resolve(fields) {
    const externalId = String(fields?.appliance ?? '');
    const entry = this.registry.findByDeviceExternalId(externalId);
    if (!entry) {
      throw new Error(`Unknown Home Connect appliance: ${externalId || '(none selected)'}`);
    }
    return entry;
  }

  /** Same, plus the "it has to be reachable to be commanded" check. */
  resolveOnline(fields) {
    const entry = this.resolve(fields);
    if (entry.snapshot.connected === false) {
      throw new Error(`${entry.snapshot.name} is offline in Home Connect`);
    }
    return entry;
  }

  async startProgram(fields) {
    const { haId } = this.resolveOnline(fields);
    logger.info(`Scene action: starting the selected program of ${haId}`);
    // Home Connect refuses with its own wording ("Remote start is not
    // enabled"), which is what the scene log should show — so no rewrapping.
    const programKey = await this.api.startSelectedProgram(haId);
    return { program: shortName(programKey), program_key: programKey };
  }

  async stopProgram(fields) {
    const { haId } = this.resolveOnline(fields);
    logger.info(`Scene action: stopping the program of ${haId}`);
    await this.api.stopProgram(haId);
  }

  async command(fields, commandKey) {
    const { haId } = this.resolveOnline(fields);
    logger.info(`Scene action: ${commandKey} on ${haId}`);
    await this.api.putCommand(haId, commandKey);
  }

  /**
   * Answer with what the appliance is doing, for the following actions of the
   * scene to use ({{...}} in a notification text, a condition on `running`).
   *
   * Read from the snapshot, not from Home Connect: the event stream keeps it
   * within a second of the truth and a scene that runs every ten minutes must
   * not cost a request each time — the daily quota is the user's, not ours.
   */
  async readStatus(fields) {
    const { snapshot } = this.resolve(fields);
    const language = this.getConfig().language;
    const description = describeAppliance(snapshot, language);
    return {
      state: description.state,
      state_label: description.stateLabel,
      program: description.program,
      running: description.running,
      remaining_seconds: description.remainingSeconds ?? 0,
      remaining_label: description.remainingLabel,
      progress: description.progress ?? 0,
      door: description.doorLabel,
      connected: description.connected,
      summary: `${description.name}${language === 'fr' ? ' : ' : ': '}${description.headline}`,
    };
  }
}
