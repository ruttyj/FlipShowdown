# Testing

How this project is tested, and what has bitten agents before. The commands are the
`package.json` scripts (root and `server/`); this page explains which to use and why.

## Where a test goes

| What you're testing | Runner | Location |
| --- | --- | --- |
| Pure client logic (`src/lib`, `src/api`) and the rule kernel (`shared/`) | `node:test` | `tests/*.test.js` |
| React hooks and components | Vitest + jsdom + Testing Library | `tests/ui/**/*.test.jsx` |
| Server (actions, HTTP, realtime, config) | `node:test` | `server/test/*.test.js` |
| The client's realtime joined to the real hub over a real socket | `node:test` | `server/test/realtimeChannel.test.js` |
| Whole flows in real browsers | Playwright | `e2e/*.spec.js` |
| Desktop launcher main process (`desktop/src/main`) and packaging scripts | `node:test` | `desktop/test/*.test.js` |
| Desktop launcher UI (`desktop/src/renderer`) | Vitest + jsdom + Testing Library | `desktop/test/renderer/*.test.jsx` |

**Prefer pure helpers.** When logic lives inside a component or hook, move it into `src/lib/`
with identical behaviour and test it with `node:test`. That suite is fast and needs no DOM.
Most of `src/lib` was built this way (`maxScore`, `scoreEntryCards`, `handEntry`, `turnOrder`, `autoJoin`,
`editableRounds`, `scanWithFallback`, `scoreLifecycle`, `chatSends`, ...).

**Every file under `tests/ui/` uses `.jsx`**, tests and helpers alike. On Node 20,
`node --test tests/` also picks up `tests/ui/**/*.test.js` and fails on its Vitest imports.

## Rules

- **Bug fixes go red first.** Write the test that reproduces the exact failure scenario,
  watch it fail, then fix it. Record the agreed behaviour in [decisions.md](decisions.md).
- Name tests with a plain-English sentence describing the behaviour, group them with
  `// --- Section ---` comments, and build data with small builders (`makeRoom`, `makePlayer`).
- Inject dependencies (storage, `fetch`, clocks, `api` objects) instead of mocking modules.
- In Vitest, mock only `src/api/game.js`, `src/api/backend.js` and `src/api/ai.js`, and
  never the unit under test. There are two accepted exceptions: `sonner` in
  `useActionRunner.test.jsx`, and `emoji-picker-react` in `ChatDialog.test.jsx` (the real
  picker grid took ~10 s and timed out under load).
- Find elements by role, label and text. No snapshot tests.
- For "nothing happened" assertions, use fake timers, or wait for a positive signal and then
  assert the absence. Fixed sleeps let these pass for the wrong reason.

## Fixtures

- **`tests/ui/fixtures/renderGameHook.jsx`** renders a hook or page inside the app's
  providers with a fake API (`fakeApi.jsx`). It also provides `makeRoom`/`makePlayer`,
  `emitRealtime`, a confirm/ask answer queue and `resetFakeApi()`. The required `vi.mock`
  lines and the usage are in its header comment. confirm and ask share the queue and a leftover
  answer isn't flagged, so when a prompt goes away, remove its answer from every test by hand:
  one left behind answers the next prompt instead.
- **`tests/fixtures/serverRoom.js`** is a real room: the server's action code on SQLite in a temp
  directory, in this process with no HTTP. `tests/scoreLifecycle.test.js` uses it directly and calls
  `sync()` to say when the client hears about the room.
- **`tests/ui/fixtures/testRoom.jsx`** plugs that room into the fake API for hook and page tests, through
  `renderGameHook`'s `testRoom` option. Use it for anything that depends on real replies, conflicts or the
  room's state, and don't hand-type a conflict it can produce. `holdReplies()` and `holdEvents()` choose
  which arrives first, as real life doesn't fix that. Keep `fakeApi` for tests that only need shapes.
  Another player's move is `room.as(name, action, body)`, inside `act` unless its events are held. Call
  `room.close()` in `afterEach`.
- **`tests/ui/fixtures/renderRoomScreen.jsx`** renders a room screen with the real `useGameRoom` result.
  The room's data goes through the real reads, and an override replaces one value of the interface; naming
  one it doesn't have throws. A test can't then pass on a shape production never produces, so use this rather
  than hand-building a `game` object. What a tap runs is a spy; test what it does against the hook or a test room.
