// -----------------------------------------------------------------------------
// Startup: read the account, hold the event stream open, and keep trying.
//
// Lives outside index.js so it can be tested: index.js connects to Gladys the
// moment it is imported. What it guards against is a container started before
// its network — `getaddrinfo EAI_AGAIN` right after a reboot is the usual case.
// The first account read then fails, and the code used to give up on the spot:
// no event stream, no retry, nothing real-time until the user happened to save
// the configuration again. Now the stream is started whatever the read did (it
// reconnects on its own and does not need the account read), and the read is
// retried on a growing delay until it succeeds.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { hasCredentials } from './config.js';
import { RateLimitedError } from './homeconnect/api.js';
import { ReauthorizationRequiredError } from './homeconnect/oauth.js';

const logger = createLogger({ name: 'startup' });

// Delays between two attempts at reading the account: quick at first (the
// network usually comes up within a minute), then every 15 minutes, which
// costs one appliance-list call each time Home Connect is really down.
export const ACCOUNT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

const AUTHORIZATION_EXPIRED = {
  en: 'Home Connect authorization expired, click Connect again.',
  fr: 'Autorisation Home Connect expirée, cliquez de nouveau sur Connecter.',
};

/**
 * @param {object} options
 * @param {import('./appliances.js').ApplianceRegistry} options.registry
 * @param {import('./homeconnect/api.js').HomeConnectApi} options.api
 * @param {() => object} options.getConfig
 * @param {() => void} options.startStream
 * @param {() => void} options.stopStream
 * @param {(connected: boolean, message?: {en: string, fr: string}) => Promise<void>} options.reportStatus
 * @param {typeof setTimeout} [options.setTimer]
 * @param {typeof clearTimeout} [options.clearTimer]
 * @returns {{ initialize: () => Promise<void>, cancelRetry: () => void }}
 */
export function createStartup({
  registry,
  api,
  getConfig,
  startStream,
  stopStream,
  reportStatus,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let retryTimer = null;
  // Bumped by every initialize() and cancelRetry(): a retry armed by an older
  // configuration must not report over the newer one.
  let generation = 0;

  function cancelRetry() {
    generation += 1;
    clearTimer(retryTimer);
    retryTimer = null;
  }

  /**
   * Handle a failed account read. Returns true when it is worth retrying.
   * @param {Error} err
   */
  async function reportReadFailure(err) {
    if (err instanceof ReauthorizationRequiredError) {
      await reportStatus(false, AUTHORIZATION_EXPIRED);
      return false;
    }
    if (err instanceof RateLimitedError) {
      // Not broken, just throttled: say so and let the stream keep working.
      await reportStatus(false, {
        en: 'Home Connect rate limit reached, retrying shortly.',
        fr: 'Quota Home Connect atteint, nouvelle tentative sous peu.',
      });
      return true;
    }
    logger.error('Reading the Home Connect account failed', err);
    await reportStatus(false, {
      en: 'Home Connect could not be read, retrying automatically. Check the integration logs if it lasts.',
      fr: "Lecture de Home Connect impossible, nouvelle tentative automatique. Consultez les logs de l'intégration si cela dure.",
    });
    return true;
  }

  function scheduleRetry(attempt, err) {
    const step = ACCOUNT_RETRY_DELAYS_MS[Math.min(attempt, ACCOUNT_RETRY_DELAYS_MS.length - 1)];
    // A rate limit says how long to wait; retrying sooner only earns another 429.
    const delay = Math.max(step, err?.retryAfterMs ?? 0);
    const armedFor = generation;
    logger.info(`Reading the Home Connect account again in ${Math.round(delay / 1000)}s`);
    clearTimer(retryTimer);
    retryTimer = setTimer(async () => {
      retryTimer = null;
      if (armedFor !== generation) {
        return;
      }
      try {
        const count = await registry.refresh();
        if (armedFor !== generation) {
          return;
        }
        await reportStatus(true);
        logger.info(`Home Connect ready: ${count} appliance(s) published`);
      } catch (retryErr) {
        if (armedFor !== generation) {
          return;
        }
        if (await reportReadFailure(retryErr)) {
          scheduleRetry(attempt + 1, retryErr);
        }
      }
    }, delay);
    retryTimer?.unref?.();
  }

  /**
   * (Re)build everything that depends on the configuration: read the account,
   * publish the devices, and hold the event stream open.
   *
   * Every failure mode ends in a message the user can act on, because a cloud
   * integration that is RUNNING but silently unauthorized is the worst possible
   * state to leave someone in. Never throws for a failed read: that one is
   * retried here.
   */
  async function initialize() {
    cancelRetry();
    stopStream();

    if (!hasCredentials(getConfig())) {
      await reportStatus(false, {
        en: 'Enter your Home Connect Client ID and Client Secret.',
        fr: 'Renseignez vos Client ID et Client Secret Home Connect.',
      });
      return;
    }

    if (!api.isAuthorized()) {
      await reportStatus(false, {
        en: 'Click Connect to link your Home Connect account.',
        fr: 'Cliquez sur Connecter pour lier votre compte Home Connect.',
      });
      return;
    }

    let count;
    try {
      count = await registry.refresh();
    } catch (err) {
      if (err instanceof ReauthorizationRequiredError) {
        // No token to stream with either: only the user can fix this one.
        await reportReadFailure(err);
        return;
      }
      // The stream needs no account read to deliver events, and it is the
      // real-time channel: start it now rather than after a read that may take
      // minutes to succeed. Its first connection is not treated as a gap, so
      // the retry below is what fills the snapshots in.
      startStream();
      if (await reportReadFailure(err)) {
        scheduleRetry(0, err);
      }
      return;
    }
    startStream();
    await reportStatus(true);
    logger.info(`Home Connect ready: ${count} appliance(s) published`);
  }

  return { initialize, cancelRetry };
}
