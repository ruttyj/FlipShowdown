# Glossary

The domain terms the code's modules are named after.

- **Hand**: the cards one player holds in a round, and the score they make.
- **Hand entry**: building a hand before it is sent, whichever screen does it (manual, scanner or
  editor). See `src/lib/handEntry.js`.
- **Entry**: one player entering cards for one round, which the room sees as "entering cards". See
  `startEntry` in `src/api/roomChannel.js`.
- **Score lifecycle**: a player's score for a round from opening entry, through draft and submit, to
  take-back and late-score recovery. See `src/lib/scoreLifecycle.js`.
- **Ballot**: one player's hands on one hold-to-vote topic. See `openBallot` in `src/api/roomChannel.js`.
- **Room channel**: the client's realtime view of a room, in domain terms, including recovery after a
  reconnect. See `src/api/roomChannel.js`.
- **Rule kernel**: the facts both client and server rely on, such as what a mode allows and whether a hand
  is a Flip 7. See `shared/rules.js`.
- **Partial send**: a chat send that reached some recipients but not all (X60).
