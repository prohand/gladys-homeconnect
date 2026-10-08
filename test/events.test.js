import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFrame, startEventStream } from '../src/homeconnect/events.js';
import { RateLimitedError } from '../src/homeconnect/api.js';
import { SETTINGS, STATUSES } from '../src/homeconnect/constants.js';

test('parseFrame expands the items of a STATUS frame into one event each', () => {
  const frame = [
    'event: STATUS',
    `data: {"items":[{"key":"${STATUSES.DOOR_STATE}","value":"BSH.Common.EnumType.DoorState.Open","timestamp":1737000000},{"key":"${STATUSES.OPERATION_STATE}","value":"BSH.Common.EnumType.OperationState.Run"}],"haId":"BOSCH-HCS03DWH-1"}`,
    'id: BOSCH-HCS03DWH-1',
  ].join('\n');

  const events = parseFrame(frame);

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    haId: 'BOSCH-HCS03DWH-1',
    type: 'STATUS',
    key: STATUSES.DOOR_STATE,
    value: 'BSH.Common.EnumType.DoorState.Open',
    unit: undefined,
  });
  assert.equal(events[1].key, STATUSES.OPERATION_STATE);
});

test('parseFrame drops KEEP-ALIVE frames', () => {
  assert.deepEqual(parseFrame('event: KEEP-ALIVE\ndata: ""\n'), []);
});

test('parseFrame falls back to the SSE id when the payload carries no haId', () => {
  const events = parseFrame('event: DISCONNECTED\ndata: ""\nid: SIEMENS-HCS05FRF-9');
  assert.deepEqual(events, [{ haId: 'SIEMENS-HCS05FRF-9', type: 'DISCONNECTED' }]);
});

test('parseFrame ignores a frame that identifies no appliance', () => {
  assert.deepEqual(parseFrame('event: STATUS\ndata: {"items":[]}'), []);
});

test('parseFrame keeps the unit of a NOTIFY item', () => {
  const frame = `event: NOTIFY\ndata: {"haId":"X-1","items":[{"key":"${SETTINGS.FRIDGE_SETPOINT}","value":4,"unit":"°C"}]}`;
  assert.deepEqual(parseFrame(frame), [
    { haId: 'X-1', type: 'NOTIFY', key: SETTINGS.FRIDGE_SETPOINT, value: 4, unit: '°C' },
  ]);
});

test('parseFrame survives an unparsable payload instead of throwing', () => {
  assert.deepEqual(parseFrame('event: STATUS\ndata: {not json}\nid: X-1'), [
    { haId: 'X-1', type: 'STATUS' },
  ]);
});

test('parseFrame handles CRLF line endings and multi-line data', () => {
  const frame = 'event: STATUS\r\ndata: {"haId":"X-1",\r\ndata: "items":[]}\r\n';
  assert.deepEqual(parseFrame(frame), [{ haId: 'X-1', type: 'STATUS' }]);
});

// --- The connection itself ---------------------------------------------------

/** Swap the global fetch for the duration of one test. */
function stubFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function fakeStreamApi() {
  return {
    rateLimitedUntil: 0,
    async getAccessToken() {
      return 'at';
    },
    async forceRefresh() {
      return 'at';
    },
  };
}

/**
 * The stream's own timers are unref'd (they must not hold the container
 * alive), so a test waiting on one needs something else to keep the loop up.
 */
function keepLoopAlive(t) {
  const timer = setTimeout(() => {}, 10_000);
  t.after(() => clearTimeout(timer));
}

/** Start a stream and resolve with the first `connected: false` it reports. */
function firstFailure(t, api, config) {
  keepLoopAlive(t);
  return new Promise((resolve) => {
    const stop = startEventStream({
      api,
      getConfig: () => config,
      onEvent: () => {},
      onStatusChange: (connected, err) => {
        if (!connected) {
          resolve(err);
        }
      },
    });
    t.after(stop);
  });
}

const STREAM_CONFIG = {
  base_url: 'https://simulator.home-connect.com',
  language: 'en',
  request_timeout_ms: 50,
};

test('a stream request that never gets an answer times out instead of hanging', async (t) => {
  // A server that accepts the connection and never answers: only the abort
  // signal can end this request.
  stubFetch(
    t,
    (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );

  const err = await firstFailure(t, fakeStreamApi(), STREAM_CONFIG);

  assert.match(err.message, /timed out/);
});

test('a 429 on the stream arms the cooldown the REST calls observe', async (t) => {
  stubFetch(t, async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
  const api = fakeStreamApi();
  const before = Date.now();

  const err = await firstFailure(t, api, STREAM_CONFIG);

  assert.ok(err instanceof RateLimitedError);
  assert.ok(api.rateLimitedUntil >= before + 120_000);
  assert.ok(api.rateLimitedUntil <= Date.now() + 120_000);
});

test('every frame, keep-alives included, counts as a sign of life', async (t) => {
  const encoder = new TextEncoder();
  stubFetch(
    t,
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: KEEP-ALIVE\ndata: ""\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  keepLoopAlive(t);
  let activity = 0;
  const events = [];
  await new Promise((resolve) => {
    const stop = startEventStream({
      api: fakeStreamApi(),
      getConfig: () => STREAM_CONFIG,
      onEvent: (event) => events.push(event),
      onActivity: () => {
        activity += 1;
        // Connection, then the keep-alive frame.
        if (activity === 2) {
          resolve();
        }
      },
    });
    t.after(stop);
  });

  assert.equal(activity, 2);
  assert.deepEqual(events, [], 'a keep-alive is not an appliance event');
});
