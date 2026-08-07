// -----------------------------------------------------------------------------
// The anti-CSRF state of the authorization in flight.
//
// Gladys relays the browser flow in two steps that are minutes apart — the user
// signs in at Home Connect and grants the four scopes in between — so the state
// we generate for step 1 has to survive until step 2. In memory alone it does
// not: an integration update, a Docker restart or a crash between the two loses
// it, and the callback is then refused for a reason the user cannot act on
// ("state mismatch") although nothing is wrong on their side.
//
// It is therefore mirrored into the off-schema config, the same free internal
// storage the tokens use, and given an expiry so a state left behind by an
// abandoned flow does not stay valid forever.
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';

/** How long an authorization started but never finished stays acceptable. */
export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Start a new authorization: an unguessable state and the moment it was issued.
 * @param {number} [now] epoch ms, injectable for the tests
 * @returns {{ state: string, createdAt: number }}
 */
export function createPendingState(now = Date.now()) {
  return { state: randomUUID(), createdAt: now };
}

/**
 * The off-schema config keys mirroring a pending state.
 * @param {{ state: string, createdAt: number }|null} pending null clears them
 * @returns {Record<string, string|number>}
 */
export function pendingStateConfig(pending) {
  return {
    oauth_pending_state: pending ? pending.state : '',
    oauth_pending_state_at: pending ? pending.createdAt : 0,
  };
}

/**
 * Read back a pending state mirrored into the config.
 * @param {Record<string, unknown>} raw raw config as Gladys stores it
 * @returns {{ state: string, createdAt: number }|null}
 */
export function readPendingState(raw = {}) {
  const state = typeof raw.oauth_pending_state === 'string' ? raw.oauth_pending_state : '';
  if (state.length === 0) {
    return null;
  }
  return { state, createdAt: Number(raw.oauth_pending_state_at) || 0 };
}

/**
 * Whether the state Home Connect handed back is the one we are waiting for.
 * @param {{ state: string, createdAt: number }|null} pending
 * @param {unknown} returnedState
 * @param {number} [now] epoch ms, injectable for the tests
 * @returns {boolean}
 */
export function matchesPendingState(pending, returnedState, now = Date.now()) {
  if (!pending || typeof returnedState !== 'string' || returnedState.length === 0) {
    return false;
  }
  if (now - pending.createdAt > OAUTH_STATE_TTL_MS) {
    return false;
  }
  return returnedState === pending.state;
}
