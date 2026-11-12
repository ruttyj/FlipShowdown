# Flip Showdown self-hosted backend contract

The frontend talks to this through the `backend` client (`src/api/backend.js`).
The client covers auth, entity reads and subscriptions. Game writes (join, scoring, rounds,
host changes) go through the game actions in `src/api/game.js` instead; see
[Game actions](#game-actions-apirooms).

One Node process (port `7001` by default) serves:

- the built frontend (`dist/`) with SPA fallback to `index.html` for any non-API GET,
- the REST API under `/api`,
- the realtime WebSocket at `/api/realtime`,
- the login page at `/login`.

## Configuration (environment variables)

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `7001` | HTTP port |
| `DATA_DIR` | `./data` | Folder holding `flip7.db` (SQLite) and `backups/` (`npm run backup` copies and the automatic pre-migration copies, X82, X88) |
| `STATIC_DIR` | `../dist` (relative to `server/`) | Built frontend to serve; skipped if missing |
| `AUTH_MODE` | `dev` | `dev` or `cloudflare` |
| `SESSION_SECRET` | generated once, saved as `DATA_DIR/session-secret` | HMAC key for the dev-login cookie |
| `CF_ACCESS_TEAM_DOMAIN` | – | e.g. `yourteam.cloudflareaccess.com` (required in `cloudflare` mode) |
| `CF_ACCESS_AUD` | – | Access application AUD tag (required in `cloudflare` mode) |
| `ADMIN_EMAILS` | – | Comma-separated emails that get `role: "admin"`. Ignored in `dev` mode unless `DEV_ALLOW_ADMINS` is on |
| `DEV_ALLOW_ADMINS` | `false` | Honour `ADMIN_EMAILS` in `dev` mode, where anyone can sign in as any email (X89). The server tests turn it on |
| `ENTITIES` | `GameRoom,Player,RoundScore,ChatMessage` | Allowed entity names; others return 404 |
| `GEMINI_API_KEY` | – | Google Gemini API key; AI card scanning is disabled when empty |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | Default model for card scanning |
| `HOST_OFFLINE_GRACE_SECONDS` | `120` | How long the host must be offline before a vote can pass without them (see Hold-to-vote) |
| `STALE_ROOM_HOURS` | `24` | Rooms untouched this long are deleted, unless a player is online (X81). `0` turns the sweep off |
| `LOCK_GAME_ENTITIES` | `true` | Blocks generic GameRoom/Player/RoundScore writes for non-admins and limits generic reads to members (see Game actions). `false` restores open access |

## Authentication

Every `/api` route except `/api/auth/*` and `/api/health` requires an authenticated user,
else `401 {"message": "Authentication required"}`. The WebSocket upgrade requires it too
(reject with 401).

- **`cloudflare` mode**: Cloudflare Access sits in front of the app and adds a signed JWT
  in the `Cf-Access-Jwt-Assertion` header (also available as the `CF_Authorization`
  cookie). The server verifies it against
  `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (JWKS) with audience
  `CF_ACCESS_AUD` and issuer `https://<CF_ACCESS_TEAM_DOMAIN>`. The user's email is the
  `email` claim. Never trust the plain `Cf-Access-Authenticated-User-Email` header alone.
- **`dev` mode**: no password. `/login` shows a form (email + optional display name);
  submitting sets an HMAC-signed, httpOnly, SameSite=Lax cookie `flip7_session`. Lets you
  test several players locally from different browsers/incognito windows.

Users are upserted into a `users` table the first time they are seen.

### User object

```json
{ "id": "…", "email": "a@b.com", "full_name": "Alice" | null, "role": "admin" | "user",
  "created_date": "ISO", "updated_date": "ISO" }
```

### Routes

- `GET /api/health` → `200 {"ok": true}` (no auth)
- `GET /api/auth/me` → `200 User` | `401`
- `PUT /api/auth/me` body `{ "full_name": "…" }` → `200 User` (only `full_name` is writable)
- `POST /api/auth/logout` → `200 {"logout_url": string | null}`. Dev: clears the cookie,
  `logout_url` null. Cloudflare: `"/cdn-cgi/access/logout"`.
- `GET /login?from_url=<url>` → HTML.
  - dev: login form; on success redirect to `from_url` (only same-origin paths/URLs are
    honoured, otherwise `/`).
  - cloudflare: if the request is authenticated, redirect to `from_url`; otherwise show a
    short page saying to open the app through its Cloudflare URL.
- `POST /login` (dev only, form-encoded `email`, `full_name`, `from_url`) → sets cookie,
  `303` redirect.

## Entities

GameRoom, Player, RoundScore and ChatMessage are stored in typed tables (see
[Game records](#game-records)); any other entity named in `ENTITIES` is a schemaless JSON row.
Both give the same record shape. With `LOCK_GAME_ENTITIES=true` (the default),
GameRoom, Player and RoundScore writes and non-member reads are blocked; see the lock-down
under [Game actions](#game-actions-apirooms). Every record returned has the client fields
plus server-managed fields that the client cannot override:

```json
{ "...client fields": "...", "id": "24-char lowercase hex", "created_date": "ISO",
  "updated_date": "ISO", "created_by": "creator email" }
```

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/api/entities/:name` | `q` (JSON object, optional), `sort`, `limit`, `skip` | `200 Record[]` |
| GET | `/api/entities/:name/:id` | – | `200 Record` / `404` |
| POST | `/api/entities/:name` | object | `201 Record` |
| POST | `/api/entities/:name/bulk` | array of objects | `201 Record[]` |
| PUT | `/api/entities/:name/:id` | partial object (shallow-merged) | `200 Record` / `404` |
| DELETE | `/api/entities/:name/:id` | – | `200 {"success": true}` / `404` |

- **Filter `q`**: object of top-level field → value; a record matches when every field is
  deep-equal (`id` works too). Example `q={"room_id":"abc"}`. Only equality is required.
- **`sort`**: field name, `-` prefix for descending. Default `-created_date`. Ties broken by
  insertion order.
- **`limit`/`skip`**: integers; no limit by default.
- Errors are JSON `{"message": "…"}` with an appropriate status (400 bad JSON / bad body,
  404 unknown entity or id).
- A write the database refuses (X84) is `400 {"message", "code": "invalid_record"}` (a declared
  field of the wrong type, a missing or malformed `email`, a `room_id`/`player_id` that doesn't
  exist) or `409 {"message", "code": "conflict"}` (a second player for the same user in a room, or a
  second non-closed room with the same code). A bulk create is all or nothing.

## AI card scanning (`/api/ai`)

The server calls Google Gemini on the client's behalf; the key (`GEMINI_API_KEY`) never
reaches the browser and is sent to Google only in the `x-goog-api-key` header. Both routes
require an authenticated user (401 otherwise). Errors are `{"message": "…"}`.

- `GET /api/ai/config` → `200 {"enabled": bool, "default_model": string | null,
  "models": [{"id": "gemini-3.5-flash-lite", "display_name": "Gemini 3.5 Flash-Lite"}]}`.
  - Without a key: `{"enabled": false, "default_model": null, "models": []}`.
  - `models` is Gemini's model list filtered to `gemini-*` models that support
    `generateContent` and can read images (no embedding, TTS, live/audio, transcription,
    image/video generation…). `GEMINI_MODEL` is always first, even if the list lacks it;
    the rest are newest version first, Flash before Flash-Lite before Pro, stable before
    preview. Cached for an hour; if the list call fails the server offers only the
    default model (and retries after a minute).
- `POST /api/ai/scan-cards` body `{"image": "data:image/jpeg;base64,…", "model"?: id, "mode"?: string}` →
  `200 {"cards": [{"value": "7", "type": "number"}], "model": "<id used>"}`.
  - `image`: base64 data URL of `image/jpeg`, `image/png` or `image/webp`, at most 4 MB
    decoded. This route accepts bodies up to 6 MB (the rest of `/api` stays at 1 MB).
  - `model`: optional; must be one of the ids from `/api/ai/config` (default otherwise).
  - `mode`: optional; which prompt reads the photo. `classic`, `vengeance` or `brutal`, which is the
    same as `vengeance`. Missing or anything else is `classic` and never an error (X46). The answer's
    shape is the same in every mode.
  - `classic`: `cards[].value` is `"0"`–`"13"` (`type: "number"`), `"x2"` (`"multiplier"`), `"÷2"`
    (`"divisor"`), `"+2"`…`"+10"` (`"adder"`) or `"-2"`…`"-10"` (`"subtractor"`). `type` is derived from
    `value`.
  - `vengeance`: `cards[].value` is `"1"`–`"13"` (`"number"`), `"0"`, `"7"` or `"13"` (`"special"`:
    The Zero, Unlucky 7, Lucky 13), `"÷2"` (`"divisor"`) or `"-2"`…`"-10"` (`"subtractor"`). The model
    answers with a label for each card and the server maps it, so x2 and +N can't come back.
  - In every mode action cards are ignored and anything unrecognised is dropped. The client computes
    the score, and strips the symbol from modifier values before showing them (X34).
  - Errors: `400` bad body / image / unknown model; `429` too many scans (20 per user per
    minute) or Gemini is rate-limiting; `502` any other Gemini failure (model unavailable,
    timeout, unreadable answer) — the client may retry with another model; `503` AI not
    configured; `413` body over 6 MB.

## Game records

The four entities keep the generic record shape above. These are the fields the game uses, and
each is a typed column (X83): a declared field that was never set reads as `null`, not absent.
Fields marked *new* are added by the game actions; older records without them are read as the
default shown. Any other field a write sends is kept and returned as is.

- `email` (Player) and `host_email` (GameRoom) come from the user the row points at, so they are
  always canonical (trimmed, lower-case). Writing an email nobody has signed in with creates that
  user (X85).
- Deleting a GameRoom deletes its Players, RoundScores and ChatMessages; deleting a Player deletes its
  RoundScores. These cascaded deletes publish no realtime events (X84).

**GameRoom**

| Field | Type | Meaning |
| --- | --- | --- |
| `code` | string | 6 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, unique among rooms that aren't `closed` |
| `status` | `waiting` \| `playing` \| `finished` \| `closed` | |
| `host_email` | string | Email of the host. Kept in sync with `host_player_id` |
| `host_player_id` | id \| null | *new*. The host's Player |
| `max_score` | integer | A total at or above this ends the game |
| `game_mode` | `classic` \| `vengeance` \| `brutal` | *new*. The rules every score in the room is under. Missing or unknown reads as `classic`. Locks at the first RoundScore (see `set-game-mode`) |
| `game_number` | integer | *new*, default 1. Counts the games played in this room |
| `current_round` | integer | Starts at 1 |
| `current_turn_player_id` | id \| null | Who deals this round. Rotates by turn order on each advance |
| `is_edit_mode` | boolean | Host is editing scores; rounds don't auto-advance |
| `edit_mode_by` | id \| null | *new*. Player who turned edit mode on |
| `winner_player_id` | id \| null | *new*. Set when the game finishes, cleared on start / play again |
| `finish_reason` | `max_score` \| `ended` \| null | *new*. `ended` = the host pressed End game |
| `version` | integer | *new*, default 0. Incremented by every action that changes the room or anything in it |
| `last_activity_date` | ISO | Updated by every action |

**Player**: `room_id` (must exist), `email` (required, unique per room), `name`, `is_host`, `turn_order` (integer,
unique per room), `total_score`, `current_round_score`, `has_submitted_round`, `games_won`,
`last_seen` (*new*, ISO or null).

`total_score` is a cached copy. The server recomputes it as the sum of the player's
RoundScores `final_score`, less 15 for each RoundScore whose `flip7_attack_player_id` names them,
whenever one of those scores changes.

**RoundScore**: `room_id`, `player_id` (both must exist), `round_number`, `cards` (array of
`{value, type}`), `base_sum`, `final_score`, `busted` (*new*, default false: a bust, which keeps its
cards), `duplicate_allowed` (*new*, default false: a duplicate vouched for as coming from a Steal or
Swap), `flip7_attack_player_id` (*new*, default null: in Brutal, who this Flip 7 takes 15 from, instead
of its bonus; ignored once that player has left). There is at most one per
`(player_id, round_number)`. The server doesn't validate `type`. The client uses `number`,
`multiplier`, `divisor`, `adder`, `subtractor` and `special`, whose value says which card it is:
`0` The Zero, `7` Unlucky 7, `13` Lucky 13.

**ChatMessage**: `room_id` (must exist), `sender_id`, `recipient_id`, `emoji`, `message`.

## Game actions (`/api/rooms`)

Game writes go through these endpoints, not through `/api/entities`. Each action:

1. checks the caller's permission,
2. runs in **one SQLite transaction**, so it either fully happens or not at all,
3. increments `GameRoom.version` and `last_activity_date` when anything changed,
4. after commit, publishes one realtime `event` per changed record (see Realtime). Child
   records come first and the GameRoom update comes last, except for `delete` (see below).

**Routes.** `POST /api/rooms` creates a room. Every other action is
`POST /api/rooms/:roomId/actions/:name` with a JSON body (`{}` when there are no fields).

**Response.** `200 { "room": GameRoom, "players": Player[], ...extra }`. `players` is every
player in the room sorted by `turn_order`. The client may apply this snapshot directly.

**Errors.** `{ "message": "…", "code": "…" }`.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | Missing or invalid field |
| 401 | – | Not signed in |
| 403 | `not_member` | Caller has no Player in the room |
| 403 | `not_host` | Host-only action called by someone else |
| 404 | `room_not_found`, `player_not_found` | |
| 409 | `wrong_status` | Action not allowed in the room's current status. Body adds `status` |
| 409 | `round_mismatch` | `round_number` isn't the current round. Body adds `current_round` and, for `submit-score`, `stored_score` (the caller's RoundScore for that round, or null) |
| 409 | `mode_locked` | `set-game-mode` on a room with a RoundScore, or a finished one |
| 409 | `mode_changed` | A score's `game_mode` isn't the room's. Nothing is stored. Body adds `game_mode`, the room's mode |

**Who.** *Member* means the caller's email has a Player in the room. *Host* means the
caller's email is `room.host_email`. Admins (`role: "admin"`) pass host checks and may act
on any room, but actions about "the caller's Player" (`submit-score`, `leave`) still need a Player (`not_member` otherwise).

**Side effects of player and host changes.** These apply to every action that removes a
player or changes the host:
- **Turn:** when the player whose turn it is leaves or is kicked, `current_turn_player_id`
  moves to the next player by turn order.
- **Edit mode:** when the host changes, or the player in `edit_mode_by` leaves, edit mode
  is turned off (`is_edit_mode: false`, `edit_mode_by: null`) and the round check runs.

**Repeating a request is safe.** Each action is written so that a retry after a lost
response either does the same thing again or returns a clear error. The notes column
says how.

| Action | Who | Allowed in | Body | Effect | On repeat |
| --- | --- | --- | --- | --- | --- |
| `POST /api/rooms` | signed in | – | `{max_score, name?, game_mode?}` | New room in `waiting` with a unique code, `game_number` 1 and `game_mode` as given, else `classic` (400 for an unknown mode). Creates the caller as host Player (`turn_order` 0, name defaults to `full_name` or the email's local part). Extra: `player` | Creates another room (the client guards with a busy state) |
| `join` | signed in | `waiting`, `playing`, `finished` | `{name}` | Creates a Player with `turn_order = max + 1`. Extra: `player`, `already_joined` | If the caller's email already has a Player, returns it unchanged with `already_joined: true` |
| `leave` | signed in (`player_not_found` without a Player) | any but `closed` | `{}` | Deletes the caller's Player and their RoundScores, and recomputes anyone those scores attacked. A leaving host passes hosting to the next player by turn order. The last player leaving closes the room. Mid-game, re-checks round completion | `player_not_found` (404), which the client treats as done |
| `kick` | host | any but `closed` | `{player_id}` | Same as `leave`, for another player. Can't kick yourself (400) | `player_not_found` |
| `make-host` | host, or a passed vote | any but `closed` | `{player_id}` | Moves `host_email`, `host_player_id` and `is_host` | No change |
| `reorder` | host | `waiting` | `{player_ids}` | Sets `turn_order` to each id's index. Must list every player exactly once (400 otherwise) | No change |
| `set-game-mode` | host | any but `closed` | `{game_mode}` | Sets `game_mode` (400 for an unknown mode). `mode_locked` when the room is `finished` or has any RoundScore, including those from `edit-score` and `force-next-round` | No change, even once locked, when the room already has that mode |
| `start` | host | `waiting` | `{}` | Deletes the room's RoundScores and resets every player (scores 0, `has_submitted_round` false). Then sets `current_round` 1, the first player by turn order as current turn, no winner, `status: playing`. A room with no players is `bad_request` | `wrong_status`, `bad_request` |
| `submit-score` | member | `playing` | `{round_number, cards, base_sum, final_score, game_mode?, busted?, duplicate_allowed?, flip7_attack_player_id?}` | Upserts the caller's RoundScore for the round, recomputes their total and the old and new attack targets', and sets `has_submitted_round` and `current_round_score`. Then runs the **round check**. Allowed during edit mode: the round then waits until edit mode ends | Replaces the same RoundScore. After the round moves on: `200` with `already_applied: true` if the stored score has the same `final_score`, `base_sum`, `cards`, `busted`, `duplicate_allowed` and `flip7_attack_player_id`, otherwise `round_mismatch` with `stored_score` |
| `retract-score` | member | `playing` | `{round_number}` | Deletes the caller's RoundScore for the current round, recomputes their total and any attack target's, and clears `has_submitted_round` and `current_round_score`. Runs no round check, as it can't complete a round. Allowed during edit mode. Another round is `round_mismatch` with `stored_score`. Extra: `already_applied: false`, `round_score` (what was deleted) | Nothing stored: `200` with `already_applied: true`, `round_score: null` and no change |
| `force-next-round` | host | `playing` | `{round_number}` | Gives every unsubmitted player a 0 RoundScore (`cards: []`), turns edit mode off, then **advances** | `round_mismatch` |
| `set-edit-mode` | host | `playing` | `{on}` | Sets `is_edit_mode` and `edit_mode_by` (null when off). Turning it off runs the round check | No change |
| `edit-score` | host | `playing` | `{player_id, round_number, cards, base_sum, final_score, game_mode?, busted?, duplicate_allowed?, flip7_attack_player_id?}` | `round_number` must be between 1 and `current_round` (400). Upserts that RoundScore and recomputes the total and the old and new attack targets'. For the current round it also marks the player submitted. Runs the round check, which does nothing while edit mode is on | Same result |
| `end-game` | host | `playing` | `{}` | **Finishes** with `finish_reason: ended`. `games_won` is not changed | `wrong_status` |
| `reopen-game` | host | `finished` | `{}` | Sets `status: playing`, clears `winner_player_id` and `finish_reason`, and turns edit mode on, owned by the caller. A `max_score` finish takes the winner's win back, floored at 0. Scores and `current_round` don't change, and any player with a score for the round counts as submitted. Done Editing then runs the **round check** | `wrong_status`, so a win comes off once |
| `play-again` | host | `finished` | `{}` | Deletes RoundScores, resets every player as in `start`, and sets `status: waiting`, `game_number` +1, `current_round` 1, no current turn, edit mode off, no winner and no `finish_reason`. `game_mode` is kept. Every player stays in the room; players who do not want to stay use `leave` | `wrong_status` |
| `set-games-won` | host | any but `closed` | `{wins: {player_id: integer ≥ 0}}` | Sets `games_won` for each listed player | Same result |
| `close` | host | any | `{}` | `status: closed` | No change |
| `delete` | host | any | `{}` | In one transaction: sets `status: closed`, then deletes the room's ChatMessages, RoundScores, Players and the room. Publishes the `closed` update **first**, then the deletes (room last), so clients learn the room is gone even if they miss the rest | `room_not_found` |

**Round check** (after `submit-score`, `edit-score`, `set-edit-mode` off, `leave`,
`kick`): if the room is `playing`, edit mode is off, there is at least one player, and every
player has `has_submitted_round`, then **advance**.

**Advance**: if any player's total is at or above `max_score`, **finish** with
`finish_reason: max_score`. Otherwise increment `current_round`, reset every player's
`has_submitted_round` (false) and `current_round_score` (0), and move
`current_turn_player_id` to the next player by turn order (wrapping around). Because this
runs inside the transaction that made the last change, a round advances exactly once, no
matter how many devices are open.

**Finish**: sets `status: finished`, `finish_reason`, `is_edit_mode: false`, and
`winner_player_id` to the highest total (ties go to the lower `turn_order`). For
`max_score` only, the winner's `games_won` goes up by 1. A finished room can't be finished
again, so this happens once, unless `reopen-game` takes the win back first: each finish counts one
win, and one reopen takes it away.

Validation for scores: `cards` is an array of at most 30 `{value: string, type: string}`;
`base_sum` and `final_score` are integers from −1000 to 1000; `busted` and `duplicate_allowed` are
booleans, left out meaning false, and always stored, so a replacing score doesn't keep the old value.
A force-next-round zero has neither. The server trusts the client's
score arithmetic, so `game_mode` says which mode it was worked out under: when present and not the
room's mode, the score is refused with `mode_changed`. It is checked and never stored. A body
without it isn't checked.

`flip7_attack_player_id` is a non-empty string, or null or left out for none, and always stored. Naming
someone needs a mode with attacks (`brutal`), a hand that isn't `busted` and has seven different numbers
(Lucky 13 and its 13 count as two) with no repeat unless `duplicate_allowed`, and another player in the room, who may have busted or already
scored; anything else is `400 bad_request`. For `edit-score`, "another" means other than `player_id`. A
retry of a closed round's stored score isn't checked again. `final_score` leaves the bonus out.

**Room lookup for non-members.** `GET /api/rooms/by-code/:code` (any signed-in user) returns
`200 { "room": GameRoom, "players": [{ "id", "name", "turn_order", "is_host" }],
"my_player": Player | null }`, or `404 room_not_found` (closed rooms count as not found).
The join screen uses it. It shows names only, no emails. Once the caller has joined, the
client switches to the member reads and the socket subscription.

**Lock-down (`LOCK_GAME_ENTITIES=true`, the default).**
The rules apply to non-admins:
- **Writes:** generic writes (`POST`/`PUT`/`DELETE` on
  `/api/entities/GameRoom|Player|RoundScore`) return `403`.
- **ChatMessage:** create requires the caller to be a member of `room_id`, with `sender_id`
  set to the caller's Player. Update and delete return `403`.
- **Reads:** a generic read must name a room the caller belongs to, through `q.room_id`
  (or `q.id` / `q.code` for GameRoom). Anything else returns `403`.

Without the flag, generic reads and writes behave as they do today.

There is no bulk cleanup endpoint (X80): `/api/admin/cleanup` was removed with the Cleanup page and is
a 404. A host (or an admin) deletes a room with the `delete` action, and the server deletes stale rooms
itself (X81): see `STALE_ROOM_HOURS`.

The by-code lookup also leaves `host_email` and `created_by` out of `room`.

## Hold-to-vote (`vote-*` realtime messages)

A generic way for the players in a room to agree on something together. Every online player
presses and holds the same option at the same time, and when they have all held it for
`VOTE_HOLD_MS` (3000 ms), the server carries the decision out. The first use is choosing a
new host. Later uses add a new **topic** on the server and reuse the same client component.

Rules (all enforced by the server, which owns the holds and the timer):

- **Eligible voters** are the room's players who are online (see presence). A vote
  needs at least 2 eligible voters, or 1 when the current host is offline (otherwise a
  2-player room whose host's phone died could never pick a new host).
- **Offline host grace:** while the host is offline and was last seen less than
  `HOST_OFFLINE_GRACE_SECONDS` (120 s) ago, no vote can pass; holds are still recorded. When
  the grace runs out the server re-checks and broadcasts `vote`, so a vote everyone already
  holds starts its timer then. A host with no `last_seen` doesn't lock the vote.
- **Holds:** each player holds at most one option per topic, and holding a new option
  replaces the old one. A hold belongs to the **socket** that sent it. That socket
  releasing, closing, or unsubscribing from the room drops the hold. Another socket of the
  same user doesn't.
- **Unanimous:** when every eligible voter holds the same option, the server starts a
  `VOTE_HOLD_MS` timer. Any change cancels it: a release, a different option, a player
  coming online or going offline, or a player joining, leaving or being kicked.
- **Host decides:** in a topic marked `hostDecides` (`make-host`), the online host holding an
  option starts the same `VOTE_HOLD_MS` timer on its own, whatever the others hold.
- When the timer fires, the server re-checks, runs the topic's action as a system call
  (no host check), clears that topic's holds, and broadcasts `vote-passed`. If the
  re-check fails (for example, the room closed or the player left), the holds are cleared
  and only the new `vote` state is broadcast.
- Holds of offline players are kept but left out of `holds` and not counted.
- `vote-error` codes: `bad_request`, `unknown_topic`, `not_member` (also sent when the
  socket isn't subscribed to the room), `invalid_option`.

Topics:

| Topic | Option | Valid when | Runs |
| --- | --- | --- | --- |
| `make-host` | a `player_id` in the room | The room isn't `closed` and the player isn't already host | `make-host {player_id}` |

Client → server:

- `{"type": "vote-hold", "room_id", "topic", "option"}`. The socket must be subscribed to
  the room and the user must be a member. Otherwise the message is ignored and the server
  replies `{"type": "vote-error", "room_id", "topic", "code"}`.
- `{"type": "vote-release", "room_id", "topic"}`

Server → every socket subscribed to the room, on any change:

- `{"type": "vote", "room_id", "topic", "eligible": [player_id], "holds": [{"player_id",
  "option"}], "pending": {"option", "remaining_ms": number} | null, "unlocks_in_ms": number}`.
  `unlocks_in_ms` is how long the offline-host grace has left, 0 when a vote can pass. The client shows
  an option green while I hold it and blue while only others do. While `pending` is set, it
  shows progress counting down `remaining_ms` from when the message arrived. A countdown
  rather than a timestamp means clock differences between phones don't matter.
- `{"type": "vote-passed", "room_id", "topic", "option"}` is sent only after the action
  succeeded, so it comes after the action's normal entity events.

## Entering cards (`entry-status` realtime messages)

Who in a room is entering cards right now, for the turn indicator (X40). Advisory and in memory
only: never written through a game action, so no `version` bump or event log entry, and lost on a
restart until clients re-announce on `ready`.

Client → server:

- `{"type": "entry-status", "room_id", "state": "scanning" | "typing" | null, "round": integer}`.
  The socket must be subscribed to the room and the user must be a member. Anything invalid is
  ignored without a reply, and so is a non-null state when the room isn't `playing`, `round` isn't
  the current round, or the player has already submitted. `null` clears the sender's status.
  A non-null state within 1 s of that player's last one is ignored too, valid or not and before any
  database lookup. `null` is never held up.

Server → every socket subscribed to the room, when the list changes (a repeat that only renews the
time limit sends nothing), and to one socket after `ready` / `rooms-ok` when the list isn't empty, so
clients forget their list on those two:

- `{"type": "entry-status", "room_id", "entries": [{"player_id", "state", "round"}]}`, always the
  room's whole current list.

Rules:

- A status belongs to the **player**, not the socket: a socket closing or releasing its rooms doesn't
  clear it, because opening the camera does both (X26).
- A status lasts 120 s for `scanning` and 45 s for `typing` from the last message. Clients repeat
  theirs every 15 s while entering, and send `scanning` again just before opening the file picker.
  `tests/realtimeProtocol.test.js` checks a status survives one lost heartbeat.
- The server drops a status, with no client message, when the player submits or is given a score for
  the round, leaves or is kicked, the room's status changes, or the round moves on.

## Realtime (`/api/realtime`, WebSocket)

All messages are JSON text frames. The message types, the path and the timings both sides must
agree on (ping and live window, entry status heartbeat and time limits, vote hold) are defined once
in `shared/realtimeProtocol.js`, which the client and the server both import.

Client → server:

- `{"type": "hello", "epoch": string | null, "last_seq": number | null, "rooms": [roomId]}`.
  Sent on every (re)connect. `rooms` defaults to `[]`.
- `{"type": "rooms", "rooms": [roomId]}` replaces the socket's room list without
  reconnecting. The server answers `{"type": "rooms-ok", "seq": number}`, then sends a
  `presence` and a `vote` state, and an `entry-status` if anyone is entering, for each newly added room. Events after `seq` for the new
  rooms are delivered live, so the client refetches a newly added room **after**
  `rooms-ok` (the same rule as after `ready`). The client sends `rooms: []` on `pagehide`.
- **Subscribing** to a room requires membership. Other room ids are dropped from the list.
  Only admins may use `"*"`; it is ignored from anyone else.
- `{"type": "ping"}` → server replies `{"type": "pong"}`. Clients send one every 10 s while
  the page is visible. The server counts a socket as **live** while it has sent a `ping`
  message in the last 15 s. WebSocket pong frames only keep the socket from being
  terminated, so a frozen tab whose browser still answers pings counts as offline.
- `vote-hold` / `vote-release` (see Hold-to-vote).
- `entry-status` (see Entering cards).

Server → client:

- `{"type": "ready", "epoch": string, "seq": number}` is the reply to `hello`, followed
  by `presence` and `vote` states, and `entry-status` if anyone is entering, for each room. The client sets `last_seq = seq` on
  `ready`, and on every event it receives after that.
  - The **epoch** is stored in the database. It only changes when the event log is lost
    (new database), so restarts don't force a resync.
  - Events are stored in an SQLite `events` table (`seq`, `room_id`, `entity`, JSON
    text), trimmed to the newest 5000.
  - Before `ready`: if the epoch matches and `last_seq + 1` is still in the table, the
    server sends every stored event with `seq > last_seq` **for the socket's rooms**, in
    order. If the epoch differs, or the gap is too old, it sends `{"type": "resync"}`
    instead.
  - Clients must refetch on **every** `ready`, not only after `resync`, because rooms
    added since the last connection were never replayed. `resync` means "refetch
    everything", never "reload the page".
- `{"type": "event", "seq": number, "entity": "Player", "event": {"type": "create" |
  "update" | "delete", "id": "…", "data": Record, "timestamp": "ISO"}, "room_version":
  number | null}`. For `delete`, `data` is the record as it was before deletion.
  - `room_version` is the room's `version` after the action that produced the event.
    Generic entity writes leave it null.
  - **Stale snapshots:** the client tracks the highest `room_version` it has applied for
    each room, and drops any refetched snapshot whose `room.version` is lower. Otherwise a
    slow refetch could overwrite newer events (bug 2.6).
  - **Room gone:** when the client sees `status: closed`, a GameRoom delete, or a
    `room_not_found`/404 on refetch, it shows "room closed", navigates home, and ignores
    the Player deletes that follow. Only a delete of the caller's own Player while the
    room is still open means "you were removed".
  - **Room-scoped**: an event goes only to sockets whose `rooms` include its room (the
    GameRoom's own `id`, or `data.room_id` for the others). `ChatMessage` events also
    require the socket's user to be a member of the room.
  - Events without a room aren't delivered. Admin sockets may pass `"*"` in `rooms` to
    receive everything.
- `{"type": "presence", "room_id", "players": [{"player_id", "online": bool,
  "last_seen": ISO | null}]}` is sent to the room's sockets whenever someone in it comes
  online or goes offline, and when a player joins, leaves or is kicked.
  - A player is online while at least one of their user's **live** sockets is subscribed
    to the room. One user with two sockets is one online player.
  - The server writes `Player.last_seen` when a player goes offline. That write doesn't
    publish an entity event; this message carries it.
- `vote`, `vote-passed`, `vote-error` (see Hold-to-vote).
- `entry-status` (see Entering cards).

The server pings clients every 30 s (WebSocket ping frames) and terminates dead ones;
Cloudflare drops idle connections after ~100 s.

### Launcher messages (not realtime)

Run by the desktop launcher (an Electron utility process), the server also posts
`{ type: 'room-stats', stats: { playersOnline, roomsLive, rooms: [{ code, status, round, maxScore, online, players }] } }`
to `process.parentPort` (`shared/launcherMessages.js`, X66): once when it starts listening, then at most
once a second after presence or a `GameRoom` changes, and only when the stats differ. Phones never see
these. Without a parent port (Docker, `npm run dev`) nothing is sent.

## Frontend client interface (`src/api/backend.js`)

```js
backend.auth.me()                       // Promise<User>; rejects Error{status:401}
backend.auth.isAuthenticated()          // Promise<boolean>, never rejects
backend.auth.updateMe(data)             // Promise<User>
backend.auth.redirectToLogin(fromUrl)   // navigates to /login?from_url=…
backend.auth.logout(redirectUrl?)       // POST logout, then go to logout_url ?? redirectUrl ?? reload

backend.entities.<Name>.list(sort?, limit?, skip?)
backend.entities.<Name>.filter(query, sort?, limit?, skip?)
backend.entities.<Name>.get(id)
backend.entities.<Name>.create(data)
backend.entities.<Name>.bulkCreate(array)
backend.entities.<Name>.update(id, data)
backend.entities.<Name>.delete(id)
backend.entities.<Name>.subscribe(callback)  // returns unsubscribe(); callback(event)
```

Rejected promises are `Error` objects carrying `status` (HTTP status) and `data` (parsed
body). One shared WebSocket serves all subscriptions; it opens lazily on the first
subscribe, reconnects with backoff, tracks `epoch`/`last_seq`, and on `resync` notifies
`onResync` listeners (it reloads the page only when there are none).

### Realtime client (`src/api/realtime.js`)

```js
realtime.setRooms(roomIds)        // sent in hello, and as a `rooms` message when connected
realtime.onReady(listener)        // after every ready and rooms-ok: listener({ seq }); returns off()
realtime.onResync(listener)       // returns off(); the page reloads only if no listener is registered
realtime.onStatus(listener)       // 'connecting' | 'live' | 'reconnecting' | 'signed-out'; returns off()
realtime.getStatus()
realtime.onPresence(listener)     // listener(presenceMessage); returns off()
realtime.onVote(listener)         // listener(voteOrVotePassedOrVoteErrorMessage); returns off()
realtime.voteHold(roomId, topic, option)
realtime.voteRelease(roomId, topic)
realtime.onEntryStatus(listener)  // listener(entryStatusMessage); returns off()
realtime.entryStatus(roomId, state, round)
```

The entity `subscribe(callback)` callbacks also receive `room_version` as a second
argument: `callback(event, { room_version, seq })`.

Hooks don't use this directly. They use the room channel below, apart from `ConnectionBanner`,
which reads `getStatus`/`onStatus`.

### Room channel (`src/api/roomChannel.js`)

A room's realtime traffic in the game's terms, exported from `src/api/backend.js` as `roomChannel`.
Wire field names stop here: hooks and `src/lib` see `playerId`, `remainingMs`, `unlocksInMs`,
`lastSeen` and `roomVersion`. It also owns recovery, so no caller watches for a reconnect.

```js
const leave = roomChannel.joinRoom(roomId, {
    onRecordChange(entity, event, { roomVersion }) {},
    onPresence(players) {},                    // [{ playerId, online, lastSeen }]
    onStale() {},                              // refetch: after every ready, rooms-ok and resync
});

roomChannel.getVote(roomId, topic)             // the latest VoteState (src/lib/voteState.js) or null
roomChannel.subscribeVotes(listener)           // returns off(); fits useSyncExternalStore
const ballot = roomChannel.openBallot(roomId, topic, { onPassed(option) {}, onError(code) {} });
ballot.hold(option)                            // sent again after a reconnect while still held
ballot.release()                               // sends only if this ballot is holding
ballot.close()                                 // releases, and stops listening

const entry = roomChannel.startEntry(roomId, round);
entry.announce('scanning' | 'typing')          // heartbeat from now on, and sent again after a reconnect
entry.close()                                  // tells the room I am done

const stop = roomChannel.watchEntering(roomId, listener);
// listener([{ playerId, state, round }]): emptied on ready and rooms-ok, and while I am not live
```

A **ballot** is one player's hands on one vote: a button holds through it, and closing it can't
cancel a hold made through another. An **entry** is one player entering cards for one round.

### HTTP client (`src/api/httpClient.js`)

Requests use `redirect: 'manual'`. A `401`, or an `opaqueredirect` response (Cloudflare
Access bouncing an expired session to its login page), rejects with `Error{status: 401}`
and emits "signed out". `realtime.onStatus` then reports `'signed-out'`. GETs retry 3 times
with backoff on network errors and 5xx; POSTs are never retried automatically.

### Game API (`src/api/game.js`)

There is one function per action. Each returns the action response and rejects with
`Error{status, data}`, where `data.code` is the error code.

```js
game.createRoom({ max_score, name, game_mode })
game.lookupRoom(code)                         // GET /api/rooms/by-code/:code
game.join(roomId, { name })
game.leave(roomId)
game.kick(roomId, playerId)
game.makeHost(roomId, playerId)
game.reorder(roomId, playerIds)
game.setGameMode(roomId, gameMode)
game.start(roomId)
game.submitScore(roomId, { round_number, cards, base_sum, final_score, game_mode, busted, duplicate_allowed, flip7_attack_player_id })
game.retractScore(roomId, roundNumber)
game.forceNextRound(roomId, roundNumber)
game.setEditMode(roomId, on)
game.editScore(roomId, { player_id, round_number, cards, base_sum, final_score, game_mode, busted, duplicate_allowed, flip7_attack_player_id })
game.endGame(roomId)
game.reopenGame(roomId)
game.playAgain(roomId)
game.setGamesWon(roomId, wins)                // { [playerId]: number }
game.closeRoom(roomId)
game.deleteRoom(roomId)
```