- **`fakeApi.jsx`** fakes the connection (`realtime`), but `roomChannel` is the real module on top of
  it, so hook tests send wire messages with `emitRealtime` and assert on `view.realtime`. Each reset
  makes a new channel, so vote state doesn't carry from one render to the next: emit it after
  rendering. A callback handed to `fakeBackend.entities.<Name>.subscribe` needs its second argument
  (`{ room_version, seq }`), as the real connection always passes one.
- **`tests/ui/setup.js`** runs before every Vitest file. It stubs what jsdom lacks
  (`matchMedia`, `IntersectionObserver`, `ResizeObserver`, `navigator.wakeLock`,
  `BroadcastChannel`, and `Element.scrollTo`/`scrollIntoView`), and clears storage and mocks after each test. Canvas
  `getContext` returns null, so the logo uses `DEFAULT_LOGO_FIT` (`src/lib/logoFit.js`); test the fitting
  itself with a fake measure in `tests/logoFit.test.js`, not through the component. When a
  component starts using another browser API that jsdom lacks, stub it here, not per file.
- **`e2e/fixtures/server.js`** gives each test its own real server (free port, temp
  `DATA_DIR`, `AUTH_MODE=dev`) with `start`/`stop`/`restart`. Extra server env goes through
  `test.use({ serverEnv: { ... } })`, never `process.env`, because workers are reused.
  `e2e/fixtures/players.js` has `newPlayer(browser, name)`: a signed-in player in its own
  browser context. Usage is in each file's header comment.
- **`server/test/fixtures/legacyDb.js`** writes a `flip7.db` as servers before migrations left it (the
  old schema, game records as JSON in `records`, no `schema_migrations`) and inserts raw rows into it.
  Close it, then open the store on the same folder to run the migrations (`legacyUpgrade.test.js`).
  To test one migration alone, run `runMigrations(db, MIGRATIONS.filter(...))` up to it
  (`migrations.test.js` stops at 0002).

## Before calling a change done

1. `npm run test:all`, `npm run lint`, `npm run typecheck` (it must stay at 0 errors) and
   `npm run build`.
2. `npm run coverage` and `cd server && npm run coverage`. Each fails when an area drops below
   its target. Targets: server, `shared/` and `src/lib`+`src/api` 98% lines / 95% branches; hooks 90/85;
   components and pages 80/70. `src/components/ui/**` and the generated shadcn helpers are
   excluded. `scripts/merge-coverage.mjs` merges the node and Vitest reports, because a client
   file often gets covered by only one of them.
3. For UI flows, `npx playwright test --project=chromium-desktop --project=pixel-7`.
   CI (`.github/workflows/test.yml`) runs Chromium on pull requests, and every project on
   pushes to `main`.
4. `npm run scan:secrets` (see below).

## Secret scan

`npm run scan:secrets` runs Betterleaks over every commit and over the files that differ from
HEAD, including new untracked ones, so run it before committing. Files git ignores, such as
`.env`, are never scanned. The first run downloads the pinned release into
`node_modules/.cache/betterleaks`. CI runs it with the full history (`fetch-depth: 0`).

When it reports a finding:

- **A real secret** that is only uncommitted: move it to `.env` and read it from the
  environment. If it was committed, rotate it, because removing it from the history doesn't
  undo the leak.
- **A false positive**: add an `[[allowlists]]` entry to `.betterleaks.toml` that matches that
  exact value, with a description saying why it isn't a secret. Don't allowlist whole files or
  rules. The RFC 6455 sample WebSocket key in the realtime tests is the existing example.

To update Betterleaks, change `BETTERLEAKS_VERSION` and every hash in
`scripts/scan-secrets.mjs`. Each `assetSha256` is the asset's `digest` in the GitHub release
API, and each `binarySha256` is the hash of the binary inside it.

## Desktop launcher

