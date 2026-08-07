// -----------------------------------------------------------------------------
// Home Connect event stream (Server-Sent Events).
//
// This is what makes the integration `cloud_push` rather than a poller: one
// long-lived HTTP request on `/api/homeappliances/events` carries the events of
// EVERY appliance of the account, including the changes the user makes on the
// appliance itself. The `id:` field of each SSE frame is the `haId` it concerns.
//
// Doctrine "trigger, not data" does NOT fully apply here: unlike a webhook relay,
// this stream is authenticated, ordered and complete, so its `STATUS`/`NOTIFY`
// items ARE applied as states. Polling stays armed anyway (`poll_frequency` on
// every device) because the stream is cut server-side roughly every 24 h, and a
// missed reconnection window must not silently freeze the devices.
//
// Written directly on `fetch` + the web ReadableStream: `EventSource` is not in
// Node's standard library, and the stream needs an `Authorization` header that
// the browser API cannot send anyway.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { API_PATH, SSE_TYPES } from './constants.js';
import { RateLimitedError, parseRetryAfter } from './api.js';
import { ReauthorizationRequiredError } from './oauth.js';

const logger = createLogger({ name: 'homeconnect-events' });

// Home Connect emits a KEEP-ALIVE roughly every 55 s. Silence well past that
// means the socket is a zombie (NAT timeout, sleeping laptop): drop it and
// reconnect rather than believe a frozen appliance state.
const IDLE_TIMEOUT_MS = 180_000;

const RECONNECT_BASE_DELAY_MS = 5_000;
const RECONNECT_MAX_DELAY_MS = 300_000;

/**
 * One parsed item of a STATUS / NOTIFY / EVENT frame.
 * @typedef {object} HomeConnectEvent
 * @property {string} haId appliance the event concerns
 * @property {string} type SSE frame type (STATUS, NOTIFY, EVENT, CONNECTED…)
 * @property {string} [key] Home Connect dotted key
 * @property {unknown} [value]
 * @property {string} [unit]
 */

/**
 * Open the stream and keep it open for life, reconnecting with backoff.
 *
 * @param {object} options
 * @param {import('./api.js').HomeConnectApi} options.api
 * @param {() => object} options.getConfig
 * @param {(event: HomeConnectEvent) => void} options.onEvent
 * @param {(connected: boolean, error?: Error) => void} [options.onStatusChange]
 * @returns {() => void} stop function; call it on disconnection / shutdown
 */
export function startEventStream({ api, getConfig, onEvent, onStatusChange = () => {} }) {
  let stopped = false;
  let controller = null;
  let retryTimer = null;
  let attempt = 0;

  const scheduleReconnect = (delayMs) => {
    if (stopped) {
      return;
    }
    logger.info(`Reconnecting to the event stream in ${Math.round(delayMs / 1000)}s`);
    retryTimer = setTimeout(run, delayMs);
    // Do not hold the process alive just to wait for a retry.
    retryTimer.unref?.();
  };

  const run = async () => {
    if (stopped) {
      return;
    }
    controller = new AbortController();
    try {
      await consumeStream({ api, getConfig, onEvent, signal: controller.signal, onStatusChange });
      // A clean end-of-stream is normal: Home Connect closes it periodically.
      attempt = 0;
      scheduleReconnect(RECONNECT_BASE_DELAY_MS);
    } catch (err) {
      if (stopped) {
        return;
      }
      onStatusChange(false, err);
      if (err instanceof RateLimitedError) {
        // Ten concurrent streams per client is the documented ceiling; obey the
        // cooldown instead of racing back in and getting blocked for longer.
        logger.warn(`Event stream rate limited: ${err.message}`);
        scheduleReconnect(err.retryAfterMs);
        return;
      }
      if (err instanceof ReauthorizationRequiredError) {
        // No token to stream with. index.js already told the user; retry slowly
        // in case they reconnect the account without restarting the container.
        logger.warn(`Event stream not authorized: ${err.message}`);
        scheduleReconnect(RECONNECT_MAX_DELAY_MS);
        return;
      }
      attempt += 1;
      logger.warn(`Event stream failed (attempt ${attempt}): ${err.message}`);
      scheduleReconnect(
        Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS),
      );
    }
  };

  run();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);
    controller?.abort();
  };
}

