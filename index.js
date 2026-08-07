// -----------------------------------------------------------------------------
// Entry point of the Home Connect integration for Gladys Assistant.
//
// Role of this file: wire the SDK to the Home Connect side of the house. It
// holds no protocol knowledge — the REST dialect lives in src/homeconnect/, the
// key-to-feature mapping in src/mapping/, and the moving state in
// src/appliances.js. Here we only:
//   1. instantiate the SDK (connection, auth, reconnection: handled for us);
//   2. register the handlers BEFORE connect();
//   3. keep the OAuth2 token pair alive and report what the user should see.
//
// Environment variables injected by the Gladys supervisor:
//   - GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR
// The SDK reads them itself: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { hasCredentials, normalizeConfig, readTokens } from './src/config.js';
import { HomeConnectApi, RateLimitedError } from './src/homeconnect/api.js';
import {
  ReauthorizationRequiredError,
  buildAuthorizeUrl,
  exchangeCode,
} from './src/homeconnect/oauth.js';
import { startEventStream } from './src/homeconnect/events.js';
import { ApplianceRegistry } from './src/appliances.js';
import {
  createPendingState,
  matchesPendingState,
  pendingStateConfig,
  readPendingState,
} from './src/oauth-session.js';

const gladys = new GladysIntegration();

// Raw config as Gladys stores it (schema fields AND the off-schema tokens), and
// the normalized view the rest of the code uses.
let rawConfig = {};
let config = normalizeConfig();
let tokens = readTokens();

// Anti-CSRF state of the authorization in flight, verified in the callback. Also
// mirrored into the config (see src/oauth-session.js): the two steps of the flow
// are minutes apart, this process may not be the same one at the end of it.
let pendingOAuth = null;

// Stop function of the Server-Sent-Events stream, while one is running.
let stopEventStream = null;

const api = new HomeConnectApi({
  getConfig: () => config,
  getTokens: () => tokens,
  persistTokens: async (newTokens) => {
    tokens = { ...tokens, ...newTokens };
    rawConfig = { ...rawConfig, ...newTokens };
    // Off-schema config keys: internal storage, never rendered in the UI.
    await gladys.setConfig(newTokens);
  },
});

const registry = new ApplianceRegistry({ gladys, api, getConfig: () => config });

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> refreshing the Home Connect account');
  await registry.refresh();
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  await registry.setValue(device, feature, value);
});

// --- Polling: the safety net behind the event stream -------------------------
gladys.onPoll(async (device) => {
  logger.debug(`onPoll <- ${device.external_id}`);
  await registry.poll(device);
});

// --- OAuth2: Gladys relays the browser flow, we own the provider side --------
//
// Both handlers are acknowledged commands, and Gladys gives a command 5 seconds
// before declaring the integration unreachable — which the browser reports as
// "the integration refused the connection". So they do the strict minimum on the
// critical path and hand everything else to the background: reading the whole
// Home Connect account takes far longer than that, and doing it here used to
// fail the connection the token exchange had just succeeded in making.
gladys.onOAuthAuthorizeUrl(async (key, redirectUri) => {
  logger.info(`Building the Home Connect authorization URL (${key})`);
  if (!hasCredentials(config)) {
    throw new Error('Fill in your Home Connect Client ID before connecting your account');
  }
  pendingOAuth = createPendingState();
  // Off the critical path: the URL is built from what we already hold, and the
  // browser must not wait on a config write to open the provider page.
  persistRawConfig({
    // The redirect URI is the one value the user must register in the Home
    // Connect developer portal, and the "Test the connection" action shows it
    // back to them instead of making them guess.
    oauth_redirect_uri: redirectUri,
    ...pendingStateConfig(pendingOAuth),
  }).catch((err) => logger.error('Failed to store the pending authorization', err));
  return buildAuthorizeUrl(config, redirectUri, pendingOAuth.state);
});

gladys.onOAuthCallback(async (key, { code, state, redirectUri }) => {
  logger.info(`Home Connect authorization callback received (${key})`);
  await assertExpectedState(state);

  const newTokens = await exchangeCode(config, { code, redirectUri });
  tokens = readTokens(newTokens);
  rawConfig = { ...rawConfig, ...newTokens, ...pendingStateConfig(null) };
  await gladys.setConfig({ ...newTokens, ...pendingStateConfig(null) });
  pendingOAuth = null;

  logger.info('Home Connect account connected');
  // Acknowledge now: publishing the appliances is a dozen Home Connect calls
  // per appliance, well past the 5 s budget, and the user watches its result in
  // the Configuration screen, not in the callback window.
  scheduleInitialize();
});

/**
 * Verify the state Home Connect handed back, falling back to the copy stored in
 * the config when this process did not issue it — the container may well have
 * been restarted while the user was signing in.
 * @param {unknown} returnedState
 */
