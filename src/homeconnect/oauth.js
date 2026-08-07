// -----------------------------------------------------------------------------
// Home Connect OAuth2 (authorization code grant).
//
// Gladys owns the browser part of the flow: the manifest declares an `oauth2`
// config field, the Configuration screen renders a "Connect" button, and the
// core calls back into the integration twice —
//   1. `onOAuthAuthorizeUrl(key, redirectUri)` -> we build the provider URL;
//   2. `onOAuthCallback(key, { code, state, redirectUri })` -> we exchange the
//      code for tokens.
// The Gladys server knows nothing about Home Connect; this file is the only
// place that does.
//
// Tokens are stored as config keys OUTSIDE the manifest `config_schema`
// (`access_token`, `refresh_token`, `token_expires_at`): free internal storage,
// never rendered, never sent to the frontend.
// -----------------------------------------------------------------------------

import { OAUTH_AUTHORIZE_PATH, OAUTH_TOKEN_PATH } from './constants.js';

/**
 * Budget of the authorization-code exchange, deliberately short.
 *
 * Gladys waits at most 5 s for the acknowledgement of the `oauth-callback`
 * command before declaring the integration unreachable — and the browser then
 * shows "the integration refused the connection" whatever we answer afterwards.
 * Overrunning that budget is therefore never useful: better to fail with our own
 * message, in time for the user to read it, than to answer into a closed door.
 * The refresh path keeps the generous `request_timeout_ms`: it runs in the
 * background, with nobody waiting behind a 5 s door.
 */
export const AUTHORIZATION_EXCHANGE_TIMEOUT_MS = 3_500;

/**
 * Error thrown when the refresh token itself is refused: the user must click
 * "Connect" again. Callers surface it through `setConnectionStatus(false, …)`
 * instead of retrying forever.
 */
export class ReauthorizationRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReauthorizationRequiredError';
  }
}

/**
 * Build the authorization URL the user's browser is sent to.
 *
 * @param {object} config normalized integration config
 * @param {string} redirectUri redirect URI provided by Gladys
 * @param {string} state anti-CSRF state we verify in the callback
 * @returns {string}
 */
export function buildAuthorizeUrl(config, redirectUri, state) {
  if (!config.client_id) {
    throw new Error('Missing Home Connect Client ID');
  }
  const url = new URL(OAUTH_AUTHORIZE_PATH, config.base_url);
  url.searchParams.set('client_id', config.client_id);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Exchange an authorization code for a token pair.
 *
 * @param {object} config normalized integration config
 * @param {{ code: string, redirectUri: string }} params
 * @returns {Promise<{ access_token: string, refresh_token: string, token_expires_at: number }>}
 */
export function exchangeCode(config, { code, redirectUri }) {
  return requestToken(
    config,
    {
      grant_type: 'authorization_code',
      client_id: config.client_id,
      client_secret: config.client_secret,
      redirect_uri: redirectUri,
      code,
    },
    AUTHORIZATION_EXCHANGE_TIMEOUT_MS,
  );
}

/**
 * Trade the refresh token for a fresh access token. Home Connect rotates the
 * refresh token on every use, so the caller MUST persist what comes back.
 *
 * @param {object} config normalized integration config
 * @param {string} refreshToken
 * @returns {Promise<{ access_token: string, refresh_token: string, token_expires_at: number }>}
 */
export function refreshTokens(config, refreshToken) {
  return requestToken(config, {
    grant_type: 'refresh_token',
    client_id: config.client_id,
    client_secret: config.client_secret,
    refresh_token: refreshToken,
  });
}

/**
 * POST the token endpoint with a form body, as the OAuth2 spec requires.
 * @param {object} config
 * @param {Record<string, string|undefined>} params
 * @param {number} [timeoutMs] budget of the call, `request_timeout_ms` by default
 */
async function requestToken(config, params, timeoutMs = config.request_timeout_ms) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // A public client registered without a secret sends no client_secret at
    // all — an empty one is refused, an absent one is not.
    if (value !== undefined && value !== null && value !== '') {
      body.set(key, String(value));
    }
  }

  const response = await fetch(new URL(OAUTH_TOKEN_PATH, config.base_url), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const payload = await readJson(response);

  if (!response.ok) {
    const detail = [
      payload?.error_description || payload?.error || `HTTP ${response.status}`,
      hintFor(config, params, payload),
    ]
      .filter(Boolean)
      .join(' — ');
    // `invalid_grant` is the terminal one: the refresh token is dead (revoked
    // in the Home Connect app, expired after two months of downtime, or
    // already rotated). Retrying cannot fix it — only the user can.
    if (payload?.error === 'invalid_grant' || response.status === 400) {
      throw new ReauthorizationRequiredError(`Home Connect refused the grant: ${detail}`);
    }
    throw new Error(`Home Connect token request failed: ${detail}`);
  }

  if (!payload?.access_token) {
    throw new Error('Home Connect token response contained no access_token');
  }

  return {
    access_token: payload.access_token,
    // Defensive: keep the previous refresh token if the provider omits it.
    refresh_token: payload.refresh_token ?? params.refresh_token ?? null,
    token_expires_at: expiresAtFrom(payload.expires_in),
  };
}

/**
 * The two refusals Home Connect words unhelpfully, expanded into what the user
 * actually has to change. Everything else is left to speak for itself.
 * @param {object} config
 * @param {Record<string, string|undefined>} params
 * @param {object|null} payload
 * @returns {string} an empty string when we have nothing to add
 */
function hintFor(config, params, payload) {
  if (!config.client_secret && !config.use_simulator) {
    return 'the production API requires a Client Secret, fill it in the configuration';
  }
  if (payload?.error === 'invalid_grant' && params.grant_type === 'authorization_code') {
    return `check that ${params.redirect_uri} is registered as the redirect URI of your Home Connect application`;
  }
  return '';
}

/**
 * Absolute expiry (epoch ms) with a safety margin, from the relative
 * `expires_in` the provider returns (a day for Home Connect access tokens).
 * @param {unknown} expiresIn seconds
 */
function expiresAtFrom(expiresIn) {
  const seconds = Number(expiresIn);
  const lifetime = Number.isFinite(seconds) && seconds > 0 ? seconds : 3600;
  return Date.now() + lifetime * 1000;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
