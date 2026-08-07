// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user fills in the fields declared by `config_schema` in
// `gladys-assistant-integration.json`; the SDK fetches them (`getConfig`) and
// notifies every change (`onConfigUpdated`). This module adds the defaults,
// forces the types (a form can send numbers as strings) and derives the values
// the rest of the code wants ready-made, so nothing downstream deals with
// `undefined`.
//
// Three keys never appear in `config_schema`: `access_token`, `refresh_token`
// and `token_expires_at`. They are written by the OAuth callback through
// `setConfig` — free internal storage, never rendered in the UI, never sent to
// the frontend. `oauth_redirect_uri` is the same kind of key: Gladys tells us
// the redirect URI during the flow, and we remember it so the "Test the
// connection" action can show the user what to register at Home Connect.
// -----------------------------------------------------------------------------

import { DEFAULT_SCOPE, PRODUCTION_BASE_URL, SIMULATOR_BASE_URL } from './homeconnect/constants.js';

// Keep these consistent with the `default` values of the manifest.
export const DEFAULT_CONFIG = {
  client_id: '',
  client_secret: '',
  scope: DEFAULT_SCOPE,
  language: 'en',
  // Home Connect is strict about quotas and the event stream already delivers
  // changes in real time, so polling is a safety net, not the main channel.
  poll_frequency: 900,
  use_simulator: false,
};

const SUPPORTED_LANGUAGES = new Set(['en', 'fr']);

// Gladys stores `poll_frequency` as an ENUM of milliseconds
// (`DEVICE_POLL_FREQUENCIES`: 1 s, 2 s, 10 s, 15 s, 30 s, 60 s) and rejects
// anything else with `invalid poll frequency`. Its slowest tick is one minute,
// far too fast for the Home Connect daily quota, so every device is published
// at that tick and the registry throttles the ticks down to the interval the
// user actually configured (in seconds) — see ApplianceRegistry.poll().
export const GLADYS_POLL_TICK_MS = 60_000;

/**
 * Merge the user configuration with the defaults and derive the rest.
 * @param {Record<string, unknown>} raw configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const useSimulator = raw.use_simulator === true || raw.use_simulator === 'true';
  const language = SUPPORTED_LANGUAGES.has(raw.language) ? raw.language : DEFAULT_CONFIG.language;

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    client_id: String(raw.client_id ?? '').trim(),
    client_secret: String(raw.client_secret ?? '').trim(),
    scope: String(raw.scope || DEFAULT_CONFIG.scope).trim(),
    language,
    poll_frequency: clamp(Number(raw.poll_frequency ?? DEFAULT_CONFIG.poll_frequency), 120, 3600),
    use_simulator: useSimulator,
    // Derived, never stored: the simulator speaks the exact same API on another
    // host, which is how you develop without owning a 900 € dishwasher.
    base_url: useSimulator ? SIMULATOR_BASE_URL : PRODUCTION_BASE_URL,
    request_timeout_ms: 20_000,
  };
}

/**
 * The OAuth token triplet stored off-schema.
 * @param {Record<string, unknown>} raw
 */
export function readTokens(raw = {}) {
  return {
    access_token: typeof raw.access_token === 'string' ? raw.access_token : undefined,
    refresh_token: typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined,
    token_expires_at: Number(raw.token_expires_at) || 0,
  };
}

/** True when the user filled in the developer-portal credentials. */
export function hasCredentials(config) {
  return Boolean(config.client_id);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}
