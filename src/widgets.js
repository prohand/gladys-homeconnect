// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1).
//
// Gladys 5.1 lets an integration put its own card on the dashboard without a
// core update: the manifest declares the widget identity, and the integration
// answers `widget.get` with a CONTENT in a declarative vocabulary — no HTML,
// no iframe, no CSS. The core owns the rendering, so theme, dark mode,
// responsiveness and translations come for free, and a card is always
// card-shaped: at most 8 components, 6 tiles, 1 status list, 4 buttons.
//
// Why a Home Connect widget at all, when every value is already a Gladys
// device feature: because the answer a user wants from a dishwasher is one
// sentence — "running, Auto 65 °C, 1 h 25 left" — and features give five
// separate chips that each say a third of it. The overview card goes further:
// it is the only place in Gladys that can show six appliances of one account
// side by side.
//
// Two rules shape what follows:
//   - ANYTHING LIVE IS A FEATURE. A tile bound to `device_feature` follows the
//     published states over the core's real-time path, with no re-pull and no
//     nudge: remaining time and progress are bound that way. Only what has no
//     feature (a sentence mixing state, program and time) is rendered as text.
//   - READ AND TAP. The widget shows and offers a couple of buttons; the
//     setpoints and switches stay in the core's device widgets, which already
//     render them properly.
// -----------------------------------------------------------------------------