/**
 * Run ONE connection until the server closes it (or the watchdog fires).
 * Extracted from the retry loop so it stays testable with a fake fetch.
 */
async function consumeStream({ api, getConfig, onEvent, signal, onStatusChange }) {
  const config = getConfig();
  const accessToken = await api.getAccessToken();

  const response = await fetch(new URL(`${API_PATH}/events`, config.base_url), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'text/event-stream',
      'Accept-Language': config.language,
      'Cache-Control': 'no-cache',
    },
    signal,
  });

  if (response.status === 429) {
    throw new RateLimitedError(parseRetryAfter(response.headers.get('Retry-After')));
  }
  if (response.status === 401) {
    // Force a refresh so the next attempt starts from a fresh token.
    await api.forceRefresh();
    throw new Error('Event stream rejected the access token');
  }
  if (!response.ok || !response.body) {
    throw new Error(`Event stream request failed with HTTP ${response.status}`);
  }

  logger.info('Event stream connected');
  onStatusChange(true);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // Watchdog: the KEEP-ALIVE frames are the heartbeat. No frame for
  // IDLE_TIMEOUT_MS means the connection is dead even though the socket is not.
  let watchdog = null;
  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      logger.warn('No event received for 3 minutes, dropping the stream');
      reader.cancel().catch(() => {});
    }, IDLE_TIMEOUT_MS);
    watchdog.unref?.();
  };

  try {
    armWatchdog();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      armWatchdog();
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; \r\n is legal too.
      let separator = findFrameSeparator(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        for (const event of parseFrame(frame)) {
          onEvent(event);
        }
        separator = findFrameSeparator(buffer);
      }
    }
  } finally {
    clearTimeout(watchdog);
    reader.cancel().catch(() => {});
  }

  logger.info('Event stream closed by Home Connect');
}

function findFrameSeparator(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) {
    return null;
  }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

/**
 * Turn one raw SSE frame into zero or more events.
 *
 * A frame looks like:
 *   event: STATUS
 *   data: {"items":[{"key":"BSH.Common.Status.DoorState","value":"…"}],"haId":"…"}
 *   id: BOSCH-HCS01OVN1-1234567890
 *
 * KEEP-ALIVE carries no data; CONNECTED / DISCONNECTED / PAIRED / DEPAIRED
 * carry only the appliance identity. STATUS / NOTIFY / EVENT carry `items`,
 * each of which becomes one event so the caller never unpacks arrays.
 *
 * Exported for the unit tests: frame parsing is the part worth pinning down.
 *
 * @param {string} frame
 * @returns {HomeConnectEvent[]}
 */
export function parseFrame(frame) {
  let type = 'message';
  let id = '';
  const dataLines = [];

  for (const rawLine of frame.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line === '' || line.startsWith(':')) {
      continue; // comment / padding
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      type = value;
    } else if (field === 'id') {
      id = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (type === SSE_TYPES.KEEP_ALIVE) {
    return [];
  }

  const payload = parseJson(dataLines.join('\n'));
  const haId = payload?.haId || id;
  if (!haId) {
    return [];
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    // CONNECTED / DISCONNECTED / PAIRED / DEPAIRED: identity only.
    return [{ haId, type }];
  }

  return items.map((item) => ({
    haId,
    type,
    key: item.key,
    value: item.value,
    unit: item.unit,
  }));
}

function parseJson(text) {
  if (!text || text === '""') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    logger.debug(`Ignoring an unparsable event payload: ${text.slice(0, 120)}`);
    return null;
  }
}
