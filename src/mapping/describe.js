// -----------------------------------------------------------------------------
// Appliance snapshot -> a short, readable description.
//
// Devices and their features are the machine-readable side of the integration;
// this module is the human-readable one. Both the dashboard widgets and the
// `appliance_status` scene action need the same three answers — what is the
// appliance doing, with which program, for how long — and neither of them can
// read a Gladys feature: a widget content is built integration-side, and a
// scene action answers with scalars. So the answers are derived here, once,
// from the snapshot the registry already holds (no Home Connect call, no
// quota).
//
// Everything is localized to the language asked for, falling back to English:
// the widget gets the language of the user looking at the dashboard, the scene
// action gets the one configured for the integration.
// -----------------------------------------------------------------------------

import {
  OPTIONS,
  ROOT,
  RUNNING_OPERATION_STATES,
  STATUSES,
  shortName,
} from '../homeconnect/constants.js';
import { snapshotValues } from './appliance.js';

// Semantic colors of the widget vocabulary (the SDK's WIDGET_COLORS values).
// Kept as plain strings so this module stays free of the widget layer.
const COLOR = {
  NEUTRAL: 'neutral',
  PRIMARY: 'primary',
  SUCCESS: 'success',
  WARNING: 'warning',
  DANGER: 'danger',
};

/** Operation states, short name -> label + the color they deserve on a card. */
const OPERATION_STATES = {
  Inactive: { en: 'Off', fr: 'Éteint', color: COLOR.NEUTRAL },
  Ready: { en: 'Ready', fr: 'Prêt', color: COLOR.NEUTRAL },
  DelayedStart: { en: 'Delayed start', fr: 'Départ différé', color: COLOR.PRIMARY },
  Run: { en: 'Running', fr: 'En marche', color: COLOR.PRIMARY },
  Pause: { en: 'Paused', fr: 'En pause', color: COLOR.WARNING },
  ActionRequired: { en: 'Action required', fr: 'Action requise', color: COLOR.WARNING },
  Finished: { en: 'Finished', fr: 'Terminé', color: COLOR.SUCCESS },
  Error: { en: 'Error', fr: 'Erreur', color: COLOR.DANGER },
  Aborting: { en: 'Stopping', fr: 'Arrêt en cours', color: COLOR.WARNING },
};

const DOOR_STATES = {
  Open: { en: 'Open', fr: 'Ouverte' },
  Closed: { en: 'Closed', fr: 'Fermée' },
  Locked: { en: 'Locked', fr: 'Verrouillée' },
};

const OFFLINE = { en: 'Offline', fr: 'Hors ligne' };
const UNKNOWN = { en: 'Unknown', fr: 'Inconnu' };

/**
 * Pick the right string out of a multi-language object.
 * @param {string} language ISO 639-1 code of the reader
 * @param {Record<string, string>} texts at least an `en` entry
 * @returns {string}
 */
export function pick(language, texts) {
  return texts?.[language] ?? texts?.en ?? '';
}

/**
 * A duration, as a human writes it rather than as a number of seconds.
 * @param {number} seconds
 * @param {string} language
 * @returns {string} `2 h 05` / `2h05`, `45 min`, or an empty string
 */
export function formatDuration(seconds, language) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '';
  }
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = String(minutes % 60).padStart(2, '0');
  if (hours === 0) {
    return `${minutes} min`;
  }
  return language === 'fr' ? `${hours} h ${rest}` : `${hours}h${rest}`;
}

/**
 * What an appliance is doing right now, in words.
 *
 * @param {object} snapshot appliance snapshot held by the registry
 * @param {string} language ISO 639-1 code
 * @returns {{
 *   haId: string, name: string, type: string, connected: boolean,
 *   state: string, stateLabel: string, color: string,
 *   program: string, programKey: string|null, running: boolean,
 *   remainingSeconds: number|null, remainingLabel: string,
 *   progress: number|null, door: string, doorLabel: string,
 *   headline: string
 * }}
 */
export function describeAppliance(snapshot, language = 'en') {
  const values = snapshotValues(snapshot);
  const operationState = values.get(STATUSES.OPERATION_STATE);
  const state = shortName(operationState);
  const known = OPERATION_STATES[state];
  const programKey = values.get(ROOT.ACTIVE_PROGRAM) ?? values.get(ROOT.SELECTED_PROGRAM) ?? null;
  const door = shortName(values.get(STATUSES.DOOR_STATE));
  const connected = snapshot.connected !== false;

  const description = {
    haId: snapshot.haId,
    name: snapshot.name || `${snapshot.brand ?? 'Home Connect'} ${snapshot.type ?? ''}`.trim(),
    type: snapshot.type ?? '',
    connected,
    state,
    stateLabel: known ? pick(language, known) : pick(language, UNKNOWN),
    // Offline wins over the last known state: a card showing "Running" for an
    // appliance Home Connect cannot reach is a card that lies.
    color: connected ? (known?.color ?? COLOR.NEUTRAL) : COLOR.WARNING,
    program: shortName(programKey),
    programKey,
    running: RUNNING_OPERATION_STATES.has(operationState),
    remainingSeconds: finiteOrNull(values.get(OPTIONS.REMAINING_PROGRAM_TIME)),
    remainingLabel: '',
    progress: finiteOrNull(values.get(OPTIONS.PROGRAM_PROGRESS)),
    door,
    doorLabel: DOOR_STATES[door] ? pick(language, DOOR_STATES[door]) : '',
  };

  if (!connected) {
    description.stateLabel = pick(language, OFFLINE);
  }
  description.remainingLabel = description.running
    ? formatDuration(description.remainingSeconds, language)
    : '';
  description.headline = buildHeadline(description, language);
  return description;
}

/**
 * One line summing the appliance up: the state, then what makes it useful —
 * the program while one runs, the door when it is the reason nothing does.
 *
 * Kept short on purpose: this is the value of a widget status row, which the
 * Gladys core truncates at 40 characters.
 * @param {object} description
 * @param {string} language
 */
function buildHeadline(description, language) {
  const parts = [description.stateLabel];
  if (description.connected && description.running) {
    if (description.program) {
      parts.push(description.program);
    }
    if (description.remainingLabel) {
      parts.push(description.remainingLabel);
    }
  } else if (description.connected && description.door === 'Open') {
    parts.push(pick(language, { en: 'door open', fr: 'porte ouverte' }));
  }
  return truncate(parts.filter(Boolean).join(' · '), 40);
}

/** @param {string} text @param {number} max */
export function truncate(text, max) {
  const value = String(text ?? '').trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
