# Home Connect — Gladys Assistant integration

External integration bringing **every appliance that reports to
[Home Connect](https://www.home-connect.com/)** into
[Gladys Assistant](https://gladysassistant.com): Bosch, Siemens, Neff,
Gaggenau, Balay, Constructa, Profilo and Thermador.

Built from the official
[`integration-template-js`](https://github.com/GladysAssistant/integration-template-js)
on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

User documentation: [English](./docs/en.md) · [Français](./docs/fr.md).

## Design in one paragraph

Home Connect describes every appliance with the same vocabulary — a flat list of
dotted keys (`BSH.Common.Status.DoorState`, `Cooking.Oven.Status.CurrentCavityTemperature`)
whose values are enums, booleans or numbers. So this integration is **not** one
module per appliance kind. It is one appliance module driven by a **catalog**
that maps Home Connect keys to Gladys features, and a registry that walks the
keys an appliance _actually_ reports. A dishwasher and a wine cooler go through
the same code and come out with completely different feature sets; supporting a
new key is adding one entry to [`src/mapping/catalog.js`](./src/mapping/catalog.js).

## What ends up in Gladys

| Home Connect                                    | Gladys                                            |
| ----------------------------------------------- | ------------------------------------------------- |
| `BSH.Common.Setting.PowerState`                 | `switch` / `binary`, writable                     |
| `BSH.Common.Status.OperationState`              | `text`, plus a synthetic _Program running_ switch |
| `BSH.Common.Status.DoorState`                   | `opening-sensor` / `binary`                       |
| `BSH.Common.Option.RemainingProgramTime`        | `duration` / `integer`, seconds                   |
| `BSH.Common.Option.ProgramProgress`             | percentage sensor                                 |
| `Refrigeration.FridgeFreezer.Setting.Setpoint*` | `thermostat` / `target-temperature`, writable     |
| `Cooking.Oven.Status.CurrentCavityTemperature`  | `temperature-sensor` / `decimal`                  |
| `Cooking.Common.Setting.Lighting(Brightness)`   | `light` / `binary` and `brightness`, writable     |
| `*.Event.*` (salt low, water tank empty…)       | binary alert features                             |
| `ConsumerProducts.CoffeeMaker.Status.Beverage*` | `counter-sensor`                                  |
| appliance `connected` flag                      | binary feature + `cloud` / `unreachable` badge    |

Appliance-specific bounds are not guessed: setpoint min/max and the `off` value
`PowerState` accepts are read from each setting's own `constraints`, so an oven
that only goes to `Standby` is never sent an `Off` it would refuse.

## Dashboard widgets, scene triggers and scene actions

Gladys 5.1 opened three surfaces to external integrations, and this one answers
all three. They are declared in the manifest and handled in
[`src/widgets.js`](./src/widgets.js) and [`src/scenes.js`](./src/scenes.js).

| Surface          | What it adds                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `widgets`        | two dashboard cards: the whole account at a glance, and one appliance with its controls                         |
| `scene_triggers` | program started / finished / aborted, and the appliance notifications (salt low, water tank empty, door alarm…) |
| `scene_actions`  | start, stop, pause, resume a program, and read an appliance's status into the following actions of the scene    |

The line between the three and the device features is the one the platform
draws. A VALUE is a feature: the registry publishes it, the dashboard renders
it, a scene reads it as a condition — nothing here duplicates that. What these
surfaces add is what a feature cannot carry:

- a **sentence**. "Running · Auto2 · 30 min" is three features on a device page
  and one line on a widget card, which is the form a kitchen is read in. The
  moving numbers inside it stay bound to their features (`device_feature`), so
  they follow the states over the core's real-time path instead of waiting for a
  re-pull.
- an **event with details**. "A program finished" exists as a binary feature
  already; "the DISHWASHER finished AUTO2" does not, and a scene that sends a
  notification wants the second one. Hence `{{triggerEvent.data.program}}`.
- an **operation with a result**. Starting a program is a feature write; reading
  back what is running, for the next action of a scene to use, is not something
  a feature does. `appliance_status` answers from the snapshot the event stream
  already keeps fresh, so a scene polling it every ten minutes costs zero Home
  Connect requests.

Two rules follow from the platform's own doctrine, and the tests pin both: an
alert that _clears_ fires no trigger (only the raising edge is an event), and a
program start is detected as a TRANSITION of the operation state — Home Connect
restates `Run` on every reconnection, and a scene must not announce the same
cycle twice.

Widget contents are validated in the tests with the SDK's own
`validateWidgetContent`: the Gladys core silently trims a card that exceeds its
budget (8 components, 6 tiles, 1 status list, 4 buttons), so a content that
ships is a content the validator accepts with zero findings.

## Real time

The integration holds the Home Connect **Server-Sent-Events** stream open
(`GET /api/homeappliances/events`), so state changes — including the ones made on
the appliance itself — reach Gladys in about a second. Unlike a webhook relay,
that stream is authenticated, ordered and complete, so its values are applied
directly rather than used as a mere refresh trigger.

Polling stays armed behind it (`poll_frequency`, default 900 s) because Home
Connect closes the stream roughly once a day, and a reconnection that lands badly
must not silently freeze every device.

Gladys stores a device's `poll_frequency` as an enum of milliseconds whose
slowest value is one minute, and rejects anything else (`invalid poll
frequency`). Devices are therefore published on that one-minute tick and the
registry drops the ticks that arrive before the configured interval has elapsed,
so the quota-facing behaviour is the one the user asked for.

## Project structure

```
.
├─ index.js                          # SDK wiring: handlers, OAuth, lifecycle
├─ src/
│  ├─ appliances.js                  # registry: discovery, events, commands, polling
│  ├─ widgets.js                     # dashboard widgets: contents and buttons
│  ├─ scenes.js                      # scene triggers and scene actions
│  ├─ config.js                      # config defaults + normalization
│  ├─ homeconnect/
│  │  ├─ constants.js                #   the Home Connect vocabulary
│  │  ├─ oauth.js                    #   authorization URL + token exchange/refresh
│  │  ├─ api.js                      #   REST client (tokens, rate limit, errors)
│  │  └─ events.js                   #   Server-Sent-Events stream
│  └─ mapping/
│     ├─ catalog.js                  #   Home Connect key -> Gladys feature
│     ├─ appliance.js                #   appliance snapshot -> device + states
│     └─ describe.js                 #   appliance snapshot -> readable summary
├─ docs/en.md, docs/fr.md            # user documentation, re-hosted by Gladys
├─ gladys-assistant-integration.json # manifest (config schema, actions, image)
├─ Dockerfile                        # Node 24 Alpine, read-only rootfs ready
└─ test/                             # `node --test`, no test framework to install
```

## Authorization

Home Connect uses OAuth2 authorization code grant, and the Gladys core relays the
whole browser flow: the manifest declares an `oauth2` config field, the
Configuration screen renders a _Connect_ button, and the integration answers
`onOAuthAuthorizeUrl` / `onOAuthCallback`. Gladys knows nothing about Home
Connect; [`src/homeconnect/oauth.js`](./src/homeconnect/oauth.js) is the only
place that does.

Tokens are stored as config keys **outside** `config_schema` — never rendered,
never sent to the frontend — and the refresh token, which Home Connect rotates on
every use, is persisted on each rotation. When it is finally refused, the user
sees _"authorization expired, click Connect again"_ in the Configuration screen
instead of an integration that is silently doing nothing.

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="home-connect" \
LOG_LEVEL=debug \
npm start
```

Enable **Use the Home Connect simulator** in the configuration to develop against
`simulator.home-connect.com` without owning an appliance.

## Quality checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm test               # node --test
```

The same three run on every push and pull request
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

Before tagging a release, the store validator can be run locally:

```bash
npx github:GladysAssistant/integration-store .
```

## Publishing

1. Add the GitHub topic `gladys-assistant-integration` to this repository.
2. **Actions → Release → Run workflow**, pick `patch`, `minor` or `major`. The
   workflow bumps `package.json` and the manifest (`version`, `docker_image` and
   `cover_image`), pushes the `vX.Y.Z` tag and builds the `linux/amd64` +
   `linux/arm64` image to `ghcr.io`.
3. The decentralized indexer picks up the new manifest version and Gladys offers
   a one-click install or update.

The manifest declares the catalog shelf the integration sits on:
`categories: ["appliances"]` (Gladys 4.86+, 1 to 3 keys among `climate`,
`lighting`, `energy`, `security`, `multimedia`, `appliances`, `environment`,
`protocols`, `network`, `notifications`, `assistants`, `services`). Home Connect
drives ovens, dishwashers, washing machines, dryers, fridges, coffee machines and
hoods — the lights and setpoints it exposes are internal to those appliances, not
room lighting or home climate, so `appliances` alone is the honest placement.
Declaring the field requires a `gladys_version` minimum of **4.86.0 or later**:
older cores reject unknown manifest fields, and the store validator enforces the
coupling (a manifest test pins it too).

The same coupling applies, one notch higher, to the three capability fields
`widgets`, `scene_triggers` and `scene_actions`: they were added in **Gladys
5.1.0**, so the manifest declares `gladys_version: ">=5.1.0"`. That is a real
cost — an instance still on 4.x no longer sees the update in its catalog — and
it is the only way to declare them: an older core validates manifests with a
strict field allowlist and refuses to install one carrying a field it does not
know, which would fail at install time with a cryptic error instead of a clean
"requires Gladys ≥ 5.1" filter.

Replace `cover.png` (800×534 px, ≤ 150 KB) before publishing — the bundled one is
the template's gradient placeholder.

`cover_image` points at the raw file **on the release tag**, never on `main`, and
the Release workflow re-pins it on every bump. A branch URL is stable forever, so
the CDN and the indexer keep serving whatever cover they saw first: replacing
`cover.png` alone then changes nothing on the site or in the app. A new cover
therefore only becomes visible once a release ships the new tag URL.

## Notes and limits

- **Cloud only.** Home Connect appliances have no local API. No internet, no
  integration — a property of the appliances, not of this code.
- **Starting a program** runs the program already selected on the appliance; it
  does not pick one. That is the only start the appliances accept without
  re-declaring every option, and it requires _remote start_ to be armed on the
  appliance.
- **Quotas.** Home Connect enforces a request quota. Discovery reads a handful of
  endpoints per appliance and caches the constraints for good; polling reads one
  appliance at a time, not the whole account.
- Requires **Node.js ≥ 20** (global `fetch`, web streams); the only runtime
  dependency is the Gladys SDK.

## License

Apache-2.0