- **Main process.** No test starts Electron, a server or `cloudflared`. Every module takes its
  Electron and OS pieces as arguments: `serverProcess` and `tunnelProcess` take a `fork`/`spawn` that
  returns a `FakeChild` (an `EventEmitter` with fake stdout/stderr whose tests emit log lines and
  exits), the health check, Gemini check, update check and cloudflared fetch take a fake `fetch`, and
  time is injected too: `hostingSession` takes a `timers` object (`createFakeTimers` in its test fires
  backoffs by hand) and a `now` clock, `ipc` takes `now`/`sleep`, and `retryPolicy` is pure on `nowMs`. `keepAwake` gets a fake `powerSaveBlocker` and `powerMonitor`, `ipc` a fake `ipcMain`.
  `settingsStore` takes a fake `safeStorage` (`createFakeCipher` in its test: prefix "encryption" that
  refuses foreign ciphertext, with switches for no keyring, Linux `basic_text` and a method that
  throws). The file-mode test is skipped on Windows, which has no POSIX modes.
  `main.js` is untested glue and is excluded from coverage. `ipc` also takes a fake `windowVisibility`
  (`show()` fires the shown listeners). The server's side of the launcher link takes a fake parent port:
  `startTestServer({ launcherPort })` (a `createMessageLog` with `postMessage`) and
  `launcherReportDelayMs`; `launcherReporter.test.js` uses `node:test`'s `mock.timers`, which prints an
  ExperimentalWarning on Node 20.
- **UI.** `desktop/test/renderer/fakeLauncher.jsx` builds a fake `window.launcher` (every method a
  `vi.fn`) and pushes events with `emitState`, `emitUrlChanged` and `emitPowerStatus`; its header
  shows the usage. Like the real bridge, its `start()` and `retry()` resolve only after the session
  settles, so tests can see the pending state. These tests run in the root Vitest suite with the app's `tests/ui/setup.js`.
- **Looking at it in a browser.** The page throws without `window.launcher`. A throwaway
  `desktop/src/renderer/_preview.html` that sets a fake bridge (methods as in `fakeLauncher.jsx`) and
  then imports `main.jsx` works on `npx vite --config desktop/vite.config.js` (port 5174). Its CSP needs
  `script-src 'self'` and `connect-src 'self'`, which the dev plugin rewrites, or the page answers 500.
  Delete it afterwards. jsdom has no layout, so scroll and overflow bugs only show here: compare
  `document.documentElement.scrollHeight` with `innerHeight` to catch a second, page-level scrollbar
  (an `sr-only` element with no positioned ancestor once did this).
- **Coverage.** `desktop/src/main` (minus `main.js`) is measured by the root node run and
  `desktop/src/renderer` (minus `main.jsx`) by the Vitest run; both are areas in
  `scripts/lcov/areas.mjs`.

## Measuring the scan prompt

`server/eval/scanEval.js` runs labelled photos through real models, so it spends Gemini quota. It is
run by hand and is in neither `test:all` nor the coverage gate, which only counts `server/src/`; its
parsing and metrics are tested with a fake Gemini in `server/test/scanEval.test.js`.

```sh
cd server
GEMINI_API_KEY=... node eval/scanEval.js --photos <folder> --models gemini-3.5-flash-lite,gemini-3.8-flash
```

Labelled photos are in `server/test/fixtures/card-images`, one folder per deck. They are AI-repainted
cards in our own design, not the publisher's artwork, so the eval measures those rather than the real
deck. Keep real-deck photos out of the repo (copyright); test against them from a local folder. `vengeance` is the set to
pass as `--photos`. `classic` follows the same naming with `plus2` for a +2 card, but the script can't use it yet: it always
sends the Vengeance prompt and has no token for x2 or +N. A photo's name is its hand: `lucky13_13_5_minus4.jpg`. The tokens are `1`–`13`, `zero`, `unlucky7`,
`lucky13`, `div2`, `minus2`–`minus10`, and `action` or `none` for something in frame that isn't a
scoring card. Anything after `__` is a note, for several photos of one hand (`13_13__fanned.jpg`). A
name it can't read stops the run before any call. For each model it prints per-card precision and
recall, photos exactly right, every false special card, and whether the target in X46 was met. A failed
call is never exact, and any failure misses the target.

**Prepare the photos first.** They go up as they are, while the app sends a JPEG at quality 0.85 with a
1024 px long edge, so a full-size photo could pass here and miss in production. Export them to match:

