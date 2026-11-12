# Agreed behaviour

The single source of truth for behaviour that was decided rather than obvious from the code.
Each entry names the bug ID it came from (X1, X2, ...).

Tests pin every entry. If you change a behaviour, update the entry and its tests together.
New decisions get the next X number (the last used is X89).

## Scoring

- **Negative scores are allowed** (X1). The server accepts `final_score` and `base_sum` as
  integers from −1000 to 1000. In Classic the client sends the true value and never floors at 0
  (Vengeance does: X42). A number card typed as `-3` counts as −3. `÷2` uses `Math.floor`
  (−7 ÷ 2 = −4).
- **Blank card rows are ignored** (X2). An empty or whitespace-only number row doesn't count
  toward a bust or the 7-card bonus. Blank cards of any type are never sent: the manual entry,
  the scanner and the score editor all filter through `readHandEntry` (`src/lib/handEntry.js`),
  and their live previews score the same filtered cards that get saved (X19). Everything else
  keeps `parseInt` behaviour: `"3.5"` is 3 (and busts with `"3"`), `"99"` has no range check,
  and `"abc"` is 0.
- **Bust is only duplicate number cards or the Bust button** (X25). A 0 or negative total from
  modifiers is a normal score: the summary shows its working (`13 ÷ 2 − 6 =` **0**), and only a bust
  shows the red box: "Duplicate Cards", or "Bust" for a declared one. A negative total is shown in
  red. A bust is recorded on the score, so a score table can tell it from any other 0 (X45).
- **Modifier values are digits only; the type carries the sign** (X34). Every card value field
  is `type="number"` so phones show the number keyboard. `sanitizeCard`
  (`src/lib/scoreEntryCards.js`) strips everything but digits from a modifier's value as it is
  typed, when a row's type changes, and when cards come in from a scan, a restored draft or a
  stored score (`"x2"` → `"2"`, `"-4"` → `"4"`). Number cards keep their sign (X1), and a 0 becomes
  The Zero in a mode that has it (X42). Scoring ignores any sign in a modifier value, so an adder
  `"-4"` adds 4.
- **One Add card button, and type buttons for the active row** (X34). Add card appends a number row
  per tap, blank rows included, as they are dropped on Confirm. A second tap within 300 ms with the last
  row still blank is a double tap and is ignored. Enter adds a row of the same type. The type buttons act on
  the row last focused (outlined), or the newest if none, and keep its value. Choosing a special card for
  a row with a value adds it as a new row; a blank row becomes it. They are hidden with no rows. A value field's border matches its picker's colour, focused or not. After an add the list
  scrolls only as far as keeps Add card clear of the Confirm bar and the keyboard, so cards can be added
  in a row without chasing the button. That scroll waits 150 ms, so the new row is seen to appear first (X57).
- **The page itself never stays scrolled** (X50). The app scrolls inside Layout's div, but iOS scrolls
  the page to show a focused field and can leave it there after the keyboard closes, showing the body
  under the app. Layout puts it back at the top unless a field has focus, and the body is dark like Layout.
- **A hover style only applies where a device can hover** (X49), via Tailwind's
  `hoverOnlyWhenSupported`, as a phone keeps `:hover` on the last thing tapped and it looks stuck.
- At most 30 cards per round (`MAX_CARDS_PER_ROUND`), counted without blank rows, as the server refuses
  more. Above that manual entry's and the scanner's Confirm and the score editor's Save are disabled and a
  line says why, including for a scan, which can return up to 40, and a hand marked Bust. Confirm is also
  disabled when only blank rows remain. All three take this from `readHandEntry` (`src/lib/handEntry.js`).
- Removing every card in the score editor saves a score of 0 with an empty card list.
- **"Score submitted!"** (X12): when my submit completes the round or finishes the game, a
  short success toast shows, because the waiting screen with the inline message disappears at
  once. When others still have to submit, only the inline message shows. The reply and the room update
  can arrive in either order, with the same result both ways (`src/lib/scoreLifecycle.js`).

## Rounds and dealer

- **When the dealer leaves or is kicked and that completes the round, the next player in turn
  order deals** (X4). The server records this in the room field `turn_passed_round` (set by
  `removePlayer`, cleared on advance, play-again and start). `current_turn_player_id` is always a
  real current player: the next dealer, even while edit mode holds the round. Later round checks
  (edit mode turning off, a mid-game join, Done Editing after a reopen) never rotate past them (X4b,
  X20, X45). A finish keeps the marker for that reopen, and a dealer leaving a finished game whose
  round was complete sets it, including one finished by Force Next Round.
- A game only finishes when a round completes. Editing an old round past `max_score` doesn't
  end it. Mid-game joiners start at 0, and the round waits for them.
- Ties at `max_score` go to the lowest `turn_order`. If several players cross in one round, the
  highest total wins. Only a `max_score` finish adds a win; `ended` names a winner without one.
- `Room.game_number` is 1 on create and +1 on play-again. A room without it counts as 1.
- The dealer rotates every round in turn order, wrapping, and each game (including after
  play-again) starts with the first player in turn order, which the host sets by reordering.
  Pinned by `server/test/turnRotation.test.js`.
- **A host can start a game alone** (X63), to try the app out. Start is never disabled for want of
  players; with only the host in the room the lobby says "Just you so far. Start now to try things
  out." The server never had a minimum, so a solo round ends as soon as the host scores, and a solo
  Flip 7 just takes its +15, as there is nobody to attack.
- **A soft bell plays each time the round goes up during a game** (X64): two triangle tones (E6 and
  B5) and a quieter echo, unlike the bright game chimes, on every phone. It goes by
  `current_round` rising while `playing`, so opening a room mid-game, Start and Play Again (both
  set it to 1) are silent, and a round that ends the game plays only the game-over chime. The mute
  button silences it like every other chime. No vibration.
- **No rematch vote** (X29). The host alone decides on play-again; the `set-rematch` action and
  the `wants_rematch` field are gone. On the game-over screen guests see "Waiting for the host
  to start a new game…".

## Joining, leaving and kicks

- **A kick or a deliberate leave is remembered** (X3, X3b). It's stored per room code in
  `localStorage` through `safeStorage` (`src/lib/autoJoin.js`), and the value is the room's id,
  so a reused code doesn't match. Auto-join skips that room and shows the Join screen. A
  successful manual Join clears the flag.
- **Auto-join never runs on a closed room** (X6): no join call and no toast. `GameRoom` checks
  room-closed before the auto-join spinner.
- If `full_name` is only spaces, the default player name falls back to the part of the email
  before `@`.
- After a join, the spinner waits for the refetch. If I'm still not a member, it falls back to
  the Join screen and doesn't spin forever.
