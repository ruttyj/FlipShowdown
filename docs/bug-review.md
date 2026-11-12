# Flip Showdown: bug and sync review

Review date: 2026-10-26. Scope: `src/` (frontend), `server/src/` (backend), deployment
scripts.

The goal is to **cut down how often players need to refresh the page**. Most refreshes come
from one design gap:

> The client builds its state once (REST fetch on load), then only patches it from realtime
> events. Nothing ever re-checks that state against the server. If an event is missed,
> arrives out of order, or a refetch fails, the screen stays wrong until the next event for
> that entity happens to arrive. Often none does, so the player refreshes.

The fixes in [Section 1](#1-top-fixes-biggest-win-for-fewest-changes) close most of that gap.
The other sections list the individual bugs.

Severity: 🔴 often causes a stuck or wrong screen · 🟠 wrong data or a confusing state in
specific situations · 🟡 minor or cosmetic.

---

## 1. Top fixes (biggest win for fewest changes)

1. **Refetch the room whenever the realtime socket (re)connects**, and on `resync`, instead
   of reloading the page (see 2.1, 2.2, 2.3). Add an `onReady`/`onReconnect` hook to
   `RealtimeConnection` and have GameRoom call `loadRoom()` from it. This one change heals
   almost every missed-event case.
2. **Add a connection-status banner** ("Reconnecting…", "Signed out, tap to log in"), so
   players know when the screen may be stale instead of guessing (2.4, 2.5).
3. **Derive `is_edit_mode` UI from the room record**, not local state, so players are never
   stuck behind "Host is editing scores" (3.6).
4. **Handle room deletion and being kicked** in the subscriptions (3.4, 3.5).
5. **Make round advancing safe to run twice** (one host on two devices is a normal setup
   here, because the README tells the host to open the app on their computer too) (4.1, 4.2).
6. **Add loading/disabled states and error toasts to every write** (5.1).
7. **Set `SESSION_SECRET` for `npm run dev`** and stop server restarts from forcing reloads
   (6.1, 6.2).
8. **Don't depend on the host's phone being awake**, and let players leave or be removed
   mid-game. A locked host phone or a player who walked away currently stalls the whole
   table (7.1–7.3).

---

## 2. Realtime / sync layer

### 2.1 🔴 Events between the initial fetch and socket "ready" are lost

**Status: fixed** (room refetch on `ready`, durable event log replay).
[GameRoom.jsx:123-166](../src/pages/GameRoom.jsx#L123-L166),
[GameRoom.jsx:169](../src/pages/GameRoom.jsx#L169),
[server/src/realtime.js:46-86](../server/src/realtime.js#L46-L86)

GameRoom fetches the room, players and scores over REST first. Only **after** `room` is in
state does the subscription effect run, which opens the WebSocket. A brand-new socket sends
`hello { epoch: null }`, which the server classifies as `fresh`: no replay. So any write
that happens between the REST response and the server's `ready` is never delivered.

Typical symptom: a player opens the room link just as the host taps **Start Game**. The
player stays in the waiting room forever, because no further `GameRoom` event arrives
until the next round.

**Fix:** after every `ready` message, refetch (fix 1.1). Or subscribe first, wait for
`ready`, then fetch.

### 2.2 🔴 Nothing refetches after a reconnect, wake-up or failed request

**Status: fixed** (`useRoomData` refetches on reconnect, wake and failure).
[realtime.js:346-371](../src/api/realtime.js#L346-L371),
[GameRoom.jsx:222-281](../src/pages/GameRoom.jsx#L222-L281)

The connection layer reconnects well (backoff, wake on `visibilitychange`/`online`, replay).
But the page relies entirely on replayed events to catch up:

- Every Player/RoundScore event triggers a **new REST refetch**. When a phone wakes up,
  the network is often not ready yet. The refetch rejects, the error is only logged by
  `invokeListener`, and the list stays stale.
- There is no retry and no periodic or visibility-based refetch.

**Fix:** on `ready` (and on `visibilitychange → visible`), call `loadRoom()`. Wrap refetches
in a small retry (e.g. 3 tries, 500 ms / 1 s / 2 s).

### 2.3 🔴 `resync` reloads the whole page

**Status: fixed** (`resync` notifies listeners instead of reloading).
[backend.js](../src/api/backend.js)

`onResync: () => window.location.reload()`. A resync happens whenever:

- the server restarts (new `epoch`). That includes every `server/src` save in
  `npm run dev` / `npm run share` (nodemon), and every `npm start` rebuild;
- a phone was asleep long enough for 1000 events (shared across **all** rooms and chat) to
  pass.

Every phone at the table reloads at once. Any open scanner photo, typed score or
open dialog is lost. Combined with 6.1, it can also drop everyone onto the login page.

**Fix:** once GameRoom can refetch (fix 1.1), make `onResync` notify subscribers to refetch
instead of reloading. Keep reload only as a last resort if no page has registered a
handler.

### 2.4 🟠 A socket stuck in CONNECTING is never timed out

**Status: fixed** (connect timeout in `realtime.js`).
[realtime.js:148-166](../src/api/realtime.js#L148-L166),
[realtime.js:363-366](../src/api/realtime.js#L363-L366)

`checkHealth` only runs after `onopen` (the ping timer starts in `handleOpen`). If the
WebSocket hangs in CONNECTING, there is no timeout. This is common on a Wi-Fi → cellular
handoff or a slow Cloudflare tunnel. `handleWake` also explicitly skips a connecting socket
("let that attempt finish"). The page silently gets no updates until the browser gives up,
which can take minutes.

**Fix:** start a ~10 s connect timer in `connect()`. If `onopen` hasn't fired, call
`reconnectNow()`. In `handleWake`, also replace a socket that has been connecting for longer
than that.

### 2.5 🟠 Expired or invalid login loops forever with no UI

**Status: fixed** (auth check and signed-out banner).
[realtime.js:178-204](../src/api/realtime.js#L178-L204),
[server/src/realtime.js:160-163](../server/src/realtime.js#L160-L163)

If the session cookie stops being valid, the WS upgrade gets a 401. Causes include a
server restart without `SESSION_SECRET` (6.1), 30-day expiry, or an expired Cloudflare
Access session. The browser only reports a generic close. The client retries every
≤10 s forever, and REST writes fail with 401 errors that nobody shows. The game looks
frozen, and a refresh is the only way out (it then hits the login redirect).

**Fix:** in `handleClose`, when several attempts in a row fail before `ready`, call
`backend.auth.isAuthenticated()`. On `false`, show "You've been signed out" with a
login button (or call `redirectToLogin`). Add a global 401 check in `httpClient.request`.

### 2.6 🟠 Out-of-order refetch responses overwrite newer data

**Status: fixed** (`room_version` and per-record merge).
[GameRoom.jsx:222-232](../src/pages/GameRoom.jsx#L222-L232),
[GameRoom.jsx:276-281](../src/pages/GameRoom.jsx#L276-L281)

Each event starts an async `filter()` and calls `setPlayers`/`setRoundScores` with whatever
comes back. When several events arrive together (replay after waking, the host resetting
every player at round end, play again), the responses can resolve out of order. An
**older** list then replaces a newer one, and stays until the next event.

**Fix (pick one):**
- Apply the event directly: the event already carries the full record (`event.data`), so
  upsert or remove it in local state by `id` instead of refetching; or
- Tag each refetch with an incrementing counter and ignore responses older than the
  latest applied one.

Applying events directly also removes the N×(1–2) REST requests per round change.

### 2.7 🟡 Every client receives every room's events

**Status: fixed** (room-scoped realtime).
[server/src/realtime.js:187-207](../server/src/realtime.js#L187-L207)

All events (including private `ChatMessage`s for other rooms) go to every connected socket,
and all rooms share the 1000-event replay buffer. With a few busy rooms, the replay window
shrinks, which means more resyncs (2.3). It also leaks chat content to anyone who opens
devtools.

**Fix:** let the client send the room id(s) it cares about in `hello` and filter
server-side, or at least keep a per-room buffer.

---

## 3. GameRoom state and UI bugs

### 3.1 🟠 "Room Not Found" flashes on every load

**Status: fixed** (`useRoomData` load states).
[GameRoom.jsx:93-101](../src/pages/GameRoom.jsx#L93-L101),
[GameRoom.jsx:739-752](../src/pages/GameRoom.jsx#L739-L752)

`setUser(...)` and `setIsLoading(false)` are applied together. The next render has
`isLoading=false` and `room=null`, so "Room Not Found / This room doesn't exist" shows until
`loadRoom` finishes. On a slow phone that can last a second or more and looks like a broken
link.

**Fix:** keep a `roomStatus: 'loading' | 'loaded' | 'missing' | 'error'` state and only show
"Room Not Found" for `'missing'`.

### 3.2 🔴 A network error during `loadRoom` leaves the page stuck on "Room Not Found"

**Status: fixed** (error card with Retry).
[GameRoom.jsx:123-166](../src/pages/GameRoom.jsx#L123-L166)

`loadRoom` has no `try/catch`. If any of its requests fail (tunnel hiccup, phone waking up),
the promise rejects unhandled, `room` stays `null`, and the user sees "Room Not Found". The
room is fine; only a refresh helps.

**Fix:** catch the error, show "Couldn't load the room" with a **Retry** button, and retry
automatically on `online`/`visibilitychange`.

### 3.3 🟠 Join screen flashes for players who already joined

**Status: fixed** (load states).
[GameRoom.jsx:140-153](../src/pages/GameRoom.jsx#L140-L153)

`setRoom(gameRoom)` runs **before** `await Player.filter(...)`. React renders with a room but
`hasJoined=false`, so returning players briefly see "Join Game". A quick tap there creates a
**duplicate player** (see 4.5).

**Fix:** fetch room, players and scores, then set all state together (or use
`Promise.all` after the room lookup).

### 3.4 🔴 Deleting a room leaves other players on a ghost screen

**Status: fixed** (room-closed card).
[GameRoom.jsx:176-216](../src/pages/GameRoom.jsx#L176-L216),
[GameRoom.jsx:696-729](../src/pages/GameRoom.jsx#L696-L729)

The room subscription only checks `event.data.status === 'closed'`. A **delete** event
carries the pre-deletion record (status `finished`), so other clients call
`setRoom(deletedRoom)` and stay on the finished screen, with an emptied player list. They
must refresh, which then says "Room Not Found".

**Fix:** `if (event.type === 'delete' || event.data.status === 'closed') navigate(Home)`.
Also consider closing the room (`status: 'closed'`) **first** in `deleteRoom`, so clients
leave before their data disappears.

### 3.5 🟠 Kicked players still see and play the game

**Status: fixed** (removed-from-room state).
[GameRoom.jsx:228-232](../src/pages/GameRoom.jsx#L228-L232)

When a player is deleted, the refetched list no longer contains them, but
`if (updatedCurrentPlayer)` simply skips the update. `currentPlayer` and `hasJoined` stay
set. The kicked player keeps seeing the game, and their next score submit fails with a
silent 404. After a refresh they land on the join screen and can rejoin.

**Fix:** if the list no longer contains the current user, clear `currentPlayer`, set
`hasJoined=false`, and toast "You were removed from the game". Optionally block rejoining
by recording kicked emails on the room.

### 3.6 🔴 "Host is editing scores" can get stuck for everyone

**Status: fixed** (edit mode derived from the room record).
[GameRoom.jsx:580-591](../src/pages/GameRoom.jsx#L580-L591),
[GameRoom.jsx:1141-1152](../src/pages/GameRoom.jsx#L1141-L1152)

Players see the overlay when `room.is_edit_mode` is true. The host sees the editor when
the **local** `showScoreEditor` is true. If the host refreshes, closes the tab, or their phone
reloads (2.3) while editing, `is_edit_mode` stays `true` on the server but the host sees the
normal screen. Every other player is locked out of submitting. A refresh doesn't fix it
for anyone; the host would have to press **Edit Scores** twice without knowing why.

**Fix:** drop `showScoreEditor` and use `room.is_edit_mode` for the host as well. Optionally
store `edit_mode_by` and add a timeout.

### 3.7 🟠 `roomStatus` in the subscription is frozen at subscribe time

**Status: fixed** (`useValueTransition`).
[GameRoom.jsx:172-215](../src/pages/GameRoom.jsx#L172-L215),
[GameRoom.jsx:288](../src/pages/GameRoom.jsx#L288)

`const roomStatus = room.status` is captured once, and the effect only re-runs when the room
**id** changes. So:

- A player who subscribed while `waiting` never sees `finished && roomStatus === 'playing'`,
  so the play-again prompt never appears for them.
- A player who loaded mid-game (`playing`) gets the prompt again at the end of every
  later game, and the "game started → load scores" branch never runs.
- While `playing`, players who subscribed in `waiting` refetch every RoundScore on **every**
  room update.

**Fix:** keep the previous status in a ref (`prevStatusRef.current`) and update it on every
room event.

### 3.8 🟠 Finished screen has no per-round scores after a refresh

**Status: fixed** (`scoresByRound` loaded with the room).
[GameRoom.jsx:155-159](../src/pages/GameRoom.jsx#L155-L159)

Round scores are only loaded when the status is `playing`. Refreshing (or joining) on the
finished screen shows an empty round breakdown.

**Fix:** load scores for `playing` **and** `finished`.

### 3.9 🟠 Winner and "Game Canceled!" change as players accept "Play again"

**Status: fixed** (`winner_player_id` and `finish_reason`).
[GameRoom.jsx:645-653](../src/pages/GameRoom.jsx#L645-L653),
[GameRoom.jsx:916-920](../src/pages/GameRoom.jsx#L916-L920)

The prompt appears to non-hosts as soon as the game ends (it isn't triggered by the host).
Accepting resets that player's `total_score` to 0 **while the room is still finished**. The
finished screen computes the winner from live totals, so for everyone the winner name
changes, the scoreboard shows zeros, and the header can flip to "Game Canceled!" once the
top score drops below `max_score`.

**Fix:** don't reset scores in `acceptPlayAgain`; just mark `wants_rematch: true`. The host's
`playAgain` already resets everyone. Also store `winner_player_id` on the room when it
finishes, and render from that.

### 3.10 🟠 `games_won` is incremented during render, once per host device

**Status: fixed** (server-side games_won).
[GameRoom.jsx:922-929](../src/pages/GameRoom.jsx#L922-L929)

The increment runs in the render body, and "already counted" is tracked in
**localStorage**. A host with the app open on a phone and a laptop counts the win twice. So
does a host who opens the finished room on a new browser. Ties pick an arbitrary winner.

**Fix:** do it once, in the code that sets `status: 'finished'`, and record
`winner_player_id` on the room in the same update so it's idempotent.

### 3.11 🟡 Games Won editor renders twice during a game

**Status: fixed** (single editor).
[GameRoom.jsx:1128-1140](../src/pages/GameRoom.jsx#L1128-L1140),
[GameRoom.jsx:1305-1313](../src/pages/GameRoom.jsx#L1305-L1313)

`showGamesWonEditor` opens both the inline panel and the dialog. Remove one. Also,
[GamesWonEditor.jsx](../src/components/game/GamesWonEditor.jsx) copies `players` into state
on mount, so a player who joins while it's open shows an empty/uncontrolled input. It also
calls `onClose()` even when saving failed.

### 3.12 🟡 Mute toggle doesn't mute game chimes

**Status: fixed** (shared sound context).
[useSound.jsx:52-73](../src/components/useSound.jsx#L52-L73),
[Layout.jsx](../src/Layout.jsx), [GameRoom.jsx:45](../src/pages/GameRoom.jsx#L45)

Each `useSound()` call has its own `isMuted` state. The toggle in Layout changes only
Layout's copy. GameRoom keeps its copy from mount time and keeps playing chimes until it
remounts.

**Fix:** move mute state into a context, or read localStorage at play time and listen
for a custom event.

### 3.13 🟡 A new `AudioContext` is created for every tone and never closed

**Status: fixed** (one shared `AudioContext`).
[useSound.jsx:3-19](../src/components/useSound.jsx#L3-L19)

Each chime creates 3–4 contexts. Browsers cap live contexts (iOS Safari especially) and
contexts created outside a tap start `suspended`, so after a while sounds stop working
until the page is refreshed.

**Fix:** create one shared context lazily, `resume()` it on the first user tap, and reuse it.

### 3.14 🟡 Chat recipients reset while the dialog is open

**Status: fixed** (chat dialog fix).
[ChatDialog.jsx:16-36](../src/components/game/ChatDialog.jsx#L16-L36)

`otherPlayers` is a new array on every GameRoom render, so the effect re-runs on every
player event and re-applies the saved selection. If the player deselected everyone, the
selection snaps back to the first player. Depend on a stable key such as the joined ids.

### 3.15 🟡 Leftover debug logging

**Status: fixed** (logs removed).
`console.log` on every ConfirmDialog render and throughout the room subscription. Harmless,
but noisy when debugging real issues on a phone.

---

## 4. Game-logic races (wrong scores / rounds)

### 4.1 🔴 Normal round advance never moves the "Current Turn"

**Status: fixed** (server `advanceRound`).
[GameRoom.jsx:247-268](../src/pages/GameRoom.jsx#L247-L268)

The auto-advance path (all players submitted) only increments `current_round`. Only
`nextRound()` (used by **Force Next Round**) rotates `current_turn_player_id`. In a normal
game, the "Current Turn / Next up" panel shows the same player every round.

**Fix:** use one `advanceRound()` function for both paths.

### 4.2 🔴 The round can advance twice

**Status: fixed** (server advances once).
[GameRoom.jsx:234-271](../src/pages/GameRoom.jsx#L234-L271),
[GameRoom.jsx:509-560](../src/pages/GameRoom.jsx#L509-L560)

Auto-advance runs in the Player subscription of **every client where the user is host**:

- **Host on two devices** (phone + laptop showing the QR code). Both see "all submitted",
  both wait 1.5 s, both reset players and both increment `current_round`. Rounds are
  skipped.
- **Force Next Round.** Marking the last player as submitted triggers the auto-advance
  timer, **and** `forceNextRound` calls `nextRound()` itself 500 ms later. On a slow
  connection the 1.5 s "still all submitted" check can pass before `nextRound` has reset
  everyone, so the round advances twice.
- Replayed events after the host's phone wakes up can also start the timer again.

**Fix (best):** move "submit score / advance round" to the server as one endpoint (e.g.
`POST /api/rooms/:id/submit`) that runs in a SQLite transaction. The server decides when
the round is complete and advances exactly once.
**Fix (client-only):** make advancing conditional, e.g. a server-side "update only if
`current_round` still equals N" option (`PUT ...?if_match_round=N` or an `If-Match` version
field), and ignore the 409.

### 4.3 🟠 Score totals are computed from possibly stale client state

**Status: fixed** (server computes totals).
[GameRoom.jsx:443-448](../src/pages/GameRoom.jsx#L443-L448),
[ScoreEditor.jsx:54-64](../src/components/game/ScoreEditor.jsx#L54-L64)

`handleCardsConfirmed` writes `currentPlayer.total_score + finalScore`. If the host just
edited that player's scores, or the client missed an update, the old total wins and the
edit is lost. ScoreEditor computes totals a different way (sum of RoundScores), so the two
can disagree. `round_number: room.current_round` also uses client state, so a client that
missed a round advance records the score under the previous round.

**Fix:** treat RoundScores as the source of truth and compute `total_score` from them
(client-side for display, or server-side in the submit endpoint from 4.2).

### 4.4 🟠 Score submit can be sent twice / fail silently

**Status: fixed** (one score per player per round on the server).
[GameRoom.jsx:429-457](../src/pages/GameRoom.jsx#L429-L457),
[CardScanner.jsx:241-246](../src/components/game/CardScanner.jsx#L241-L246),
[ManualScoreEntry.jsx:29-36](../src/components/game/ManualScoreEntry.jsx#L29-L36)

The confirm buttons have no "submitting" state, and `handleCardsConfirmed` has no
`try/catch`:

- A double tap creates **two RoundScore records** for the round.
- If `RoundScore.create` succeeds and `Player.update` fails, the score exists but the
  player is "not submitted". Resubmitting creates a duplicate.
- Any failure leaves the scanner open with no message.

**Fix:** `isSubmitting` state + disabled button + toast on error. Server-side, reject a
second RoundScore for the same `(room_id, player_id, round_number)` (or upsert).

### 4.5 🟠 Duplicate players / duplicate turn order on join

**Status: fixed** (idempotent `join`).
[GameRoom.jsx:320-339](../src/pages/GameRoom.jsx#L320-L339)

`joinRoom` doesn't check whether the user already has a Player in the room (see 3.3, or two
tabs), and `turn_order: players.length` collides when two people join at once. Errors are
only logged, with no feedback.

**Fix:** re-check `Player.filter({ room_id, email })` before creating (better: enforce it
server-side), use `max(turn_order) + 1`, and toast on error.

### 4.6 🟠 Host editing a current-round score can trigger auto-advance mid-edit

**Status: fixed** (server-side edit mode rules).
[ScoreEditor.jsx:61-64](../src/components/game/ScoreEditor.jsx#L61-L64)

Saving a current-round score sets `has_submitted_round: true`. If that makes everyone
"submitted", the host's own Player subscription advances the round while the host is still
in the editor. Skip auto-advance while `room.is_edit_mode` is true.

### 4.7 🟡 Start Game announces "playing" before resetting players

**Status: fixed** (server resets players before `playing`).
[GameRoom.jsx:341-362](../src/pages/GameRoom.jsx#L341-L362)

The room switches to `playing` first, then players are reset one by one. For a moment,
clients show the previous game's totals and `has_submitted_round` flags, which can also
trip the auto-advance check. Reset players first, then flip the status (as `playAgain`
already does).

### 4.8 🟡 Dead code

**Status: fixed** (client round logic deleted).
`checkAndAdvanceRound` ([GameRoom.jsx:400-422](../src/pages/GameRoom.jsx#L400-L422)) is never
called, and `playSuccess` is destructured but unused in GameRoom. Remove them so there is
only one advance path to reason about.

---

## 5. Error handling and feedback

### 5.1 🟠 Most writes fail silently

**Status: fixed** (`runAction` toasts, awaiting ConfirmDialog).
These `await` calls have no `try/catch` or user feedback, so a failure looks like the
button did nothing. That pushes the user to refresh.

| Action | Location |
| --- | --- |
| Start game, close room, next round | [GameRoom.jsx:341-398](../src/pages/GameRoom.jsx#L341-L398) |
| Bust / submit score | [GameRoom.jsx:429-505](../src/pages/GameRoom.jsx#L429-L505) |
| Force next round, end game, kick, reorder, delete room | [GameRoom.jsx:509-729](../src/pages/GameRoom.jsx#L509-L729) |
| Edit mode toggle | [GameRoom.jsx:580-591](../src/pages/GameRoom.jsx#L580-L591) |
| Accept/decline play again | [GameRoom.jsx:639-653](../src/pages/GameRoom.jsx#L639-L653) |
| Score editor save | [ScoreEditor.jsx:29-68](../src/components/game/ScoreEditor.jsx#L29-L68) |
| Create room (only `console.error`) | [Home.jsx:48-83](../src/pages/Home.jsx#L48-L83) |

[ConfirmDialog.jsx:7-11](../src/components/ui/ConfirmDialog.jsx#L7-L11) calls `onConfirm()`
without awaiting it and closes immediately, so errors in confirmed actions become unhandled
rejections and the button can be pressed again.

**Fix:** one small helper, e.g. `runAction(label, fn)`, that sets a busy flag, awaits, and
shows `toast.error(label + ' failed — check your connection')`. Let ConfirmDialog await
`onConfirm` and show a spinner.

### 5.2 🟡 Loops of sequential writes are slow and leave half-done states

**Status: fixed** (single-transaction server actions).
`startGame`, `nextRound`, `playAgain`, `deleteRoom`, `handleReorderPlayers` and Cleanup
send one request per player/score **in sequence**. Each write also triggers realtime
events and refetches on every client. A failure halfway leaves the room inconsistent
(e.g. half the players reset).

**Fix:** a few server endpoints that do the whole operation in one transaction, or at
least `Promise.all` plus bulk update/delete endpoints.

---

## 6. Server and deployment

### 6.1 🔴 `npm run dev` logs everyone out on every server restart

**Status: fixed** (session secret saved in `DATA_DIR/session-secret`).
[server/src/config.js:474-478](../server/src/config.js#L474-L478),
[scripts/dev.mjs:67](../scripts/dev.mjs#L67)

`npm run dev` doesn't load `.env`, so `SESSION_SECRET` is random per boot. nodemon restarts
the server on every `server/src` save, which **invalidates every cookie** and changes the
epoch (2.3). Every connected phone reloads and lands on the login page. (Docker/share mode
is fine because `share.mjs` writes a secret into `.env`.)

**Fix:** have `dev.mjs` load `.env` (Node 20.6+: `node --env-file=.env`) or generate a
secret once into `server/data/.session-secret` and reuse it.

### 6.2 🟠 Any restart forces every client to reload

**Status: fixed** (durable event log replay).
[server/src/realtime.js:124-128](../server/src/realtime.js#L124-L128)

The epoch and replay buffer live only in memory, so even a quick container restart or
redeploy makes every client resync, which reloads the page (2.3). Two ways to fix it:

- Make the client refetch on resync instead of reloading (fix 1.1 + 2.3). Simplest.
- Persist an `events` table in SQLite (seq, entity, json) and use the DB file id as the
  epoch, so replay survives restarts.

### 6.3 🟡 Login state is checked three times per page load

**Status: fixed.** Home, GameRoom (`useGameRoom.js`) and Cleanup all read `user` from `useAuth()`.
`AuthContext` calls `/api/auth/me`, then Home/GameRoom call `isAuthenticated()` (another
`/me`) and then `me()` again. Pages could read `user` from `useAuth()` instead, which is
faster on a slow tunnel and leaves fewer requests that can fail.

---

## 7. Phone scenarios and edge cases

Players use this at a table, on phones, between turns. They lock the screen, switch to
WhatsApp, open the camera, take calls, and let the battery die. Each scenario below says
what the app **does today** (from reading the code), what goes wrong, and what to change.
Most of the fixes reuse the same building blocks: **refetch on resume** (fix 1.1), **server-side
round logic** (4.2) and **a visible connection status** (fix 1.2).

### How phones treat a backgrounded page

| Situation | What the browser does to this page |
| --- | --- |
| Switched to another app, < ~30 s | JS paused (iOS: within seconds). Socket may survive or be silently dropped. |
| Switched away / screen locked for minutes | JS frozen. iOS usually closes the socket. The server's heartbeat terminates it after 30–60 s. Timers (`setTimeout`, `setInterval`) don't run. |
| Another tab in the same browser | `visibilitychange → hidden`. Android Chrome may **freeze** the tab (no JS at all), then fire `resume` + `visibilitychange` on return. |
| Navigated to another website in the same tab, then pressed Back | The page may be restored from the **back/forward cache** with old JS state and a dead socket. `pageshow` (with `persisted: true`) fires. |
| Low memory (camera open, games, many tabs) | The tab is **discarded**. Coming back reloads the page from scratch. |
| Wi-Fi ↔ mobile data switch | The socket becomes half-open. `online` does **not** fire, because the phone never went offline. |
| Browser fully closed / phone restarted | All state is gone. The user has to find the room again. |

The client currently reacts only to `visibilitychange → visible` and `online`
([realtime.js:327-371](../src/api/realtime.js#L327-L371)), and the page itself reacts to
neither (2.2).

### 7.1 🔴 Host's phone locked or in another app → the round never advances

**Status: fixed** (server advances rounds).
[GameRoom.jsx:234-271](../src/pages/GameRoom.jsx#L234-L271)

Auto-advance (and finishing the game at `max_score`) runs **only inside the host's browser**,
in a realtime callback plus a 1.5 s `setTimeout`. While the host's page is backgrounded or
locked, that code doesn't run. Every other player submits, sees "Waiting for 0 players", and
nothing happens. Refreshing doesn't help. The round advances only when the host comes
back. Then replayed events fire the logic late, possibly several times at once (4.2).

**Fix:** move "all submitted → advance / finish" to the server (4.2). That also removes the
"host on two devices" double-advance. As a stopgap, let **any** player's client perform the
advance with a conditional update (only if `current_round` is still N).

### 7.2 🔴 Host's phone dies or the host leaves → the room is stuck forever

**Status: fixed** (hold-to-vote host change).
Host-only actions: start, force next round, end game, edit scores, play again, kick, close.
There is no way to pass hosting on. If the host's battery dies, or the host closes the
browser and can't find the link again, the remaining players can't continue or finish.

**Fix:** a "Make host" action (host transfers before leaving), and/or automatic host
transfer when the host has been disconnected for N minutes. That needs presence, see 7.4.
With server-side round logic, at minimum the game can still progress without the host.

### 7.3 🔴 A player who leaves blocks every round ("ghost players")

**Status: fixed** (leave and kick actions).
Players never leave a room unless kicked or they decline "play again". Someone who closes
the tab, loses battery, or rejoins from another browser (7.9) stays in `players` with
`has_submitted_round: false`. "All submitted" is then never true, so the host must press
**Force Next Round** every round (and the ghost gets 0 points every time). Kicking is only
available in the waiting room ([PlayerList.jsx:68](../src/components/game/PlayerList.jsx#L68)
hides it while scores are shown), so the host can't remove the ghost mid-game.

**Fix:** allow kicking during a game, add a "Leave game" button for players, and show which
players are offline (7.4) so the host knows who to force or remove.

### 7.4 🟠 Nobody can see who is connected

**Status: fixed** (presence and offline badges).
There is no presence. A player whose phone is locked looks the same as one who is about to
submit. The host can't tell "Sam is still counting cards" from "Sam's phone is in their
pocket".

**Fix:** the server already knows each socket's identity (`webSocket.identity`). Once
sockets declare their room (2.7), broadcast an "online / last seen" flag per player and grey
out offline players in the scoreboard and the "Waiting for…" list.

### 7.5 🔴 Opening the camera to scan cards can lose the photo, or the page itself

**Status: fixed** (pending cards kept until the write succeeds).
[CardScanner.jsx:296-298](../src/components/game/CardScanner.jsx#L296-L298)

`capture="environment"` hands off to the phone's camera app, so the browser goes into the
background:

- **Android, low memory:** Chrome often **discards** the tab while the camera is open. On
  return the page reloads, the photo never reaches the file input, and the player is back
  on the action buttons with no explanation. This looks like "the scan button doesn't
  work", and players retry or refresh.
- **Long time in the camera** (retakes, deciding): on return, `handleWake` sees a quiet
  socket and reconnects, and the replayed events refetch data. Meanwhile:
  - if the host forced the next round, the scanned score is saved under the **new** round
    number (`room.current_round` from client state), so it lands in the wrong round;
  - if the host ended the game or opened score editing, the scanner unmounts and the
    photo and detected cards disappear silently.
- **Any phone:** the photo and detected cards live only in component state, so anything
  that remounts GameRoom (a resync reload, see 2.3) throws them away.

**Fix:**
- Save detected cards (not the photo) to `sessionStorage` keyed by room + round, and restore
  them when the scanner remounts. On load, `document.wasDiscarded` tells you the tab was
  discarded, so you can say "Your last scan was interrupted, please try again".
- Remember the round the scan was **started** for, and if it no longer matches
  `room.current_round` on confirm, ask "The round moved on. Submit for round N anyway?"
- Offer a non-`capture` input as a fallback ("Choose from photos"). It keeps the user in the
  browser's own picker, which is less likely to get the tab killed.

### 7.6 🟠 Back/forward cache restore leaves a frozen page

**Status: fixed** (pageshow wake-up).
If a player goes to another site in the same tab (e.g. looks up the rules) and presses
**Back**, the browser may restore GameRoom from the back/forward cache with old state. The
socket was closed while cached. `visibilitychange` may or may not fire, depending on the
browser.

**Fix:** listen for `pageshow` with `event.persisted === true` and treat it like a wake:
`handleWake()` plus a room refetch. Listen for `freeze`/`resume` (Chrome) the same way.

### 7.7 🟠 Wi-Fi ↔ mobile data switch leaves a dead socket for up to a minute

**Status: fixed** (wake-up and pong timeout).
Walking away from the router or turning Wi-Fi off doesn't fire `online`, because the phone
was never offline. The old socket is half-open. It's detected only by the 60 s stale check,
and only if the ping timer isn't throttled.

**Fix:** also listen to `navigator.connection?.addEventListener('change', …)` (Android
Chrome) and call `handleWake()`. Together with the connect timeout (2.4), this keeps the gap
to a few seconds.

### 7.8 🟠 Closing the browser means hunting for the room code again

**Status: fixed** ("Return to game" on Home).
The room code lives only in the URL. A player who swipes the browser away, or opens the app
again from a bookmark or home screen at `/`, lands on Home with no way back except typing the
code (which only the host's screen shows).

**Fix:** store `{ code, joinedAt }` in localStorage when joining. On Home, show
"Return to game ABC123" if that room is still open (one `GameRoom.filter`). Clear it when
the room closes, is deleted, or the player leaves.

### 7.9 🟠 Opening the link in a different browser creates a second player

**Status: fixed.** The join screen lists the players already in the room, shows an "open in your browser" hint inside in-app browsers (`src/lib/inAppBrowser.js`), and the host can kick or make host.
Scanning the room QR code with a chat app or social app opens it in that app's **in-app
browser**, which has its own cookies. The same happens with an iOS home-screen web app
versus Safari. The player has to log in again. In `AUTH_MODE=dev` they can easily type a
slightly different email or name, and become a **new player**, while the old one becomes a
ghost (7.3).

**Fix:** on the join screen, show the players already in the room with a hint like "Already
playing? Use the same email as before". Let the host merge or kick (7.3). Optionally show
"Open in your browser" when an in-app browser user agent is detected.

### 7.10 🟠 An expired Cloudflare Access session looks like "no internet"

**Status: fixed** (opaque redirect treated as signed out).
In `AUTH_MODE=cloudflare`, Access sessions usually expire long before the app's 30-day
cookie (often after 24 h). Once the session has expired, `fetch('/api/...')` gets a **302 to
the Access login page on another domain**. `fetch` follows it, fails CORS, and rejects with
a generic `TypeError`, **not** a 401. So even the fix in 2.5 won't detect it. The WS
upgrade fails the same way. Players who left the app open overnight see nothing working
until they reload the page, which goes through Access.

**Fix:** use `redirect: 'manual'` in [httpClient.js](../src/api/httpClient.js) and treat
`response.type === 'opaqueredirect'` as "signed out": show a "Session expired — tap to
continue" banner that does a full `window.location.reload()`.

### 7.11 🟠 Writes made with a bad connection are lost

**Status: fixed** (pending score with Retry).
A player submitting a score in a weak-signal spot gets a rejected `fetch`, no message (5.1),
and loses what they entered once they leave the scanner.

**Fix:** besides the error toast, keep the pending score in component state (or
`sessionStorage`) with a **Retry** button. Never clear the scanner until the write
succeeds. Server-side "one score per player per round" (4.4) makes retries safe.

### 7.12 🟡 Missed moments while away

**Status: fixed** (title, vibrate cues and emoji queue).
- **Sounds:** the `AudioContext` can't play while the page is hidden. The "game started"
  and "game over" chimes either don't play or play late on return (and 3.13 makes them more
  likely to stop altogether).
- **Chat emojis:** messages that arrive while the phone is locked are replayed on return,
  and each one replaces the previous full-screen animation, so only the last is seen. After
  a resync or fresh connection they are lost entirely.
- **"Your turn":** there's no signal outside the page at all.

**Fix (cheap):** update `document.title` (e.g. "● Round 4 — your turn") and call
`navigator.vibrate` on the important events, so the browser tab shows it. Queue chat
animations instead of replacing them. Web Push would be the full solution but needs a
service worker and permission prompts, which is probably not worth it for a table game.

### 7.13 🟡 Screen auto-lock keeps disconnecting players

**Status: fixed** (wake lock, always on: X28).
Phones lock after 30 s–2 min, and each lock tends to drop the socket (iOS) and freeze timers.
During an active game, the [Screen Wake Lock API](https://developer.mozilla.org/docs/Web/API/Screen_Wake_Lock_API)
(`navigator.wakeLock.request('screen')`, supported in current iOS Safari and Android
Chrome) could keep the screen on. Make it an opt-in toggle next to the sound toggle, since
it costs battery. Re-request it on every `visibilitychange → visible` (the lock is released
when hidden).

### 7.14 🟡 The same room open twice on one phone

**Status: fixed** (duplicate-tab notice and server-side rounds).
Scanning the QR code twice, or opening the link from a chat and from the browser, gives
two tabs of the same player. For a host, that is the two-device double-advance (4.2) on a
single phone. For anyone, the emoji animations show in both tabs. Harmless once round logic
is server-side. Until then, a `BroadcastChannel('flip7')` ping can tell the older tab
"this room is open in another tab" and stop it from running host logic.

### 7.15 Suggested test checklist (manual, on real phones)

**Status: to do (manual).** Run on real phones with `npm run share`.
Run each scenario on one iPhone (Safari) and one Android phone (Chrome), with a second
device as host:

1. Lock the screen for 10 s, 2 min and 15 min during a round. Unlock: does the screen catch up without refreshing?
2. Switch to another app while the host starts the game / forces a round / ends the game.
3. Host locks their phone after everyone has submitted. Does the round still advance?
4. Open the camera to scan, wait 1 minute, have the host force the next round, then take the photo.
5. Open another website in the same tab, press Back.
6. Toggle Wi-Fi off/on and switch Wi-Fi → mobile data mid-round.
7. Turn airplane mode on, submit a score, turn it off. Is the score lost or retried?
8. Swipe the browser away, reopen the app from the home screen. Can you get back to the room?
9. Scan the room QR code from a chat app's in-app browser.
10. Restart the server (`docker compose restart app`) mid-game. Do phones recover without a reload?
11. Leave a phone on the game overnight (Cloudflare mode) and use it the next morning.

### 7.16 Desktop launcher checklist (manual, on real phones)

**Status: to do (manual).** Run with an installed build (or `npm run desktop`) on a laptop, with
one iPhone and one Android phone. Behaviour is in [decisions.md](decisions.md) (X61).

1. Start hosting. Scan the QR with both phones, join a room and play a full round.
2. Kill `cloudflared` in Task Manager / `kill`. The tunnel restarts, "URL changed, rescan" shows
   over the new QR, and rescanning gets both phones back into the room.
3. Kill it 4 times within a minute: the error panel shows with Retry and Show logs, and Retry hosts again.
4. Close the window while hosting: one "Stop hosting and quit?" prompt. Cancel keeps hosting;
   confirming quits. Repeat with Cmd+Q on macOS.
5. The lid/power hint shows while hosting. Unplug the charger: the battery warning appears, and
   goes away when plugged back in.
6. Leave the laptop idle past its sleep timeout while hosting: it stays awake (the display may sleep).
7. Reset data while idle (after dismissing a failed session): old rooms are gone on the next start.
8. After quitting, no `cloudflared` or launcher process is left (Task Manager / `ps`), and the old
   URL no longer loads.

---

## 8. Security notes (not sync bugs, but worth knowing)

- **No per-record authorization.** Any signed-in user can update or delete any GameRoom,
  Player, RoundScore or ChatMessage through the REST API, including other rooms. "Host
  only" is enforced only in the UI.
- **The Cleanup page's admin check is client-side only** (an `atob`-encoded email in
  [Cleanup.jsx](../src/pages/Cleanup.jsx)). Anyone can perform the same deletes through the API.
  The server already knows `role: "admin"` from `ADMIN_EMAILS`. Use that on a server
  route.
- **Chat messages are broadcast to all sockets** (2.7).
- In `AUTH_MODE=dev` on a public share URL, anyone can sign in as any email, including the
  admin email (already noted in the README).

---

## 9. Suggested order of work

1. `RealtimeConnection`: add `onReady` listeners, a connect timeout (2.4), and an auth check
   on repeated failures (2.5). Turn `onResync` into "notify listeners" (2.3).
2. GameRoom: extract a `useRoomData(roomCode)` hook that
   - loads room + players + scores together with a loading/error state (3.1–3.3, 3.8),
   - subscribes, applies `event.data` directly (2.6), and handles delete/kick (3.4, 3.5),
   - refetches on `ready`, on resync and on page visible (2.1, 2.2).
3. Edit mode from `room.is_edit_mode` (3.6); previous status via ref (3.7).
4. One `advanceRound()`, made idempotent, ideally server-side together with score
   submission (4.1–4.4, 4.6).
5. Busy states + error toasts everywhere (5.1).
6. `SESSION_SECRET` for dev (6.1).
7. Phone lifecycle: `pageshow`/`resume`/connection-change wake-ups (7.6, 7.7), kick and leave
   during a game (7.3), "Return to game" on Home (7.8), keep scanned cards across
   interruptions (7.5, 7.11), Cloudflare session-expiry detection (7.10).
8. Presence and host transfer (7.2, 7.4).
9. The 🟡 items as time allows, then run the phone checklist in 7.15.

Once steps 1–2 are in place, the connection layer's own tests in
[tests/realtime.test.js](../tests/realtime.test.js) are the right place to cover "reconnect →
ready → listeners notified" and "connect timeout → reconnect".
