# Keyboard and gamepad, as intent recognisers

Two thin modules with the same shape as `$lib/game/render/gestures.ts`: a pure recogniser that turns raw input into a `ControlIntent`, and a small DOM half that feeds it. Nothing here knows what an avatar, a round or an epoch is.

| file | pure half | DOM half |
| --- | --- | --- |
| `intents.ts` | the vocabulary: `direction`, `confirm`, `secondary`, `cancel` | none |
| `keys.ts` | `recognizeKey(sample)` | `attachKeys(target, onIntent)` |
| `gamepad.ts` | `createGamepadRecognizer().poll(pads)` | `attachGamepad(onIntent)` |

## Why this is not in `$lib/world/`

`docs/audits/03-renderer.md` 3.4 applies the sibling test and it passes: directional / confirm / cancel input is generic to any board game on this template, while the mapping from an intent to a game action is not. So this directory is a **backport candidate for `template-commit-reveal`**, where it would sit beside `gestures.ts` as `game/render/keys.ts` and `game/render/gamepad.ts`, and `$lib/world/controls.ts` is the half that stays here.

It is NOT in `$lib/game/` today, because `$lib/game/` is byte-identical to the template and keeping it that way is what makes merging free (see the repo handoff). Something that belongs upstream goes upstream first and arrives here by merge; it does not get written into the merged tree by hand.

## Why the recogniser is pure

The same reason `gestures.ts` gives: the interesting cases are the ones a human cannot reliably perform. A held key repeating thirty times a second, a modifier chord, a controller that reports six buttons instead of seventeen, a stick rolled from left to up without passing the centre. All of those are one function call in the node test project and a fight in a browser.

## What the DOM halves decide, and what they refuse to

`attachKeys` calls `preventDefault` **only for keys that produced an intent**, so every key the game does not use keeps doing what the browser and the page would have done. Where a keystroke is aimed is asked in two kinds rather than one: a text field consumes every key including the arrows, while a button consumes only Enter and Space. Collapsing those two is a bug in whichever direction you collapse them, and the second one bites immediately: pressing the on-screen d-pad with a mouse leaves that button focused, so a blanket rule would stop the keyboard working with nothing on screen to explain why.

`attachGamepad` polls only while a pad is connected, and starts on `gamepadconnected`. A player with no gamepad pays nothing.

Neither one decides a lifetime. Whether input is live is the caller's decision and a real one: here it is the play route's, so input outlives a canvas unmount (the dynamic import, a canvas that failed to load) and does not outlive the board. See `routes/play/+page.svelte`.