```sh
magick input.jpg -auto-orient -resize "1024x1024>" -quality 85 output.jpg
```

A photo with a long edge over 1024 px, over the server's 4 MB cap, or with a size that can't be read
stops the run before any call. To try a larger resize (the first thing to try if the target is missed), export at that size and pass `--max-edge <px>`. The run can't check JPEG quality or tell a PNG
from what the app would send, so keep to the recipe. Results at another limit only apply once
`SCAN_IMAGE_MAX_SIZE` in `CardScanner.jsx` changes to match.

## README screenshots

`npm run screenshots` (`scripts/screenshots.mjs`) rebuilds both frontends and rewrites
`docs/images/`. It plays a real round on an e2e fixture server, fakes `/api/ai/*` in the browser (no
Gemini key needed), and gives the launcher page a fake `window.launcher`. It also draws the orange
highlights. Rerun it after a visible UI change and look at every image before committing. The room
code changes on every run.

## Gotchas

- **`shared/` has to reach every package.** `Dockerfile` copies it into both stages, and `shared/package.json`
  marks it as ES modules because the runtime image has no `package.json` above it. A server import that
  works locally can still crash the image, so build the image after adding a folder like this.
- `shared/` is only measured by the root coverage run, so a shared file needs tests under `tests/`:
  the server's run counts `server/src/` alone. Import it by relative path, as `node --test` doesn't know
  the `@` alias. The Dockerfile copies it to `/web/shared` and `/app/shared`, so those paths also work in the image.