- **The lobby and game room player lists show the same online dot** (X53) next to each name: green
  online, grey offline. I always show as online to myself.

## Choosing a new host

- **A vote can only pass once the host has been offline for 2 minutes** (X27), so a host who
  switched app or lost signal for a moment keeps the role. The server enforces it from the
  host's `last_seen` (`HOST_OFFLINE_GRACE_MS` in `server/src/votes.js`, overridable with
  `HOST_OFFLINE_GRACE_SECONDS`) and sends the time left as `unlocks_in_ms`. A host never seen
  online doesn't block the vote.
- **Other players see nothing of the vote while the host is online** (X27). When the host goes
  offline they see a section that looks collapsed and counts down `m:ss`, but can't be opened as
  there is nothing to vote on yet. At 0 the vote takes its place, open for good. If the host comes
  back, it all disappears. A `vote` message still listing the host as eligible predates them going
  offline (presence arrives first), so its "no wait" is ignored and the vote never flashes open.
- **The host can hand over hosting alone** (X38), in a section of their own, "Choose a new host",
  always there and collapsed by default: holding a player for the full 3 s makes them host, with no
  one else holding. The server's `make-host` topic is `hostDecides`; an offline host's hold doesn't
  count.
- **A vote button is green only while I'm holding it** (X52), alone or with others, and blue while
  only other players are, including through a countdown I'm not part of. These colours have a
  meaning, so they stay fixed in every game mode, and `HoldToVote.jsx` is on the list of files
  allowed a fixed blue in `tests/gameRules.test.js`.

## Drafts (unsent score entries)

- **Drafts are keyed by room, game and round** (X5): `flip7_pending_cards:r<room>:g<game>:<round>`.
  A draft only restores in the game it was made in. Drafts in the old key format, or from
  another game, are dropped on restore.
- An open score entry closes when `game_number` changes, even if the tab never saw the game end
  (X5b).
- The "reloaded in the background" toast shows at most once per page load (X21).

## Home and room creation

- **`max_score` takes the integer part of what was typed** (X7): `"150abc"` → 150, `"1e3"` → 1,
  `"150.7"` → 150. Missing, NaN, 0 or negative falls back to 200. The same rule applies to the
  create-after-login URL and to the Home input on submit. Clearing the input while typing doesn't
  snap it back to 200. The parsing lives in `src/lib/maxScore.js`.
- **Home is a lit table in fixed indigo and gold** (X58). Its `.home-*` styles are in `src/index.css`, and
  gold marks only the one main action, Create Room, plus the logo's card and the hero card (X73). Return to game
  stays emerald. A dealt hand of cards (`src/pages/home/HeroCards.jsx`) is decoration, hidden from screen
  readers and still under reduced motion. A gold dot on the gear shows a non-default max score is set
  while the settings are closed. It is designed for phones first: hosting and joining share one panel so
  the first screen holds the actions, short screens shrink the hero and drop the tagline so Create Room
  stays in view, and the invite QR sits below the panel. On Home alone the sound toggle goes dark, via
  `body:has(.home-stage)`; room screens keep the white one.

- **Rooms live at `/room/CODE`** (X80), e.g. `/room/3Z7R7L`. The path helpers are in `src/lib/roomUrl.js`;
  join links, QR codes, the launcher and login return URLs all use them. Old `/GameRoom?code=CODE` links and
  QR codes redirect there (`LegacyRoomRedirect`), or to Home with no code. There is no admin Cleanup page or
  `/api/admin/cleanup` endpoint any more; the server sweeps stale rooms instead (X81).
- **Stale rooms delete themselves** (X81). Every hour, and when the server starts, rooms whose last action
  (or creation, with none yet) is older than `STALE_ROOM_HOURS` (default 24, `0` = off) are deleted like the
  host's `delete`: published as closed, then removed with their players, scores and chat. A room with any
  player online is skipped however long it has idled, so a table that stopped playing keeps its room while the
  page is open. A room that fails to delete is logged and skipped. The sweep is in `server/src/staleRooms.js`.

## Game modes

- **A room has one `game_mode`, and it locks at the first score** (X41). Missing or unknown on a
  stored room reads as classic, with no migration. `modeCapabilities` in `shared/rules.js`, which the client and
  the server both import, is the only place that says what a mode allows, and `GAME_MODES` in `src/lib/gameRules.js`
  adds its words and looks, so nothing else may assume how many modes there are. The host sets the mode when creating the room or with `set-game-mode`, allowed in `waiting`
  and in `playing` while the room has no RoundScores at all, however they were made, so it unlocks
  again if every score is retracted (X45). Otherwise it
  answers `409 mode_locked`; a finished game goes through Play Again, which keeps the mode. Setting the
  mode a room already has changes nothing, so a retry is safe. Every score in a room is therefore
  under its current mode, with no per-score stamp. The client sends the mode it scored under, the
  server answers `409 mode_changed` if that's out of date, and the client refetches, re-scores the
  open entry and keeps the cards. The mode is checked and never stored on a score. A bust from the
  Bust tile has no entry to re-score, so it is sent again straight away under the room's new mode,
  and the player is told if that fails too.
