# CABO: Rules Spec

This file is the source of truth for the game engine. Items marked **[OPEN]** are not decided yet. Items marked **[ASSUMED]** are defaults until someone objects.

## Deck and values

- One standard 52-card deck, no jokers.
- Values: A = 1, 2–10 = face value, J = 11, Q = 12, black K = 13, red K = −1.
- Ranks are compared by rank for throws, so a red K matches a black K.

## Host settings

| Setting | Default | Allowed |
|---|---|---|
| Players | — | 2–6 |
| Earliest CABO call | after round 1 | round ≥ 1 (a "round" = every player has had one turn) |
| Turn timer | 30 s | configurable |
| Bottom-row peek | 5 s | fixed |

## Setup

1. Each player is dealt 4 cards face down in a 2×2 grid. Slots 0 and 1 are the top row; slots 2 and 3 are the bottom row.
2. **Shuffle phase:** each player may shuffle their own 4 face-down cards.
3. **Peek phase:** every player sees their own bottom row (slots 2 and 3) for 5 s at the same time.
4. One card from the deck is turned face up to start the discard pile.
5. The starting player is chosen at random, and play goes clockwise.

## A turn

1. **(Optional) Call CABO**, before drawing, if the round setting allows it. See *Ending*.
2. **Draw** the top card of the deck. Only you see it. Cards on the discard pile can never be taken.
3. Then do one of these:
   - **Replace:** put the drawn card face down into one of your slots (you know what it is). The old card goes face up onto the discard pile.
   - **Discard:** put the drawn card face up onto the discard pile. If it has a power, you may use it. Powers are always optional.

### Powers

A power works only when the card was drawn and then discarded. It does not work when a card is discarded by replacing.

| Card | Power |
|---|---|
| 7, 8 | Look at one of your own cards. |
| 9, 10 | Look at one opponent's card. |
| J, Q | **Blind** swap: exchange one of your cards with one opponent's card. Nobody looks at either card. |
| Black K | Look at one of your cards and one opponent's card, then you may swap them. |
| A–6, red K | No power. |

You cannot swap with a CABO caller's locked cards, but you may look at them.

## Throwing (snapping)

Throwing is the core mechanic. **Any player may throw at any time**, including during someone else's turn and while a power is being used. Throws can never be blocked.

**Exception:** during your own turn, you cannot throw from the moment you draw until your turn ends, including while you use a power.

- **Throw window:** every time a card lands on the discard pile from a turn action (replace or discard), a new window opens for that card's rank R. The **first** correct throw in that window claims it.
- **The claimer may keep throwing:** after claiming a window, that player may throw **more** cards of rank R, their own or other players', for as long as the window is open. Each one follows the normal rules: another player's card means giving one back, and a wrong card is punished as usual.
- **Own card, correct (rank R, first in the window, or the window is already yours):** the card goes onto the discard pile. Its slot stays empty.
- **Own card, wrong rank:** the card is shown to all players for about 3 s with a red shake, then goes back face down into the same slot. No penalty card, but you **lose a turn**. If it is your turn and you have not drawn yet, the current turn ends immediately. Otherwise your next turn is skipped. **[ASSUMED]** Skips don't stack: several wrong throws before your turn still cost only one turn.
- **Own card, late** (correct rank but the window was already claimed by another player A): the card is revealed to all, shaken red, and returned face down. There is no penalty card and no lost turn. Player A then holds the **throw right** on that revealed card (see below).
- **Another player's card, correct (rank R, first in the window, or the window is already yours):** the card goes onto the discard pile. The thrower then chooses one of their own cards and places it face down into the empty slot. A correct throw is never punished.
- **Another player's card, wrong** (wrong rank, window already claimed, or the card is a locked caller's card): the card is shown to all for about 3 s, then returned face down to its owner's slot. The thrower takes **1 penalty card**.
- **Throw right:** after a late throw, only the player who claimed the window may throw the late thrower's revealed card. It counts as a correct throw of another player's card, so the thrower gives one of their own cards in return. Anyone else who tries is treated as a wrong throw of another player's card and takes a penalty card. **[ASSUMED]** The throw right ends when the next card lands on the discard pile from a turn action.
- **[ASSUMED]** The starting discard card opens a throw window once the peek phase ends.
- **[ASSUMED]** A player with no cards left who correctly throws another player's card gives nothing back.

## Penalties

- A penalty card is the top card of the draw pile, added face down to your grid. You do not see it.
- It fills your first empty slot, or a new slot if you have none.
- Empty slots stay where they are. Cards never shift position, because shifting would break players' memory.

## Draw pile runs out

Shuffle the discard pile, except its top card, to form a new draw pile.

## Timers

- Turn timer, 30 s by default. If it runs out before drawing, the turn auto-draws and auto-discards with no power. If it runs out after drawing, the drawn card is auto-discarded with no power.
- Reveal animations (wrong or late throws) last about 3 s.
- After correctly throwing another player's card, you must choose which card to give before you can throw or play your turn. If you take longer than 8 s, your first card is given automatically.
- Shuffle phase lasts up to 10 s, and ends sooner once every player taps Ready.

## Ending

- CABO may only be called on your own turn, before drawing, and only after the host's minimum round has passed.
- The **first caller's cards are locked**. Other players cannot swap them or throw them. The caller can still change them.
- The caller then plays their turn normally. Every other player gets one more turn. The game ends after the turn of the player immediately before the caller.
- During that final round, other players may **counter-CABO** on their own turn. It only matters for ties (see *Winning*). Counter-callers' cards are not locked.
- **[ASSUMED]** Throws are still allowed for a 3 s grace period after the last turn, then all cards are revealed.

## Winning

- Each player's score is the sum of their card values. The **lowest sum wins**.
- A player who did not call and has a strictly lower sum than every caller always wins.
- **Ties:** among the players tied for the lowest sum, the one who called CABO **last** wins. Any caller beats a player who didn't call in a tie. This overrides the original rulebook's tie rule.
- If none of the tied players called, they **share the win**.
