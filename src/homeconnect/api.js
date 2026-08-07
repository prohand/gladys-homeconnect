// -----------------------------------------------------------------------------
// Home Connect REST client.
//
// One class, three responsibilities:
//   1. keep the OAuth2 token pair alive (refresh before expiry, refresh once on
//      a 401, persist every rotation through the `persistTokens` callback);
//   2. speak the Home Connect dialect — `application/vnd.bsh.sdk.v1+json`, the
//      `{ data: … }` envelope, the `{ error: { key, description } }` envelope;
//   3. respect the rate limit. Home Connect is strict and answers 429 with a
//      `Retry-After`; hammering it gets the whole client throttled, so a 429
//      arms a cooldown that every later call observes instead of re-hitting.
//
// Node's global `fetch` is the only HTTP layer: no dependency to audit.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { API_PATH, BSH_JSON_V1 } from './constants.js';
import { ReauthorizationRequiredError, refreshTokens } from './oauth.js';

const logger = createLogger({ name: 'homeconnect-api' });

// Refresh a little before the token actually dies, so a long request started
// just under the wire still completes with a valid token.
const TOKEN_EXPIRY_MARGIN_MS = 120_000;

/** Thrown when Home Connect answers 429; carries the cooldown it asked for. */
export class RateLimitedError extends Error {
  constructor(retryAfterMs) {
    super(`Home Connect rate limit reached, retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Thrown for the 4xx answers that are a normal part of appliance life: a
 * command refused because the door is open, remote start is not allowed, or the
 * appliance does not implement the key. They are reported, never retried.
 */
export class HomeConnectApiError extends Error {
  constructor(status, key, description) {
    super(description || key || `Home Connect error (HTTP ${status})`);
    this.name = 'HomeConnectApiError';
    this.status = status;
    this.key = key;
  }
}

export class HomeConnectApi {
  /**
   * @param {object} options
   * @param {() => object} options.getConfig returns the current normalized config
   * @param {() => { access_token?: string, refresh_token?: string, token_expires_at?: number }}
   *   options.getTokens returns the currently stored token triplet
   * @param {(tokens: object) => Promise<void>} options.persistTokens stores a rotated token pair
   */
  constructor({ getConfig, getTokens, persistTokens }) {
    this.getConfig = getConfig;
    this.getTokens = getTokens;
    this.persistTokens = persistTokens;
    // Single in-flight refresh: several parallel calls waking up on an expired
    // token must not each burn a refresh token (Home Connect rotates it).
    this.refreshPromise = null;
    this.rateLimitedUntil = 0;
  }

  /** @returns {boolean} whether a token pair is stored at all. */
  isAuthorized() {
    return Boolean(this.getTokens().refresh_token || this.getTokens().access_token);
  }

  // --- Appliances ------------------------------------------------------------

  /** @returns {Promise<Array<object>>} every appliance paired with the account. */
  async getAppliances() {
    const data = await this.request('GET', API_PATH);
    return data?.homeappliances ?? [];
  }

  /** @returns {Promise<object>} the envelope of ONE appliance (name, connected…). */
  getAppliance(haId) {
    return this.request('GET', `${API_PATH}/${encodeURIComponent(haId)}`);
  }

  /** @returns {Promise<Array<{key: string, value: unknown, unit?: string}>>} */
  async getSettings(haId) {
    const data = await this.request('GET', `${API_PATH}/${encodeURIComponent(haId)}/settings`);
    return data?.settings ?? [];
  }

  /**
   * One setting WITH its constraints (`allowedvalues`, `min`, `max`, `access`).
   * Constraints are what turn a generic catalog entry into a device-accurate
   * feature: the allowed off value of PowerState, the setpoint bounds of a
   * fridge. Only fetched for the few keys that declare `needsConstraints`.
   */
  async getSettingDetail(haId, key) {
    return this.request(
      'GET',
      `${API_PATH}/${encodeURIComponent(haId)}/settings/${encodeURIComponent(key)}`,
    );
  }

  /** @returns {Promise<Array<{key: string, value: unknown, unit?: string}>>} */
  async getStatuses(haId) {
    const data = await this.request('GET', `${API_PATH}/${encodeURIComponent(haId)}/status`);
    return data?.status ?? [];
  }

  /**
   * The running program and its options, or `null` when none is active.
   * A 404/409 here is the documented way Home Connect says "nothing running".
   */
  getActiveProgram(haId) {
    return this.getProgram(haId, 'active');
  }

  /** The program loaded on the appliance dial, or `null`. */
  getSelectedProgram(haId) {
    return this.getProgram(haId, 'selected');
  }

  async getProgram(haId, which) {
    try {
      return await this.request('GET', `${API_PATH}/${encodeURIComponent(haId)}/programs/${which}`);
    } catch (err) {
      if (err instanceof HomeConnectApiError && (err.status === 404 || err.status === 409)) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Write a setting. `unit` is passed through when the appliance declares one
   * (temperatures), because Home Connect validates the value against it.
   */
  setSetting(haId, key, value, unit) {
    const data = { key, value };
    if (unit) {
      data.unit = unit;
    }
    return this.request(
      'PUT',
      `${API_PATH}/${encodeURIComponent(haId)}/settings/${encodeURIComponent(key)}`,
      { data },
    );
  }

  /**
   * Start the program currently selected on the appliance, options included.
   * Deliberately NOT "start some program we picked": the user selects on the
   * appliance (or in the Home Connect app), Gladys only pulls the trigger —
   * which is also the only thing the appliance allows without re-declaring
   * every option of every program.
   */
  async startSelectedProgram(haId) {
    const selected = await this.getSelectedProgram(haId);
    if (!selected?.key) {
      throw new Error('No program selected on the appliance');
    }
    return this.request('PUT', `${API_PATH}/${encodeURIComponent(haId)}/programs/active`, {
      data: { key: selected.key, options: selected.options ?? [] },
    });
  }

  /** Abort the running program. */
  stopProgram(haId) {
    return this.request('DELETE', `${API_PATH}/${encodeURIComponent(haId)}/programs/active`);
  }

  /** Trigger a write-only command (pause / resume). */
  putCommand(haId, key) {
    return this.request(
      'PUT',
      `${API_PATH}/${encodeURIComponent(haId)}/commands/${encodeURIComponent(key)}`,
      { data: { key, value: true } },
    );
  }

  // --- Transport -------------------------------------------------------------

  /**
   * Perform one authenticated request, refreshing the token when needed.
   * @param {'GET'|'PUT'|'POST'|'DELETE'} method
   * @param {string} path
   * @param {object} [body]
   * @param {boolean} [allowRetry] internal: false on the post-401 retry
   * @returns {Promise<any>} the unwrapped `data` envelope
   */
  async request(method, path, body, allowRetry = true) {
    this.assertNotRateLimited();

    const config = this.getConfig();
    const accessToken = await this.getAccessToken();

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: BSH_JSON_V1,
      'Accept-Language': config.language,
    };
    if (body !== undefined) {
      headers['Content-Type'] = BSH_JSON_V1;
    }

    const response = await fetch(new URL(path, config.base_url), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(config.request_timeout_ms),
    });

    if (response.status === 401 && allowRetry) {
      // The token was rejected mid-flight (revoked, or clock skew against our
      // expiry math). Force one refresh and replay exactly once.
      logger.debug('Access token rejected, forcing a refresh');
      await this.forceRefresh();
      return this.request(method, path, body, false);
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      this.rateLimitedUntil = Date.now() + retryAfterMs;
      throw new RateLimitedError(retryAfterMs);
    }

    if (response.status === 204) {
      return null;
    }

    const payload = await readJson(response);

    if (!response.ok) {
      throw new HomeConnectApiError(
        response.status,
        payload?.error?.key,
        payload?.error?.description,
      );
    }

    return payload?.data ?? null;
  }

  assertNotRateLimited() {
    const remaining = this.rateLimitedUntil - Date.now();
    if (remaining > 0) {
      throw new RateLimitedError(remaining);
    }
  }

  /** @returns {Promise<string>} a valid access token, refreshing if needed. */
  async getAccessToken() {
    const tokens = this.getTokens();
    if (!tokens.access_token && !tokens.refresh_token) {
      throw new ReauthorizationRequiredError('Home Connect account not connected yet');
    }
    const expiresAt = Number(tokens.token_expires_at) || 0;
    if (tokens.access_token && expiresAt - TOKEN_EXPIRY_MARGIN_MS > Date.now()) {
      return tokens.access_token;
    }
    return this.forceRefresh();
  }

  /** @returns {Promise<string>} the freshly obtained access token. */
  forceRefresh() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async doRefresh() {
    const { refresh_token: refreshToken } = this.getTokens();
    if (!refreshToken) {
      throw new ReauthorizationRequiredError('No Home Connect refresh token stored');
    }
    logger.info('Refreshing the Home Connect access token');
    const tokens = await refreshTokens(this.getConfig(), refreshToken);
    await this.persistTokens(tokens);
    return tokens.access_token;
  }
}

/**
 * `Retry-After` is either a delay in seconds or an HTTP date. Home Connect
 * sends seconds; the date form is handled anyway so an odd gateway cannot make
 * us busy-loop. Clamped to [1s, 1h].
 * @param {string|null} header
 */
export function parseRetryAfter(header) {
  const fallback = 60_000;
  if (!header) {
    return fallback;
  }
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms)) {
    return fallback;
  }
  return Math.min(Math.max(ms, 1_000), 3_600_000);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