- **The picker is a full-screen overlay, opened from the host's logo and from a full-width row above Create Room** (X41).
  It blurs the page, lights it in the current mode's colours, and animates in and out; reduced motion
  gets neither. A tap on
  the logo only opens it, because a stray tap mid-round must not change the rules. In `waiting`,
  selecting applies at once; in the first round it asks first. The room changes only when the server's
  update arrives, for the host too, and a change or lock from elsewhere closes the overlay. It opens
  with focus on the current mode's radio, so Enter straight away can't apply another; arrow keys move
  between radios only, and a radio's tagline and highlights are its description. "Full rules" opens the
  rules sheet over the overlay, and closing the sheet returns to it with focus on that button. A card
  lifts on hover, and the list's padding must hold the lift plus its ring, or the top is clipped. A sheet
  opened any other way returns focus to what opened it, and one left open when a change from elsewhere
  closed the overlay returns it to the logo. The logo button's name starts with the words on it (WCAG
  2.5.3), and the h1 around it keeps just those words. Guests and a locked host open the same overlay
  from the logo to read the modes and their full rules: a list rather than radios, with nothing to
  select and a line saying why. They also get the mode's name for screen readers. Every mode's logo names it in a line under FLIP and the card (X72): Classic in
  gold, and Vengeance and Brutal in the same red. "Showdown" appears only in the brand logo (Home and the
  launcher), which is the app's name rather than a mode. On Home the choice is remembered per
  device (`flip7_last_game_mode`), survives login through the `game_mode` URL param and doesn't
  change the page, which always looks classic as it has no room. Start names the mode ("Start Vengeance
  Game"); Classic stays "Start Game". The rules sheet opens from every room screen and from score entry,
  on the room's mode, and only explains. Its text is our own words.
- **A mode change plays the same shift on every screen** (X41). `useGameModeTheme` puts
  `data-game-mode` on `<html>`, as dialogs portal to body, and removes it on leaving, so Home is never
  red; the page is neutral until a room has loaded. `ModeShift` spreads from the logo over 400 ms, the
  theme swaps at full cover, and it fades over 400 ms (a 200 ms cross-fade under
  `prefers-reduced-motion`). It takes no pointer events or focus, so open card entry and its keyboard
  are untouched, and sits at z-45: above the page and toggles, below dialogs. `modeTransition` decides,
  and only a real change between two known modes counts, not first load, refetch or rejoin. A tab in
  the background skips it. Non-hosts also get a toast naming the mode, and anyone with entry open is
  told their cards were re-scored. The glow is centred on the logo, where the circle starts. The circle
  has only been seen in a desktop browser at phone size, so if a real phone stutters, setting
  `MODE_SHIFT_STYLE` in `src/lib/gameRules.js` to `'cross-fade'` gives everyone the plain cross-fade.
- **A kicked player keeps the room's theme on its Join screen** (X41), as that is still the room's page
  and any join link looks the same. It goes on leaving the page, like a deliberate leave.
- **The rules show the room's target score.** A target changed from the default of 200 shows the 200
  struck through beside it; Home has no room, so it shows the default.
- **A room's theme covers its own coloured panels** (X41): the room code card and the scoreboard header
  take a solid colour from the mode's theme block, with AA white text, and so does the page background.
  The theme's gradients were dropped as looking cheap; Manual and Scan tiles and the shift animation keep theirs.
  The room code card alone came back to one, by request: diagonal through black at the middle, indigo to
  purple in Classic, plum to dark red in Vengeance, crimson to dark red in Brutal. Every stop keeps AA with white.
- **Vengeance is plum and rose; Brutal is red on black** (X41). Vengeance has a dark plum background,
  room card and scoreboard header, rose accents, a red logo 7 and title, and a rose Start. Its lobby code
  card runs crimson (the same one as Brutal's), black, then dark purple. A solid red room
  card with a crimson Start clashed, and indigo accents fought the rose. Its Manual and Scan tiles stay
  blue, so Bust is still the only red tile. Wine and brass, and walnut and crimson, were both tried and dropped. Brutal's backgrounds are a pure red, not wine, so the two stay apart, and its Manual and Scan tiles
  are steel so Bust stays the only bright red among them.
- **New room UI takes its colours from tokens, and colours with a meaning stay fixed** (X41). The
  `--ui-*` and `--tile-*` tokens are set per mode in `src/index.css` and exposed by `tailwind.config.js`
  (`bg-ui-accent`, `text-ui-accent-strong`, ...), so a new mode restyles everything and dialogs follow,
  being under `<html>`. Card type colours, emerald success, red bust and danger and amber waiting stay
  fixed Tailwind classes, in every mode. Start and Play Again are themed, as they are calls to action
  rather than a result. Home and its account bar keep fixed indigo as they have no room; with no
  attribute the tokens read as classic. Every token pair is AA in Vengeance and Brutal
  (`tests/gameRules.test.js`). Classic holds its earlier exact shades, which leaves some gaps that test
  lists: white on the Start button and the Manual and Scan tiles, "(You)", "Next up", the Quick Sends
  count and an input focus ring. Closing them would mean changing how Classic looks, which is the
  owner's call.
- **The rules sheet separates the publisher's answers from our suggestions** (X51). Each mode has "Edge
  cases the publisher has answered" (rulebook or FAQ) and "Edge cases with no official answer", which is
  advice for the table, as the app only scores final hands and enforces none of it. Vengeance and Brutal open with
  "What's changed" from the mode they build on, side by side. Two app rulings differ from the FAQ, and the sheet says so:
  a tie goes to the lower turn order where the FAQ plays on, and the "Came from a Steal or Swap" switch
  (X45) undoes a bust the FAQ says stands, so the sheet calls it a house rule.
- **Just One More! on a player who stayed counts as the publisher's rule** (X55). The rulebook has no line
  for this exact case, but it allows Action cards on stayed players, says they resolve them without
  re-entering the round, and says Just One More! forces "any player" to take the card. So the sheet lists it
  as answered: they take the card, can bust on it, and remain stayed.
- **Vengeance scores in the rulebook's order** (X42): add the numbers, halve for ÷2 and round down,
  subtract, stop at 0, then add 15 for a Flip 7 (48 → 24 → 20 → 35). The bonus comes after the floor.
  Scorers never reject a stored card, so a card from another mode still scores; Classic counts a
  `special` card as a number, and its arithmetic is otherwise unchanged. The score summary shows the
  floor step, and that The Zero wiped a hand.
- **Rulings the rulebook leaves open** (X42). The app scores the final hand, so every action card has
  already happened and is never modelled.
  - The Zero with a Flip 7 scores normally; without one the hand is 0, whatever its modifiers. It
    counts toward the seven. A number 0 is always The Zero in these modes, even a stored one.
  - Unlucky 7 and a plain 7 is a bust, since the plain 7 must have come after it. Other cards beside
    Unlucky 7 all score, as nothing is ever discarded for the player; a quiet line reminds them.
  - Two plain 13s bust, and so does Lucky 13 with two plain 13s. Lucky 13 and one 13 both score and
    both count toward the seven.
  - More than 7 number cards gets no bonus and a warning, as it can't happen in play. The rows past the
    seventh number or special card are tinted red, in every mode, so the player sees which went over.
  - The scorer takes `duplicateAllowed` (a duplicate from a Steal or Swap isn't a bust: both score, and
    only different numbers make the seven) and `busted` (a declared bust, whatever the cards). Classic
    has no such cards, so its scorer ignores `duplicateAllowed`. X45 sets them.
  - A tie goes to the lower turn order, as in Classic. Two decks aren't supported by the special card
    buttons, which allow one of each; the row's type picker still works.
- **Special cards are `{ type: 'special', value: '0' | '7' | '13' }`** (X42). A row has a fixed label
  and no input, and its type button moves no focus, so no keyboard opens. A typed 0 in a mode with The
  Zero becomes the special once it is settled: when the field loses focus, on Enter, Add card, a type button or
  Confirm, not on each keystroke, as that replaces the field and closes the keyboard (deleting the 1
  from "10" passes through a 0). Confirm covers iOS, which doesn't focus a tapped button. A mode decides
  what can be added, but a row already in a list stays and stays editable, as the type picker always
  includes its own type.
- **A bust on 13s or 7s offers a one-tap fix** (X42), because a plain 13 read in place of Lucky 13
  would wrongly bust someone: "Change one 13 to Lucky 13" / "Change one 7 to Unlucky 7". It shows for
  repeated plain cards when that special isn't already in the hand, on all three entry screens.
  Lucky 13's only shows if the fixed hand stops busting, so not on 13, 13, 13 or 13, 13, 5, 5. The
  Unlucky 7 one corrects the reading but can't undo the bust, by the ruling above, so a line then
  says why. After a tap, focus stays in the panel and a polite live region says what changed.
- **A scan reads the photo as the room's mode** (X46). The client sends the registry's `scanMode`, and
  every fallback model gets the same one. Vengeance has its own prompt, which Brutal shares; a
  missing or unknown mode gets the classic prompt, pinned by a hash, and never an error. The model reads
  the printed text, then picks a closed label, and the server maps that label to a card. A label outside
  the deck is dropped, including x2, +N and ACTION, because guessing a sign would score a card nobody
  holds. On a 6 or 9 the printed word beats the label, as a turned card can get the wrong label with the
  right word. The target, measured by `server/eval/scanEval.js`, is 95% of photos exactly right on
  Flash-Lite with no false special card. On the 7 photos in `server/test/fixtures/card-images/vengeance`, it read 27 of 27 scans
  exactly right, with one more lost to a 503. That is a small sample: none has overlapping cards, a
  duplicate or a −8, so measure again when photos of those exist.
- **Classic offers only ×2 and +N, as the base game has no ÷2 or minus card** (X57). This covers the type
  buttons and pickers. A row already holding one, from a scan, a draft or a stored score, keeps its type
  and still scores, so opening it changes nothing. The classic prompt says these cards are the Vengeance
  deck's and to report them only when the symbol is clearly printed, but it still reads them, because
  dropping them would misscore a forgotten switch with no hint.
- **A classic scan that reads a 13, ÷2 or minus card says "These look like Vengeance cards. Ask the host to
  switch"** (X46, X57), as a forgotten switch is the likely cause and the base game has none of them. Only a
  scan raises it, not a restored draft or a typed card. It stays while the rows are edited, as it is
  about the photo, and goes on Retake or when the mode changes. It doesn't check who is looking or
  whether the mode has locked, so the host and a locked room see it too.

## Brutal

- **Brutal is Vengeance with no floor** (X43): the same deck, scan prompt and scoring order, but a round
  can end below 0. The rulebook leaves some of it open, so: The Zero without a Flip 7 is still 0, even
  with minus cards. A busted score is minus the sum of the hand's minus cards: ÷2 and The Zero in a
  busted hand do nothing, and a duplicate bust keeps the modifiers from before it, as the hand can't
  tell them from later ones. "Came from a Steal or Swap" works as in Vengeance.
- **A Flip 7 chooses +15 or −15 for a rival** (X43), on a chooser inside the score summary of all three
  entry screens. It shows only on a seven-card hand with someone to attack, starts on +15 and needs a
  tap. Attacking makes the hand's bonus 0. The choice is in the draft, so a reload and Change score
  bring it back rather than quietly going to +15. Like the override, it does nothing and isn't sent once
  the hand stops being a Flip 7, or if the target has left, when the chooser shows +15.
- **A −15 is stored on the attacker's score, as `flip7_attack_player_id`** (X43). A total is the player's
  round scores less 15 per attack on them, always recomputed, so submit order doesn't matter. The server
  checks the target is another player in the room, the mode has attacks, and the hand really has seven
  different numbers (Lucky 13 and its 13 count as two) and no repeat unless `duplicate_allowed` is on,
  with the rule kernel's `isFlip7Hand`, which agrees with the scorer, since the client's arithmetic is trusted but this moves someone
  else's score. Sharing the code changes nothing about that trust: the server still never re-scores a hand. A busted or already-submitted target is valid, and one with no score
  goes below 0. A retry of a closed round's score isn't checked again, as its target may have left.
- **Whatever replaces or removes the attacker's score settles the target** (X43), in the same
  transaction: a re-submit, `retract-score`, `edit-score` (old target and new), and the attacker leaving
  or being kicked, in any status. So the 15 goes back, and the round check after it goes by the settled
  totals: a −15 that takes a player back under `max_score` stops the game ending, and an attacker leaving
  can put them back over it. An attacker leaving a finished game corrects the totals but not the
  winner. A kicked target's attack is ignored, and the attacker's score stays as it was with no bonus;
  the host can edit it to take the +15. If they rejoin they are a new player, with no −15.
- **Force Next Round and Reopen Game needed no change** (X43). Force's zeros add nothing to a total that
  already has the −15 in it, and Reopen leaves scores and totals alone. Tests pin both.
- **The target is told** (X43): the round's cell says "−15 from Sam" in each score table, under the
  score, BUST or dash, as the number alone wouldn't add up to the total, and the target gets a toast.
  Attacks already there when the room loads stay silent.
- **Minus cards applied are shown apart from the buttons that add them** (X43): the buttons are outlined under
  "Add a minus card", and the cards counted are solid under "Applied to you" with the score so far, on the
  Bust tile's step and on the bust panel.
- **The Bust tile asks for minus cards before it sends** (X43), because the last player's bust closes the
  round at once and leaves no panel to add them on. The step replaces the confirm dialog and shows the
  score so far, the same row of −2 to −10, and the chosen cards, each removed with a tap. They are lost on
  Cancel or a reload, as nothing is sent yet. A bust sent with minus cards gets no Undo toast (X45), as it
  would lose them; the panel's Undo bust keeps them.
- **A bust can take more minus cards until the round closes** (X43). The panel shows the score so far and
  a row of −2 to −10, one tap each, so no keyboard. Each re-submits the hand with the card, still busted.
  A closed round goes through the host. Undo bust keeps a hand with minus cards in manual entry, where
  they count as any other card; a mistaken tap is fixed that way, and the panel says so. Undo waits for a
  card on its way. The confirm doesn't say "will be 0". The panel scrolls itself to the top when these
  buttons appear, because lower down the floating quick sends cover the edge of −2 and take the tap.
- **A minus card added after a bust can't be stolen, swapped or discarded** (X54). Neither the rulebook nor
  the FAQ answers this, so the sheet lists it under "no official answer". Action cards are played on "any
  player who hasn't busted", and Brutal lifts that for Modifier cards only. Swap and Steal do say any face-up
  card, which the other reading could lean on. With only such cards left, the Action card is discarded. It is
  rules text only, as the app scores final hands and never models action cards.
- **The theme is darker than Vengeance, and its shift faster** (X43): 280 ms to cover, 320 ms to fade.
  The logo has BRUTAL in a slanted bar the logo's full width under VENGEANCE, so colour isn't the only
  signal and the logo's shape doesn't pinch in at the word. The rules
  tab only shows what differs from Vengeance. A BUST cell's score sits under the word, as a 360 px
  screen has little room between the sticky columns, and the table scrolls again when a value changes.

## Correcting a score

- **Sending my score brings the turn card to the top of the screen** (X47), so Current Turn and Next Up
  are in view when the next turn starts. That goes for manual entry, the scanner and the Bust tile. It is
  the top of the white game card that scrolls there, once per submit, whether that hand scored or busted,
  and also when the score closed the round. The confirmation can then be below the fold on a short
  screen. One exception: a bust that takes minus cards (X43, Brutal) brings its own panel to the top
  instead. Under the turn card, the floating buttons cover Add −2 on a 360×640 phone, and the e2e test
  for that fails. Opening the screen on a score already in doesn't scroll, so a reload stays put.
- **Any player can take back their own score until the round closes, in every mode** (X45). A
  RoundScore has `busted` and `duplicate_allowed`, missing meaning false. `busted` is set by the Bust
  tile, or a duplicate hand with the override off, whose cards stay stored; a Force Next Round zero
  leaves it unset. Score tables show BUST instead of a 0, with the score under it when it isn't 0, and
  a plain 0 isn't red any more. `retract-score` deletes my score for the open round and asks no
  confirmation, as nothing is lost: **Change score** and **Undo bust** on a hand put its cards in a
  draft first and reopen manual entry, and Undo on the Bust tile's score goes back to the three tiles.
  The Bust tile busts without asking, as its toast and panel both offer Undo; only Brutal's step for
  minus cards comes first. The Bust tile's 4 s toast has an Undo too, dismissed by any retract or minus card, because a stale tap
  would take back the score entered after it. A failed retract leaves the panel alone and keeps the
  draft, as it may have landed; a reload drops a draft for a round I've submitted.
- **After the round closes it goes through the host** (X45). A late retract answers `round_mismatch`:
  a guest is told "Round closed. Ask the host to fix it", and the host is offered the editor on that
  round, with wording saying the score stands, since `roundMovedPrompt`'s says it wasn't saved. A
  closed round's totals don't move on a player's say.
- **The score editor opens on a late score whichever arrives first** (X59): the room turning edit mode on
  or the `set-edit-mode` reply. The start is set before the request and dropped if the request fails, and a
  new start replaces an editor already showing its grid, as the editor reads its start only on mount. That
  discards an unsaved edit there, which can only happen behind a prompt the host just accepted.
- **"Came from a Steal or Swap"** (X45) is a switch offered for a duplicate in a mode with
  `offersDuplicateOverride`, so never in Classic. On, the bust is undone: both cards score, and only
  different numbers make the seven. A third plain 13 can use it too, as the player vouches for the
  hand. Left on after the duplicate has gone it does nothing and isn't stored. It survives in the draft.
- **The host's editor has a Bust switch, and the override above the cards when it applies** (X45). Off
  rescores the cards; on an empty hand it leaves a blank row, with no focus. On keeps the cards. A hand
  with a duplicate is saved as busted even with it off, as the scorer says so.
- **The host can reopen a finished game until Play Again** (X45), for a score that ended it wrongly,
  which `edit-score` can't reach. It asks first, turns edit mode on and takes back a `max_score` win,
  floored at 0; an `ended` game never added one. Done Editing runs the normal round check, so the game
  finishes again or carries on, and one win is counted. Players with a score for the round count as
  submitted, as a Force Next Round zero didn't mark them, but someone who joined after the finish holds
  the round like any mid-game join. Guests get a toast, and it isn't announced as a game starting.

## Connection and UI

- **Every room screen has a diagonal gradient background** (X62): `--game-bg-gradient` per mode, a
  deeper version of the room-code card's (colour, near-black, a second colour, at 135°), drawn by
  `.game-screen-bg` over `--game-bg`, which stays as the flat colour underneath (overscroll, X50).
  Every stop keeps AA white text (`tests/gameRules.test.js`). With no mode the gradient is `none`.
  Home's own stage still overrides it; the mode picker's rows and Home's mode chip pick it up.
- **The red "Signed out" bar only appears when the session is lost mid-use** (X24): the
  connection must have been live earlier in this page load. A fresh signed-out load relies on
  the page's own sign-in path: the Sign in button on Home, or the room page's redirect to login.
  Tapping the bar reloads the page.
- **The dev server never reloads the page when its HMR socket drops** (X26). Vite's client
  reloads on every disconnect, and phones drop the socket when the camera app opens, so every
  Android photo reloaded the page under `npm run share`. `holdReloadOnDisconnect`
  (`src/lib/devReloadGuard.js`) holds that reload; refresh by hand to pick up code changes.
- **The screen always stays on** (X28): `useKeepScreenOn`, called from Layout, holds a Screen Wake
  Lock with no toggle or preference. The old sun toggle and its `flip7_wake_lock` key are gone, so
  players who had turned it off get it back on. Browsers only offer the API over HTTPS (or
  localhost), so on plain HTTP nothing happens, and a denied lock is just as silent. The lock is
  re-requested whenever the page becomes visible again.
- The empty toast viewport takes no pointer events, so it never blocks a tap underneath.
  Visible toasts stay clickable (X16).
- **Toasts close after 4 s, or when tapped anywhere** (X30). A per-toast `duration` overrides
  the default. They never closed before: nothing called dismiss, and the remove delay was
  1000000 ms, so "X is now the host" stuck around.
- **Chat emoji play for the whole room** (X31, unless muted: X44), captioned with who sent it to whom ("Sam → Alex",
  "You → Alex"). The recipient gets the full-size animation and the cue; everyone else, the
  sender included, gets a small card that fades after 3.5 s. One send to several players is one
  item. If two different sends arrive in one update, only one plays (mine first, else newest).
  The animation is the sender's confirmation, so a successful send shows no toast.
- **"Dismiss all" clears the chat emoji queue** (X33). While a full-size item (one sent to me) is
  on screen and at least one more waits, a "Dismiss all" button under the "N more" line clears it
  and everything waiting, small items included, and closes the overlay. Small cards never show
  it. A tap, Escape, "Dismiss message" or the fade still dismiss one item at a time. Clearing
  only affects my own screen. Muting chat clears it the same way (X44).
- **Chat can be muted on this device** (X44). `ChatMuteToggle` takes the old sun toggle's slot, in a
  game room only, and the choice is remembered per device (`flip7_chat_muted`, default unmuted)
  across rooms and rejoins. It is client-side only: senders aren't told. While muted, a message for
  me plays nothing and has no title cue, and pulses the button once; a message between other players
  does nothing at all; my own send (from another device, or one already in flight) plays as normal,
  as my confirmation. Muting also slides the chat button and quick sends off the left edge and closes
  an open chat dialog, so this device can't send until unmuted; unmuting slides them back. This narrows X31, which plays everything for everyone. Tapping mute closes what's playing and
  clears its queue, like "Dismiss all" (X33); the bottom-right toggles rise above the full-size
  overlay while it shows so the button can be reached. Muted messages still count as seen, so unmuting replays
  nothing and they are gone, as there's no chat history. The pulse is a soft ring at low opacity, in
  a colour each mode's theme sets so it stays visible on that background, 2 s per cycle for three cycles (one slow 4 s fade under `prefers-reduced-motion`), with no scaling,
  sound, vibration, badge or live region. A new message restarts it rather than stacking; a tap or
  leaving the room ends it, and it doesn't replay on coming back.
- **Full-size chat emoji dismiss themselves** (X35). The recipient's full-screen item dances for
  3 s (`FULL_EMOJI_DURATION_MS`), then goes away and the next waiting item plays. A tap, Escape,
  "Dismiss message" or "Dismiss all" still end it sooner. The emoji and its text size with the
  screen (`vmin`, clamped), so they fill a tablet instead of staying phone-sized.
- **Consecutive full-size chat emoji share one overlay** (X36). When one item for me follows
  another, the dimmed background stays put and only the emoji and text swap, so it doesn't
  flash. The overlay fades in and out only when full-size playback starts or ends.
- **Quick sends default to ❤️ 🥶 🤬 🥷, sent to everyone** (X32), shown only while nothing is
  saved; a saved empty list stays empty. At most 4 (`MAX_QUICK_SENDS`).
- **Quick sends fold into the chat button** (X79). They start folded. One tap on the chat button
  unfolds them (they rise out of it) and another folds them; sending one folds them too. A double
  tap (second tap within `DOUBLE_TAP_MS`, 300 ms) opens the chat dialog and leaves them folded, or
  closes the dialog if it's open. So a single tap waits out that window before it acts. With no quick sends saved, one tap opens
  the dialog; while the dialog is open, one tap closes it. Muting folds them (X44). Every tap sends
  a ring out from the button that grows and fades in 0.6 s (a fade in place under
  `prefers-reduced-motion`). Page clearance counts the quick sends only while unfolded, and eases
  over 200 ms so the page doesn't jump. The quick sends rise nearest first and fold farthest first,
  scaling from their bottom edge. Only their colours have a CSS transition: framer-motion owns
  transform and opacity, and a CSS transition on those re-tweens every frame it sets, which flickered.
- **Every chat send becomes a quick send** (X37). A successful send from the chat dialog saves
  its emoji, message and recipients at the front of the quick sends, silently, like a replayable
  chat history; there is no save button. The same emoji and message moves to the front instead
  of duplicating. Only the 4 shown are kept: older ones drop off, and a stored list longer than
  that is trimmed in storage on load.
- **A chat send tries every recipient and says who it missed** (X60). A send is one message per recipient,
  so one can fail while others land; it used to stop at the first failure and say only "Failed to send".
  Now a failure doesn't stop the rest, and when some got it the toast names both sides ("Sent to Cy, but not
  to Bo"). In the chat dialog the draft stays open, aimed at only the players it missed, so sending again
  can't repeat it to the rest. It is saved as a quick send once it reaches anyone, with everyone it was meant
  for, and a retry leaves that alone (X37). A quick send has no draft, so it only reports the miss; tapping it
  again sends to all of them. A send that reached nobody is still "Failed to send" and saves nothing. A message
  that landed although its reply was lost counts as missed, so a retry can repeat that one.
- The scoreboard marks my own row (accent bar, tint, "You" pill, `aria-current`) when given
  `currentPlayerId`.
- Pressing Enter in a card row adds a row of the same type. The score-entry Confirm/Save bar is
  sticky at the bottom.
- **Only adding a card focuses a card value field** (X39), because focus raises the phone keyboard
  and that hides the list being checked. Add card, Enter, or switching a blank row's type focuses
  that row (X34). Switching a filled row, scan results, a restored draft, opening the score editor and removing a card focus
  nothing. The manual entry screen is the one exception: it is opened to be typed in, so it asks
  for focus on open with `autoFocusOnMount`.
- **Both score entry screens open at the top of the screen** (X56). The manual screen's focus doesn't
  scroll to its field, and the panel scrolls to the top again as the keyboard opens, for 600 ms, because the
  keyboard interrupts the smooth scroll. A long restored draft's last row can start under the keyboard.
- **The Rules button is at the bottom of every room screen** (X77), not beside the logo, so the logo has
  the top to itself. The header still holds the sheet the mode picker's "Full rules" opens.
- **With no AI scanning set up, the Scan tile fades and says "Not set up"** (X78), but stays tappable: the
  scanner then says scanning isn't set up and offers manual entry. Cards brought over from manual entry
  stay editable there under the same notice, with no Retake Photo, rather than looking like manual entry.
- **Back from either score entry screen returns to the top of the scoreboard** (X76), however far down
  the entry screen was scrolled. Like X56 it scrolls again as the keyboard closes, for 600 ms. Only
  Back does this: switching from the scanner to manual entry doesn't, and confirming a score goes to the
  turn card (X47).
- **The turn indicator asks the table to hold on while anyone else is entering cards** (X40), since
  everyone enters at once and the next dealer can otherwise deal too early. It names one or two
  players and counts three or more, leaves me out, sits in a polite live region and doesn't pulse
  under `prefers-reduced-motion`. It is advisory and blocks nothing. An open scanner counts as
  "scanning" and manual entry as "typing". The status is an ephemeral `entry-status` socket message,
  never a game action, so it doesn't bump `version` or write to the event log, and a restart loses
  it until clients re-announce on `ready`. It is keyed by player with a time limit, not by socket,
  because the camera kills the socket (X26): 120 s for scanning, 45 s for typing, renewed by a 15 s
  client heartbeat in both states, because a scanner left open on the results screen is still
  entering. `scanning` is sent before the file picker opens. The server drops an entry on a submit,
  a leave or kick, a status change or the round moving on, and ignores a status for a player who has
  already scored. Closing entry sends `null`. While my own connection is down, I see no indicator
  rather than stale data. A status within 1 s of the same player's last one goes no further before any
  database lookup, so alternating states can't cost a lookup and a room broadcast per message. The
  latest different one is held and applied as that second ends, so Scan, Back, Manual shows "entering"
  within a second, and a `null` or a repeat of what the room was told cancels it. A first announce and
  a `null` aren't held up. A state held when its socket leaves the room is dropped, and the client says
  it again on `ready`.
- **Once a round is under way, the turn card points at the next dealer** (X48): Current Turn and Next Up
  sit side by side, and the white card moves from the current dealer, who drops to 50% opacity, to the
  next one, who pulses, so the table knows who starts the next round. Before that Next Up is the dim one. That starts
  when anyone has a score in, another player is entering cards (X40), or I have the scanner or manual
  entry open, and undoes itself if they all stop, such as when the only score is taken back. It doesn't
  pulse under `prefers-reduced-motion`, and it moves nothing on the server. When a departing dealer has
  passed the deal on for this round (X4), the current player is who deals next, so the card stays on them.
- Fullscreen toggle is a bare white icon pinned top right, styled unlike the bottom-right
  toggles. It is hidden where the Fullscreen API isn't available, e.g. iPhone (any browser:
  iOS only allows fullscreen for video), while iPads have it.
- The scoreboard shows one column per round (X15).
- The quick-sends editor tracks the row being edited by id, so a drag during an edit keeps the
  edit on its own row (X23). Rows have a labelled drag handle (X18).
- Icon-only controls have accessible names, e.g. the "Game settings" gear on Home (X11). Tests
  and e2e specs find controls by role and name, so keep those names stable.

## Server

- The server never crashes on a socket error: the WebSocket upgrade and accepted sockets both
  handle `error` (X14).
- Any absolute `STATIC_DIR` works, including paths with dotted folders (X8).
- `PORT` must be 1–65535 (X9). Boolean env flags accept true/1/yes/on and false/0/no/off in any
  case. Anything else stops the server at startup with a clear error (X10, X22).
- A JSON body that is a bare string, number or null gets a 400 `{message: "Invalid JSON body"}`
  without a `bad_request` code (X13, accepted). The client only checks the status.
- Sorting treats `a.b` as a literal key; nested-field sort isn't supported.
- **Schema changes are numbered migrations** (X82). Each is a self-contained file
  `server/src/migrations/NNNN_name.js` exporting `up(db)`, listed in `migrations/index.js`
  (`migrate.test.js` fails if a file isn't registered), and never imports `src/` or changes once
  shipped. At startup each pending one runs once, in order, in its own transaction with foreign keys
  off, must pass `foreign_key_check`, and is recorded in `schema_migrations`. A database at a higher
  version than the server knows stops startup with an error. Before migrating a database that holds
  data, the server copies it to `DATA_DIR/backups/pre-migration-<from>-to-<to>-<time>.db`, because
  desktop hosts never back up by hand (the only automatic backup; routine ones stay manual, X88).
- **The game entities have typed tables** (X83): `game_rooms`, `players`, `round_scores`,
  `chat_messages`. Records keep their old API shape: declared fields are columns and always present
  (`null` when unset), unknown fields go to an `extra` JSON column and come back merged in, and lists
  keep insertion order (`seq`). A value of the wrong type for a declared field is a 400; NaN/Infinity
  store as `null` as JSON did. Entities added through `ENTITIES` stay JSON rows in `records`.
- **The database enforces game integrity** (X84). A player, score or chat message needs an existing
  room (and a score an existing player); deleting a room or player deletes its children, and those
  cascaded deletes publish no events (only an admin can delete through the generic API with
  `LOCK_GAME_ENTITIES` on). One player per user per room, one non-closed room per code. Refused
  writes are 400 `invalid_record` (wrong type, missing or bad email, broken reference) or 409
  `conflict` (uniqueness). The room's player pointers (`host_player_id`, `current_turn_player_id`,
  `edit_mode_by`, `winner_player_id`) and chat's `sender_id`/`recipient_id` are not foreign keys:
  the game code maintains them, and chat outlives departed players.
- **Players and room hosts refer to users by id** (X85). `email`/`host_email` are read from the user
  row, so they are always canonical; writing an email nobody has signed in with creates a bare user
  (no name) that their first sign-in completes. User ids never appear in the API. `created_by` stays a
  plain email string.
- **Emails are canonical everywhere** (X86): trimmed and lower-cased by `server/src/email.js`, for
  sign-in, the store, realtime and `ADMIN_EMAILS`, and the `users` table has a CHECK for it. Migration
  0002 merged users that differed only by case or spaces: the oldest account wins and keeps its name
  (or takes the first one in its group when it has none); blank emails were dropped.
- **Legacy game records moved into the tables, losing nothing** (X87, migration 0004). Rows move in
  their old order. Rows the new rules can't hold go to the `legacy_orphans` table with a reason
  (`missing_room`, `missing_player`, `no_user`, `duplicate_member`: the later of two players one
  merged user had in a room, with its scores). Of open rooms sharing a code only the newest stays
  open, as the code lookup already picked it. A value of the wrong type stays in `extra` and shows as
  before until the field is next written. `records` keeps only the other entities' rows.
- **Backups are manual** (X88): `npm run backup` (`server/src/backup.js`) uses SQLite's backup API, so
  it is safe while the server runs, and writes `DATA_DIR/backups/flip7-<time>.db`.
- **Dev mode has no admins** (X89). The dev login takes any email without a password, and
  `npm run share` and the desktop launcher serve it on a public URL, so `ADMIN_EMAILS` is ignored
  while `AUTH_MODE=dev` and the server warns at startup if it was set. `DEV_ALLOW_ADMINS=true`
  turns it back on; `startTestServer` sets it so the server tests can sign in admins through the
  dev login. The e2e servers and the launcher don't set it.

## Desktop launcher

- **The desktop launcher hosts a game on a throwaway quick tunnel without passwords** (X61). It is an
  Electron app (`desktop/`) that runs the unchanged `server/src/index.js` in a utility process,
  configured only by env: `AUTH_MODE=dev`, `LOCK_GAME_ENTITIES=true`, `NODE_ENV=production`.
  - *Auth*: the `*.trycloudflare.com` URL is random and dies when hosting stops, so a password would only
    slow the table down. Anyone holding the URL can sign in as any email, the same trade as `npm run share`.
  - *Port*: 7007 when it is free, otherwise any free port. A port only counts as free when the wildcard
    address and the loopbacks can all be bound: on Windows another process (Docker's published port) can
    hold `127.0.0.1:7007` while a wildcard bind succeeds, and the health check and the tunnel dial loopback.
  - *Keep-awake*: `powerSaveBlocker('prevent-app-suspension')` only while `hosting` or `tunnel-restarting`,
    so a short tunnel drop doesn't let the laptop sleep. The display may sleep. The UI says to keep the lid
    open and the laptop plugged in, and warns while on battery.
  - *Tunnel retry*: a dropped tunnel is restarted up to 3 times with backoff (1 s, doubling, capped at
    10 s). A tunnel that stayed up for 60 s has recovered, so earlier failures stop counting. A new URL
    shows a "URL changed, rescan" banner over the new QR. After 3 failures the session is `failed` with
    Retry and Show logs; Dismiss stops it back to idle.
  - *Quit*: quitting while hosting (closing the window or Cmd+Q) shows one "Stop hosting and quit?"
    prompt. Stopping kills the tunnel first, so the public URL dies before the game does, then the server;
    a child still running after the grace period (5 s) is force-killed. The same cleanup runs on quit and
    on SIGINT/SIGTERM/SIGHUP, so no `cloudflared` or server process is left behind.
  - *Data*: the database lives in `<userData>/data`; the Gemini key and model and the server's session
    secret in `<userData>/settings.json`. Both secrets are encrypted with Electron `safeStorage`
    (`{ "encrypted": "<base64>" }`), and the session secret reaches the server as `SESSION_SECRET`, never
    the renderer. Start deletes the plain `<userData>/data/session-secret` older versions left. Without a
    real keyring (Linux with none, or its `basic_text` fallback) the secrets are stored in plain text and
    Settings says so; a plain secret is encrypted on the next read once encryption works. One that can't
    be decrypted (profile copied to another computer) counts as missing, with a console warning: the key
    must be entered again and a new session secret is made. An encrypted secret met while the keyring
    is unavailable (not unlocked yet) is kept on disk: the key is unused and the run signs with a
    temporary session secret. A cipher error falls back to plain text and never blocks Settings or Start.
    `settings.json` is written owner-only (0600). Settings are read on each Start. Reset data
    deletes `<userData>/data` only, and only while idle: a failed session is dismissed first.
  - *Window*: sandboxed with context isolation and a typed preload bridge (`window.launcher`). Every web
    permission is denied except `clipboard-sanitized-write`, which `navigator.clipboard.writeText` needs,
    so the Copy buttons work (X74); reading the clipboard stays denied. It opens
    only `https` links to the tunnel URL, `aistudio.google.com` and `github.com`. It has no menu bar on
    Windows and Linux; macOS keeps its default menu for Cmd+Q and copy/paste. The app and window icon is
    the site favicon, rendered to `desktop/build-resources/icon.png` by `npm --prefix desktop run icon`.
  - *Look* (X65): always the Classic theme, never the system light/dark one: the Classic
    `.game-screen-bg` diagonal behind light frosted panels (`desktop/src/renderer/launcher.css`), a
    small static brand logo (X72), no card fan or animation besides the status chips' spinner (X75). The QR code is white on clear
    inside the lobby's `.room-code-card`; the buttons use the lobby's colours (green Start hosting,
    red Stop, indigo Open game). The native title bar is hidden so the gradient runs to the top edge:
    the page draws a 36px draggable strip with the title in white with a soft dark glow, and the OS
    overlays its window buttons on it (white on clear on Windows and Linux, traffic lights on macOS).
    Only the area below the strip scrolls, so the scrollbar starts under the window buttons. The window's
    background matches the gradient, so it never flashes white while loading.
  - *Builds are unsigned* (ad-hoc on macOS), so first runs show SmartScreen or Gatekeeper warnings; the
    README says how to get past them. Updates are notify-only: the launcher checks GitHub Releases on start.
    Each release also carries a fixed-name copy of every installer, which the README's
    `releases/latest/download/...` links point at.
  - *Electron 41 is pinned with `better-sqlite3` 12.8.0*: 12.8.0 ships Electron prebuilds only up to
    Electron 41's ABI, and building from source needs Python and MSVC. `better-sqlite3` 13 (N-API, one
    binary for every Electron) would allow a supported Electron, but needs Node 22 for the server.
- **The launcher's Home shows live player and room counts while hosting** (X66).
  - *What counts*: players online are distinct emails with a live socket (pinged within
    `LIVE_WINDOW_MS`) explicitly subscribed to a room they're a player in, so admin "*" sockets, hidden
    tabs and people on the web app's home screen don't count, and two tabs or devices count once. A room
    is in play when it isn't `closed` and at least one of its players is online. Only room codes reach
    the launcher, never room ids or emails (`server/src/roomStats.js`).
  - *Transport*: the server pushes `{ type: 'room-stats', stats }` over Electron's utility-process
    parent port (`shared/launcherMessages.js`; desktop main keeps a checked copy, as app.asar has no
    `shared/`). The hub marks stats changed when a room's presence or a `GameRoom` changes; the reporter
    builds them at most once a second (trailing, 1000 ms) and sends only when they differ. It sends
    0 / 0 as soon as the server listens. Without a parent port (Docker, `npm run dev`) it does nothing.
  - *Main* caches the latest stats and forwards them (`launcher:room-stats`) only while the window is
    visible, sending the cache once on show or restore; `launcher:get-room-stats` answers from the cache.
    The session reports `null` when it stops or fails, so a new start never shows old numbers.
  - *Counts*: two tiles under the status chips, players (green, with a dot) and rooms (indigo), grey at
    zero, labels in capitals by CSS. Not a live region. Shown from `starting-tunnel` (0 / 0) through
    `tunnel-restarting`, dimmed while the tunnel restarts. While hosting with both at 0, "Nobody's joined
    yet. Share the QR code below." shows under them.
  - *Rooms panel*: below the game link while hosting or restarting and a room is in play. Busiest
    first; each row has the room code (a button that copies it, "Copied" for 2 s, its icon centred on
    the text), a QR button, the stage ("In the lobby", "Round N · to 200", "Game over · to 200"), up to
    8 online pips and `online/players`. Five rows, then "Show all N rooms"; the expanded list scrolls
    past 8 rows, gets a code filter past 10 rooms, and collapsing clears the filter. Rows hold their
    order while the pointer is over the list.
  - *QR dialog*: the room code large on the lobby's card and a QR code for
    `<game link>/room/CODE`, with Copy code and Copy join link. The QR button is disabled
    without a game link. If the room drops out of play while the dialog is open, it stays and says the
    code still works. Closing returns focus to the QR button.
  - *Status chips spin while a part is on its way* (X75): a chip whose tone is busy or warn
    (server Starting or Stopping; tunnel Waiting, Connecting, Stopping or Reconnecting) shows a
    spinning ring in its tone's colour in place of the dot, slowed under reduced motion. The chips
    stay hidden from screen readers, which hear the status sentence as before.
  - *Power hint*: while kept awake (`hosting`, `tunnel-restarting`) it says the launcher keeps the
    computer awake, and that closing the lid still sleeps it.