import { createLogger, WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { OPTION_FEATURES, STATUS_FEATURES } from './mapping/catalog.js';
import { COMMANDS, OPTIONS, STATUSES } from './homeconnect/constants.js';
import { describeAppliance, truncate } from './mapping/describe.js';
import { hasCredentials } from './config.js';

const logger = createLogger({ name: 'widgets' });

/** Widget keys, as declared in `widgets` of the manifest. */
export const WIDGETS = {
  OVERVIEW: 'appliances',
  APPLIANCE: 'appliance',
};

/** Button action keys of the single-appliance widget. */
export const WIDGET_ACTIONS = {
  START: 'start',
  STOP: 'stop',
  PAUSE: 'pause',
  RESUME: 'resume',
};

// How fast the data moves. The stream pushes changes within a second and the
// live tiles follow the states on their own, so the pull is only there to
// re-word the sentence: a minute is plenty, and a nudge covers the rest.
const TTL_SECONDS = 60;

// A full account read publishes one batch of states per appliance, and each
// batch asks for a nudge. The core already drops everything past one per ten
// seconds per widget, so the burst is harmless — it is just noise on the
// socket. This is the local window that keeps it off the wire; a change landing
// inside it is not dropped but deferred to the end of the window, because the
// alternative is a card sitting on a stale sentence until its TTL expires.
const NUDGE_THROTTLE_MS = 2_000;

// A card answered while the account has never been read is a card that must
// come back on its own: it says "reading…" and asks to be pulled again shortly,
// instead of sitting on the TTL of a value it does not have.
const LOADING_TTL_SECONDS = 15;

// Two widgets on a dashboard, two pulls: the account re-read they trigger is
// deduplicated by the in-flight promise, and the cooldown keeps a permanently
// failing account (expired token, quota reached) from being re-read on every
// single pull.
const RELOAD_COOLDOWN_MS = 60_000;

// The status list of the overview caps at 10 rows core-side; a Home Connect
// account with more than that is a showroom, not a kitchen.
const MAX_OVERVIEW_ROWS = 10;

const TEXTS = {
  noAppliance: {
    en: 'No Home Connect appliance yet. Add one from the Discovery tab.',
    fr: 'Aucun appareil Home Connect. Ajoutez-en un depuis l’onglet Découverte.',
  },
  noCredentials: {
    en: 'Home Connect is not configured yet: enter your Client ID and Client Secret in the integration settings.',
    fr: 'Home Connect n’est pas configuré : renseignez vos Client ID et Client Secret dans la configuration de l’intégration.',
  },
  notConnected: {
    en: 'Home Connect account not connected: click Connect in the integration settings.',
    fr: 'Compte Home Connect non connecté : cliquez sur Connecter dans la configuration de l’intégration.',
  },
  loading: {
    en: 'Reading your Home Connect appliances…',
    fr: 'Lecture de vos appareils Home Connect…',
  },
  running: { en: 'Running', fr: 'En cours' },
  remaining: { en: 'Remaining', fr: 'Temps restant' },
  progress: { en: 'Progress', fr: 'Progression' },
  state: { en: 'State', fr: 'État' },
  program: { en: 'Program', fr: 'Programme' },
  door: { en: 'Door', fr: 'Porte' },
  start: { en: 'Start', fr: 'Démarrer' },
  stop: { en: 'Stop', fr: 'Arrêter' },
  pause: { en: 'Pause', fr: 'Pause' },
  resume: { en: 'Resume', fr: 'Reprendre' },
  started: { en: 'Program started', fr: 'Programme lancé' },
  stopped: { en: 'Program stopped', fr: 'Programme arrêté' },
  paused: { en: 'Program paused', fr: 'Programme mis en pause' },
  resumed: { en: 'Program resumed', fr: 'Programme repris' },
};

export class WidgetBridge {
  /**
   * @param {object} options
   * @param {object} options.gladys SDK instance
   * @param {import('./appliances.js').ApplianceRegistry} options.registry
   * @param {import('./homeconnect/api.js').HomeConnectApi} options.api
   * @param {() => object} [options.getConfig] the normalized configuration, to
   *   tell an account that is not configured from one that is simply not read
   *   yet — the two empty cards look the same and are not fixed the same way.
   */
  constructor({ gladys, registry, api, getConfig }) {
    this.gladys = gladys;
    this.registry = registry;
    this.api = api;
    this.getConfig = getConfig ?? (() => ({}));
    this.lastNudgeAt = 0;
    this.pendingNudge = null;
    this.lastReloadAt = 0;
    /** @type {Promise<unknown>|null} the account re-read in flight, if any */
    this.reloading = null;
  }

  /** Register the two widget handlers. Call it BEFORE `connect()`. */
  register() {
    this.gladys.onWidgetGet(WIDGETS.OVERVIEW, (context) => this.buildOverview(context));
    this.gladys.onWidgetGet(WIDGETS.APPLIANCE, (context) => this.buildAppliance(context));
    this.gladys.onWidgetAction(WIDGETS.APPLIANCE, (actionKey, params, context) =>
      this.runAction(actionKey, context),
    );
  }

  /**
   * "Re-pull me now": the integration knows something changed, the cards catch
   * up in a second instead of waiting for the TTL.
   *
   * Fire-and-forget by contract — the core rate-limits it to one per ten
   * seconds per widget and silently drops the rest, and the SDK drops it while
   * the WebSocket is down. So it is called on every appliance change without
   * any throttling of our own; the only thing to guard against is an
   * exception reaching the event path.
   */
  nudge() {
    const elapsed = Date.now() - this.lastNudgeAt;
    if (elapsed < NUDGE_THROTTLE_MS) {
      this.deferNudge(NUDGE_THROTTLE_MS - elapsed);
      return;
    }
    this.sendNudge();
  }

  /** Arm the trailing edge of the window, once — the burst collapses into it. */
  deferNudge(delay) {
    if (this.pendingNudge) {
      return;
    }
    this.pendingNudge = setTimeout(() => {
      this.pendingNudge = null;
      this.sendNudge();
    }, delay);
    // Never hold the process open for a courtesy message.
    this.pendingNudge.unref?.();
  }

  sendNudge() {
    this.lastNudgeAt = Date.now();
    for (const key of Object.values(WIDGETS)) {
      try {
        this.gladys.requestWidgetRefresh(key);
      } catch (err) {
        logger.debug(`Could not nudge the ${key} widget: ${err.message}`);
      }
    }
  }

  // --- Nothing to show -------------------------------------------------------

  /**
   * The card has no appliance to render. Three very different situations look
   * identical from the dashboard, and only one of them is "add an appliance":
   *
   *   - the account was read and holds nothing  -> add one from Discovery;
   *   - the integration is not configured / not connected -> say which, the fix
   *     is two screens away;
   *   - the account has never been read (the container restarted while Home
   *     Connect was down, the first read hit the quota, the token had expired)
   *     -> read it now and come back in a few seconds, on our own.
   *
   * The last one is the case this method exists for: before it, a widget in
   * that state stayed empty until something else — a poll tick, a saved
   * configuration — happened to refill the registry.
   */
  emptyContent() {
    if (this.registry.loadedAt !== null) {
      return { ttl_seconds: TTL_SECONDS, components: [text(TEXTS.noAppliance)] };
    }
    if (!hasCredentials(this.getConfig())) {
      return { ttl_seconds: TTL_SECONDS, components: [text(TEXTS.noCredentials)] };
    }
    if (!this.api.isAuthorized()) {
      return { ttl_seconds: TTL_SECONDS, components: [text(TEXTS.notConnected)] };
    }
    this.scheduleReload();
    return { ttl_seconds: LOADING_TTL_SECONDS, components: [text(TEXTS.loading)] };
  }

  /**
   * Re-read the account in the background, at most one at a time and at most
   * one per cooldown.
   *
   * Not awaited on purpose: a full account read is a dozen Home Connect calls
   * per appliance, well past the 15 s the core gives a widget to answer. The
   * card answers "reading…" with a short TTL, the read publishes the states it
   * finds — which nudges both widgets — and the next pull renders for real.
   */
  scheduleReload() {
    if (this.reloading || Date.now() - this.lastReloadAt < RELOAD_COOLDOWN_MS) {
      return;
    }
    this.lastReloadAt = Date.now();
    logger.info('A widget was pulled before the account was read: refreshing it now');
    this.reloading = this.registry
      .refresh()
      .then((count) => logger.info(`Widget-triggered refresh: ${count} appliance(s)`))
      .catch((err) => logger.warn(`Widget-triggered refresh failed: ${err.message}`))
      .finally(() => {
        this.reloading = null;
      });
  }

  // --- Contents --------------------------------------------------------------

  /**
   * The account at a glance: one row per appliance, plus the count of the ones
   * actually working.
   * @param {{settings: object, language: string}} context
   */
  async buildOverview({ settings = {}, language = 'en' } = {}) {
    const chosen = asArray(settings.appliances);
    const entries = this.registry
      .list()
      .filter((entry) => chosen.length === 0 || chosen.includes(entry.deviceExternalId));

    if (entries.length === 0) {
      return this.emptyContent();
    }

    const descriptions = entries
      .map((entry) => describeAppliance(entry.snapshot, language))
      // Something happening first: a card read from across the kitchen shows
      // what is running, not what is alphabetically first.
      .sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));

    const running = descriptions.filter((description) => description.running).length;
    const components = [];
    if (running > 0) {
      components.push({
        type: 'value',
        label: TEXTS.running,
        value: running,
        icon: 'play',
        color: WIDGET_COLORS.PRIMARY,
      });
    }
    components.push({
      type: 'status',
      items: descriptions.slice(0, MAX_OVERVIEW_ROWS).map((description) => ({
        label: truncate(description.name, 40),
        value: description.headline,
        color: description.color,
      })),
    });
    return { ttl_seconds: TTL_SECONDS, components };
  }

  /**
   * One appliance in detail. The moving numbers are bound to their features so
   * the core keeps them live; the sentence is the part only we can write.
   * @param {{settings: object, language: string}} context
   */
  async buildAppliance({ settings = {}, language = 'en' } = {}) {
    const entry = this.registry.findByDeviceExternalId(String(settings.appliance ?? ''));
    if (!entry) {
      if (this.registry.loadedAt === null) {
        // The device exists in Gladys — the user picked it from the list — we
        // simply have not read the account yet. "Pick another one" would be a
        // lie, and a lie the user cannot act on: say what is actually missing
        // and get the account read.
        return this.emptyContent();
      }
      // Throwing is the documented way to say "no data": the card shows the
      // message instead of a plausible-looking empty state.
      throw new Error('This appliance no longer exists in Gladys, pick another one');
    }
    const description = describeAppliance(entry.snapshot, language);
    const feature = (featureId) =>
      entry.byFeatureId.has(featureId)
        ? this.registry.featureExternalId(entry.haId, featureId)
        : null;

    const components = [];

    // Live tiles first: they are what the eye goes to, and the content budget
    // drops the tail, never the head.
    const remaining = description.running
      ? feature(OPTION_FEATURES[OPTIONS.REMAINING_PROGRAM_TIME].id)
      : null;
    if (remaining) {
      components.push({
        type: 'value',
        label: TEXTS.remaining,
        device_feature: remaining,
        icon: 'clock',
      });
    }
    const progress = description.running
      ? feature(OPTION_FEATURES[OPTIONS.PROGRAM_PROGRESS].id)
      : null;
    if (progress) {
      components.push({
        type: 'gauge',
        label: TEXTS.progress,
        device_feature: progress,
        min: 0,
        max: 100,
      });
    }

    components.push({ type: 'status', items: this.statusItems(description, entry) });

    if (settings.controls !== false) {
      components.push(...this.buttons(description));
    }

    return { ttl_seconds: TTL_SECONDS, components };
  }

  /**
   * The label/value rows of the single-appliance card. The values are already
   * localized by `describeAppliance`, so only the labels are multi-language
   * objects; both are truncated at the 40 characters the core allows.
   *
   * A status component with no valid row is dropped whole, so the state row is
   * unconditional: an appliance reporting nothing at all still reads "Unknown"
   * rather than losing its card.
   */
  statusItems(description, entry) {
    const items = [{ label: TEXTS.state, value: description.stateLabel, color: description.color }];
    if (description.program) {
      items.push({ label: TEXTS.program, value: description.program });
    }
    if (description.doorLabel && entry.byFeatureId.has(STATUS_FEATURES[STATUSES.DOOR_STATE].id)) {
      items.push({
        label: TEXTS.door,
        value: description.doorLabel,
        color: description.door === 'Open' ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
      });
    }
    return items.map((item) => ({ ...item, value: truncate(item.value, 40) }));
  }

  /**
   * Start / stop, or pause / resume while a program runs. Offering the two
   * halves at once would put a Start next to a running program — a button that
   * exists only to be refused.
   */
  buttons(description) {
    if (!description.connected) {
      return [];
    }
    if (description.running) {
      return [
        description.state === 'Pause'
          ? button(TEXTS.resume, 'primary', 'play', WIDGET_ACTIONS.RESUME)
          : button(TEXTS.pause, 'secondary', 'pause', WIDGET_ACTIONS.PAUSE),
        button(TEXTS.stop, 'danger', 'square', WIDGET_ACTIONS.STOP, true),
      ];
    }
    return [button(TEXTS.start, 'primary', 'play', WIDGET_ACTIONS.START, true)];
  }

  // --- Button taps -----------------------------------------------------------

  /**
   * The user tapped a button of the single-appliance card. The appliance comes
   * from the widget SETTINGS, never from the tap: a dashboard can hang on a
   * wall panel, and the params of a content are not a place to trust.
   *
   * @param {string} actionKey
   * @param {{settings: object}} context
   * @returns {Promise<object>} the toast shown to the user
   */
  async runAction(actionKey, { settings = {} } = {}) {
    const entry = this.registry.findByDeviceExternalId(String(settings.appliance ?? ''));
    if (!entry) {
      if (this.registry.loadedAt === null) {
        this.scheduleReload();
        throw new Error('Home Connect appliances are not loaded yet, try again in a moment');
      }
      throw new Error('This appliance no longer exists in Gladys');
    }
    if (entry.snapshot.connected === false) {
      throw new Error(`${entry.snapshot.name} is offline in Home Connect`);
    }

    logger.info(`Widget action ${actionKey} on ${entry.haId}`);
    switch (actionKey) {
      case WIDGET_ACTIONS.START:
        // Home Connect's own refusal ("Remote start is not enabled") reaches
        // the user as the failed ack: nothing useful to add on top of it.
        await this.api.startSelectedProgram(entry.haId);
        return TEXTS.started;
      case WIDGET_ACTIONS.STOP:
        await this.api.stopProgram(entry.haId);
        return TEXTS.stopped;
      case WIDGET_ACTIONS.PAUSE:
        await this.api.putCommand(entry.haId, COMMANDS.PAUSE_PROGRAM);
        return TEXTS.paused;
      case WIDGET_ACTIONS.RESUME:
        await this.api.putCommand(entry.haId, COMMANDS.RESUME_PROGRAM);
        return TEXTS.resumed;
      default:
        throw new Error(`Unknown widget action: ${actionKey}`);
    }
  }
}

function text(value) {
  return { type: 'text', text: value, variant: 'body' };
}

function button(label, style, icon, actionKey, confirm = false) {
  return {
    type: 'button',
    label,
    style,
    icon,
    action: { key: actionKey, ...(confirm ? { confirm: true } : {}) },
  };
}

/** A multi-select setting arrives as an array, or as nothing at all. */
function asArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item.length > 0);
  }
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}
