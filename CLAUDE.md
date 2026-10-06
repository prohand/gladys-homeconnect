# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Gladys Assistant **external integration** (Node 20+, ESM, no build step, one runtime
dependency: `@gladysassistant/integration-sdk`) that brings every appliance reporting to
[Home Connect](https://www.home-connect.com/) into Gladys: Bosch, Siemens, Neff, Gaggenau, Balay,
Constructa, Profilo, Thermador. It reads states, receives changes in real time through the Home
Connect **event stream (SSE)**, and sends commands. Gladys 5.1+ adds widgets, scene triggers and
scene actions. The user brings the Client ID / Secret of a Home Connect developer app and links
the account with OAuth2.

## Commands

```bash
npm install
npm test                                     # node --test (built-in runner)
node --test test/mapping.test.js             # one file
node --test --test-name-pattern "DoorState"  # one test by name
npm run lint                                 # eslint .
npm run format:check                         # prettier --check . (CI gate)
npm run format                               # prettier --write .
```

CI runs `format:check`, `lint`, `test`. Releases: **Actions → Release** only (bumps
`package.json`, manifest `version` + `docker_image`, re-runs Prettier, tags, builds).

## Architecture

```
index.js                    SDK wiring: OAuth, initialize(), event stream lifecycle
src/config.js               defaults, language, scope, tokens (readTokens), Gladys poll tick
src/oauth-session.js        pending OAuth state, persisted so a restart mid-sign-in still works
src/homeconnect/oauth.js    authorize URL, code exchange, refresh, ReauthorizationRequiredError
src/homeconnect/api.js      REST client (rate limits, Retry-After, simulator switch)
src/homeconnect/events.js   SSE client on fetch + ReadableStream, idle timeout, backoff
src/homeconnect/constants.js API paths, SSE frame types
src/mapping/catalog.js      Home Connect dotted key -> Gladys feature (THE place to add support)
src/mapping/appliance.js    one appliance -> discovery payload, states, commands
src/mapping/describe.js     readable texts for enums / programs
src/appliances.js           ApplianceRegistry: account, snapshots, polls, setValue, events
src/scenes.js               SceneBridge: triggers from events, scene actions
src/widgets.js              WidgetBridge: dashboard widgets
```

### Invariants worth knowing

- **One appliance module driven by a catalog**, not one module per appliance kind. Features are
  built from the keys an appliance actually reports; supporting a new key is one entry in
  `src/mapping/catalog.js`.
- **The event stream is the main channel** (`cloud_push`): one long-lived request carries the
  events of every appliance; `STATUS`/`NOTIFY` items are applied as states. It is dropped and
  reconnected after 180 s of silence (keep-alives come every ~55 s) and with exponential backoff
  on errors. It stops on Gladys disconnection and restarts in `initialize()`.
- **Home Connect quotas are strict**: polling is only a safety net (default 900 s), honoured by
  the registry on top of the 60 s Gladys tick. Devices carry `should_poll: true` with an allowed
  `poll_frequency` (1 s–60 s in ms); Gladys reads the flag at creation only, so index.js also runs
  its own one-minute loop over `gladys.devices` through the same `registry.poll()`.
- **OAuth tokens live in the Gladys config**, outside `config_schema`, written with
  `gladys.setConfig()` (`persistTokens`). The OAuth `state` is also persisted, so a container
  restart during sign-in still validates the callback. Never log tokens or the client secret.
- **States sent before a device exists are dropped by Gladys**: `onDeviceCreated` /
  `onDeviceUpdated` re-publish from the snapshot.
- **Every feature declares `min`/`max`** (NOT NULL in Gladys). Door polarity follows Gladys
  (1 = open).
- Widget, trigger and action keys are stored by users: never rename them.

### Manifest

`test/manifest.test.js` keeps `gladys-assistant-integration.json` in sync with `DEFAULT_CONFIG`,
the bounds and the handlers (`gladys_version >=5.1.0`).

## Testing

No network: `test/helpers/fixtures.js` holds Home Connect payloads, `fetch` (REST and SSE) is
stubbed, `test/helpers/fakeGladys.js` stands in for the SDK.

## Conventions

Prettier formats, ESLint catches mistakes. Comments explain **why**. User-facing messages are
bilingual `{ en, fr }`; user docs in `docs/en.md` and `docs/fr.md`, kept in sync. The container
rootfs is read-only: write nothing.