- **The Docker web stage copies files one by one, and no gate builds the image.** Whatever `vite.config.js`
  reads (`scripts/third-party-notices.mjs`, `LICENSE`, the server's lockfile and `node_modules`) must be
  copied in, or `npm start` fails while every gate passes. Run `npm start` after changing what the build reads.
- **Install server dependencies with `cd server && npm install`.** Running
  `npm --prefix server install` from the repo root adds a bogus `"flip-showdown": "file:.."`
  dependency to `server/package.json`, which breaks the Docker `npm ci --omit=dev`.
- e2e needs the server's dependencies installed. The frontend is rebuilt automatically when
  `src/` is newer than `dist/`; delete `dist/` if in doubt.
- **iphone-14 (WebKit) e2e is unreliable on Windows** and is non-blocking in CI. 4–5 tests fail
  even with one worker, and WebKit there also pauses animation frames under load, which breaks
  Playwright's stability checks. The investigation is deferred as package W5.7. Its handoff and
  work-in-progress are on branch `test/W5.7` (`docs/test-runs/W5.7.md`). Specs click through a
  `tap()` helper that forces the click on WebKit.
- **Phone testing on the dev server (`npm run share`) differs from production.** Leaving the
  browser drops Vite's HMR socket. The page stays (X26), but hot updates stop until a manual
  refresh. To check a real reload, restart Vite while a page is open.
- **"the host edits an old round" (`e2e/host.spec.js`) sometimes fails in a full run**, on Chromium, and
  passes alone and in a run of that file. The cause isn't known yet.
- **"a new host gets the mode picker and the old host loses it" (`e2e/host.spec.js`) failed once on pixel-7 in
  a full run** and passed 3 of 3 alone. It never opens the card editor. The cause isn't known yet.
- **"Brutal: a Flip 7 takes 15 from a rival" (`e2e/host.spec.js`) failed once on chromium-desktop in a full
  run** and passed 3 of 3 alone. The cause isn't known yet.
- Playwright runs at most 4 workers. Each test runs its own server and several browser contexts.
- Playwright puts a space between the flex children of a button when it builds the accessible
  name; jsdom doesn't. Match names with several parts loosely.
- The emoji picker lists a used emoji again under "Frequently Used", so by the second send
  `getByRole('button', { name: 'grinning face' })` has 3 matches and the early ones sit under a
  sticky category label that blocks the click. Pick `.last()` (the main list).
- Anything that waits for the offline-host grace (2 minutes) sets `HOST_OFFLINE_GRACE_SECONDS`
  low: `env` in `startTestServer`, `serverEnv` in e2e. The unlock timer runs on the real clock
  even when the test fakes `realtimeNow`.
- A single tap on the chat button acts only after `DOUBLE_TAP_MS` (X79): wait for its result with
  `findBy`/`waitFor`, and let the window pass before a second tap that must count as a new single
  tap, or it becomes a double tap. In e2e, `dblclick()` opens the chat dialog.
- With fake timers and framer-motion, flush pending timers (`vi.runOnlyPendingTimers()`)
  before `vi.useRealTimers()`, or animations stall in the next test. Flushing isn't enough when
  a test ends with an infinitely repeating animation still mounted (e.g. a full-size
  `EmojiAnimation`): exit animations stall in every later test in the file. Unmount with
  `cleanup()` in an `afterEach` that runs before the flush, or put new tests above such a test.
- React 18 (`createRoot`) flushes a click's state update when the outermost `act` ends, not when
  the handler returns. Two `fireEvent` calls inside one `act` therefore both hit the pre-update
  DOM and the same handler closure, as a fast double tap can. Use that to test that a handler is
  idempotent. Separate `act`s (or separate user-event calls) model taps that see the re-rendered
  DOM.
- A Radix `Dialog` with no `DialogTrigger` drops focus to the page on close: its own close handler
  only knows the trigger, so nothing restores the element that opened it. Pass `onCloseAutoFocus`
  (`RulesDialog` takes `getReturnFocusTarget`).
- An open modal Radix `Dialog` sets `pointer-events: none` on the body, so user-event refuses to click
  the page under it. Tap the backdrop by its test id (`mode-picker-backdrop`). A dialog under another
  is `aria-hidden`, so its contents need `{ hidden: true }` in role queries.
- The server holds an `entry-status` within 1 s of the same player's last one, on the injected
  `realtimeNow` clock, so a test sending two in a row has to advance `clock.time` between them. The
  held state is then applied by a real timer, which ignores that clock, so a test of it really waits.
- `useGameRoom`'s shared dialogs live in `RoomDialogs`, mounted by `GameRoom`, so a screen test sees no
  confirm dialog. Test a prompt against the page (`GameRoom.test.jsx`) or through `dialogs.confirmation`.
- Saving a draft doesn't re-render `useScoreEntry`, so anything read from storage at render can be
  several saves behind. `scoreLifecycle` reads the stored draft before writing one, and a test reading
  `pendingCards` after a save needs a `rerender`.
- `npm test` and `npm run test:ui` need the server's dependencies, as the room fixtures run its code
  (`cd server && npm install`).
- Two writes in a room fixture can land in the same millisecond, which a real tap can't, so their
  `updated_date`s can tie. Don't write a test that needs them to differ.
- jsdom has no `AnimationEvent`, so React listens for `webkitAnimationEnd` there and
  `fireEvent.animationEnd` silently does nothing. Fire
  `new Event('webkitAnimationEnd', { bubbles: true })` instead (`ChatMuteToggle.test.jsx`).
- A new game mode has to pass the checks in `tests/gameRules.test.js`, which read its theme block
  from `src/index.css`: AA white text on the background, a chat mute pulse that shows up on it, and AA on
  every `--ui-*` and `--tile-*` pair. An opacity modifier does nothing on those tokens (`bg-ui-accent/50`
  comes out solid and no test notices), so use `color-mix` in an arbitrary value.
- A full-size chat emoji closes itself after 3 s (X35), and on CI the sender's clicks alone can take
  longer. An e2e test that needs it to stay up calls `keepFullEmojiOnScreen` (`e2e/other.spec.js`)
  before the page loads. A test passing locally in 2 s says nothing about this race.
- A player's name can also be in someone else's row ("−15 from Bea"), so `scoreboardRow(page, 'Bea')` in
  `e2e/host.spec.js` can match two rows in a Brutal game. Pick the player least likely to be named.
- `GAME_MODES` can grow, so a test of the picker's arrow keys or tabs walks the list rather than naming
  a number of modes. Tests that need an unknown mode use `'not-a-mode'`.
- A Vitest failure only under full-suite load usually means a slow file is hitting the 5 s
  timeout. Make the test fast; don't raise the limit.
- Any UI test that opens the chat dialog mocks `emoji-picker-react` (see `ChatDialog.test.jsx`).
  The real picker renders hundreds of emoji, and under the CI coverage run it pushed a dialog
  opened by a single tap (300 ms wait first) past `findBy`'s 1 s. It passed every time locally.
- **Server test data must be real** since the game tables have foreign keys (X84). A Player, RoundScore
  or ChatMessage needs an existing room (and a score an existing Player), a Player needs an email, and
  two Players in a room need different emails; otherwise the store answers 400/409. For records that
  belong to no room, use another entity (`Note`, through `ENTITIES`), which stays a JSON row.
- Every file under `server/test/` runs as a test file (`node --test` matches `test/` folders), helpers
  and fixtures included, so they must do nothing when imported.
- For raw SQL in a server test, open the database with `openDatabase(dir)` from `server/src/db.js`: it
  runs the migrations and turns foreign keys on, as the store does. Migrations never import `src/`, and
  every `NNNN_name.js` must be registered in `migrations/index.js` (`migrate.test.js` checks).
- Migration 0002 trims and lower-cases emails before 0004 reads them, so a legacy fixture's `' '` email
  is `''` by the time an orphan keeps it.
- A server test that seeds rooms straight into the database (`dataDir`, a legacy fixture) must date them
  recently (`last_activity_date`): the stale-room sweep runs at startup and deletes older ones (X81).
- Parallel work uses git worktrees under `.worktrees/` (excluded in `.git/info/exclude`),
  created from the working branch: `git worktree add .worktrees/<name> -b <branch> <base>`.
  Each worktree needs its own `npm install`.
- The game screens scroll inside Layout's `div.overflow-y-auto`, not the window, so
  `window.scrollTo` and full-page screenshots do nothing useful; scroll that div instead. Its
  `overflow-x-hidden` still lets focus and `scrollIntoView` shift it sideways, so anything wider
  than the screen (even a CSS transform) shows up as a page shifted left on a phone.
- `scrollIntoView` on an element still in a framer-motion entry animation (the game panels
  slide in from `y: 20`) measures it mid-slide and leaves it that much too high. Use
  `src/lib/scrollToTop.js`, which ignores transforms and honours `scroll-margin-top`; jsdom has
  no layout, so its tests stub `getBoundingClientRect`. The entry panels scroll themselves on
  open too, so to check a scroll aims at one element, give only that element a distinctive `top`
  and filter the `scrollTo` calls by it (the X76 tests). `closeScoreEntry` isn't one of
  `renderRoomScreen`'s action spies, so assert on what Back does, not on that call.
- The keyboard leaving the page scrolled (X50) only happens on a real iPhone. Playwright's WebKit has no
  on-screen keyboard, so `keyboardScrollReset` is tested with a fake window and needs a check by hand.
  The same goes for the entry panel holding the top while the keyboard opens (X56): without a keyboard
  Chromium's phone emulation lands correctly with or without the fix, so an e2e test can't catch it.
- **`server/node_modules` stays on the system Node ABI** for the server tests. Electron needs
  `better-sqlite3` built for its own ABI, so `desktop/scripts/stage.mjs` copies the server into
  `desktop/build/server` and rebuilds it there only. Never run `electron-rebuild` or
  `install-app-deps` against `server/`. After changing server dependencies, rerun the stage
  (`npm run desktop` does it).
- CI installs `desktop/` with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`: the tests never start Electron. A
  fresh worktree needs `npm ci` in the root, `desktop/` and `server/` before `test:all` passes.
- `@electron/rebuild` 4 wants Node >= 22.12. Local dev and most CI jobs run Node 20, which works
  today with an engines warning; the release workflow uses Node 22.
- **Node 22 reads `node --test <dir>/` as a file** and fails with "Cannot find module". The
  desktop tests run in the release workflow on Node 22, so `desktop/`'s script is bare
  `node --test`. Check a test script change there with `npx -p node@22 node --test`.
- Docker's `flip-showdown-dev-1` container holds `127.0.0.1:7007`, so with it running the launcher picks
  another port. That is the loopback check working, not a bug.
- **`tests/ui/lib/keepInClearView.test.jsx` failed once with a timer error** in a full run and
  passed on rerun. The cause isn't known yet.
- The preview tool sets `PORT=7000`, which the API server picks up, so it takes Vite's port and
  serves a stale `dist/`. Start `npm run dev` yourself and point the preview at
  `http://localhost:7000`.
