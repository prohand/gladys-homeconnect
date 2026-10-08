import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import { RateLimitedError } from '../src/homeconnect/api.js';
import { ReauthorizationRequiredError } from '../src/homeconnect/oauth.js';
import { ACCOUNT_RETRY_DELAYS_MS, createStartup } from '../src/startup.js';

const config = normalizeConfig({ client_id: 'abc', client_secret: 'sec' });

/**
 * A startup wired to fakes. `reads` lists what each successive account read
 * does: a number of appliances, or an error to throw.
 */
function createHarness(reads) {
  const log = { streamStarts: 0, statuses: [], refreshes: 0 };
  const timers = [];
  const registry = {
    async refresh() {
      const outcome = reads[log.refreshes];
      log.refreshes += 1;
      if (outcome instanceof Error) {
        throw outcome;
      }
      return outcome;
    },
  };
  const startup = createStartup({
    registry,
    api: { isAuthorized: () => true },
    getConfig: () => config,
    startStream: () => {
      log.streamStarts += 1;
    },
    stopStream: () => {},
    reportStatus: async (connected, message) => {
      log.statuses.push({ connected, message });
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    },
  });
  /** Fire the pending retry, as the clock would. */
  const fireRetry = async () => {
    const timer = timers.filter((candidate) => !candidate.cleared).at(-1);
    assert.ok(timer, 'a retry is armed');
    timer.cleared = true;
    await timer.callback();
    return timer.delay;
  };
  const pendingRetries = () => timers.filter((timer) => !timer.cleared);
  return { startup, log, fireRetry, pendingRetries };
}

const networkDown = () => new Error('getaddrinfo EAI_AGAIN api.home-connect.com');

test('a failed first read still starts the event stream and retries on a growing delay', async () => {
  const { startup, log, fireRetry } = createHarness([networkDown(), networkDown(), 2]);

  await startup.initialize();

  assert.equal(log.streamStarts, 1, 'the real-time channel does not wait for the account read');
  assert.equal(log.statuses.at(-1).connected, false);
  assert.match(log.statuses.at(-1).message.en, /retrying/);

  assert.equal(await fireRetry(), ACCOUNT_RETRY_DELAYS_MS[0]);
  assert.equal(log.refreshes, 2);
  assert.equal(await fireRetry(), ACCOUNT_RETRY_DELAYS_MS[1]);
  assert.equal(log.refreshes, 3);
  assert.deepEqual(log.statuses.at(-1), { connected: true, message: undefined });
  assert.equal(log.streamStarts, 1, 'the retry reads the account, the stream is already up');
});

test('the retries settle on the longest delay', async () => {
  const failures = Array.from({ length: 6 }, networkDown);
  const { startup, fireRetry } = createHarness(failures);

  await startup.initialize();
  const delays = [];
  for (let i = 0; i < 5; i += 1) {
    delays.push(await fireRetry());
  }

  assert.deepEqual(delays, [...ACCOUNT_RETRY_DELAYS_MS, ...Array(2).fill(15 * 60_000)]);
});

test('a rate-limited read waits at least as long as Home Connect asked', async () => {
  const { startup, log, fireRetry } = createHarness([new RateLimitedError(30 * 60_000), 1]);

  await startup.initialize();

  assert.equal(log.streamStarts, 1);
  assert.equal(await fireRetry(), 30 * 60_000);
  assert.equal(log.statuses.at(-1).connected, true);
});

test('an expired authorization is reported and not retried', async () => {
  const { startup, log, pendingRetries } = createHarness([
    new ReauthorizationRequiredError('invalid_grant'),
  ]);

  await startup.initialize();

  assert.equal(log.streamStarts, 0);
  assert.match(log.statuses.at(-1).message.en, /Connect again/);
  assert.equal(pendingRetries().length, 0);
});

test('a new initialization cancels the retry armed by the previous one', async () => {
  const { startup, log, pendingRetries } = createHarness([networkDown(), 3]);

  await startup.initialize();
  assert.equal(pendingRetries().length, 1);

  await startup.initialize();
  assert.equal(pendingRetries().length, 0, 'the read succeeded, nothing left to retry');
  assert.equal(log.refreshes, 2);
});