async function assertExpectedState(returnedState) {
  if (matchesPendingState(pendingOAuth, returnedState)) {
    return;
  }
  logger.info('Unknown authorization state in memory, re-reading the stored one');
  rawConfig = (await gladys.getConfig()) ?? {};
  config = normalizeConfig(rawConfig);
  tokens = readTokens(rawConfig);
  pendingOAuth = readPendingState(rawConfig);
  if (!matchesPendingState(pendingOAuth, returnedState)) {
    throw new Error('Authorization state mismatch or expired, restart the connection from Gladys');
  }
}

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', async () => {
  const appliances = await api.getAppliances();
  const names = appliances.map((appliance) => appliance.name || appliance.type).join(', ');
  const redirectUri = rawConfig.oauth_redirect_uri;
  const suffix = redirectUri ? ` (redirect URI: ${redirectUri})` : '';
  if (appliances.length === 0) {
    return {
      en: `Connected to Home Connect, but the account has no appliance yet${suffix}`,
      fr: `Connexion à Home Connect réussie, mais aucun appareil n'est associé au compte${suffix}`,
    };
  }
  return {
    en: `Connected: ${appliances.length} appliance(s) — ${names}`,
    fr: `Connexion réussie : ${appliances.length} appareil(s) — ${names}`,
  };
});

gladys.onAction('refresh_devices', async () => {
  const count = await registry.refresh();
  return {
    en: `${count} appliance(s) refreshed, check the Discovery tab`,
    fr: `${count} appareil(s) actualisé(s), voir l'onglet Découverte`,
  };
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  rawConfig = newConfig ?? {};
  config = normalizeConfig(rawConfig);
  tokens = readTokens(rawConfig);
  // Credentials, language or polling may have changed: rebuild everything on
  // the new values rather than keep a half-old picture.
  await initialize();
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    rawConfig = (await gladys.getConfig()) ?? {};
    config = normalizeConfig(rawConfig);
    tokens = readTokens(rawConfig);
    await initialize();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await reportStatus(false, {
      en: 'Initialization failed, check the integration logs.',
      fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
    });
  }
});

gladys.on('disconnected', () => {
  stopStream();
});

/**
 * (Re)build everything that depends on the configuration: read the account,
 * publish the devices, and hold the event stream open.
 *
 * Every failure mode ends in a message the user can act on, because a cloud
 * integration that is RUNNING but silently unauthorized is the worst possible
 * state to leave someone in.
 */
async function initialize() {
  stopStream();

  if (!hasCredentials(config)) {
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

  try {
    const count = await registry.refresh();
    startStream();
    await reportStatus(true);
    logger.info(`Home Connect ready: ${count} appliance(s) published`);
  } catch (err) {
    if (err instanceof ReauthorizationRequiredError) {
      await reportStatus(false, {
        en: 'Home Connect authorization expired, click Connect again.',
        fr: 'Autorisation Home Connect expirée, cliquez de nouveau sur Connecter.',
      });
      return;
    }
    if (err instanceof RateLimitedError) {
      // Not broken, just throttled: say so and let the stream keep working.
      startStream();
      await reportStatus(false, {
        en: 'Home Connect rate limit reached, retrying shortly.',
        fr: 'Quota Home Connect atteint, nouvelle tentative sous peu.',
      });
      return;
    }
    throw err;
  }
}

/**
 * Run `initialize()` outside of the current command, and never let it reject
 * into the void: a failure there is exactly what the Configuration screen is
 * meant to show.
 */
function scheduleInitialize() {
  setTimeout(async () => {
    // The account read below is the slow part; say so right away, so the
    // Configuration screen stops showing "click Connect" the moment the
    // authorization actually succeeded.
    await reportStatus(false, {
      en: 'Account connected, reading your appliances…',
      fr: 'Compte connecté, lecture de vos appareils…',
    });
    initialize().catch(async (err) => {
      logger.error('Initialization failed', err);
      await reportStatus(false, {
        en: 'Connected, but reading the account failed. Check the integration logs.',
        fr: "Connexion établie, mais la lecture du compte a échoué. Consultez les logs de l'intégration.",
      });
    });
  }, 0);
}

function startStream() {
  stopStream();
  stopEventStream = startEventStream({
    api,
    getConfig: () => config,
    onEvent: (event) => {
      registry
        .handleEvent(event)
        .catch((err) => logger.error(`Failed to apply an event of ${event.haId}`, err));
    },
    onStatusChange: (connected, err) => {
      if (!connected && err instanceof ReauthorizationRequiredError) {
        reportStatus(false, {
          en: 'Home Connect authorization expired, click Connect again.',
          fr: 'Autorisation Home Connect expirée, cliquez de nouveau sur Connecter.',
        }).catch(() => {});
      }
    },
  });
}

function stopStream() {
  try {
    stopEventStream?.();
  } catch (err) {
    logger.error('Failed to stop the event stream', err);
  }
  stopEventStream = null;
}

/** Store off-schema config keys and keep the local copy in sync. */
async function persistRawConfig(patch) {
  rawConfig = { ...rawConfig, ...patch };
  await gladys.setConfig(patch);
}

/**
 * Application-level status shown in the Configuration screen. Distinct from the
 * container state machine: this integration can be RUNNING and still
 * disconnected from Home Connect.
 */
async function reportStatus(connected, message) {
  try {
    await gladys.setConnectionStatus(connected, message);
  } catch (err) {
    logger.error('Failed to report the connection status', err);
  }
}

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopStream();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Home Connect integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
