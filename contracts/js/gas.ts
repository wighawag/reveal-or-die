/**
 * Gas to allow for one turn: a commit and the reveal that must follow it.
 *
 * Deliberately generous, and the reveal far more so than the commit. A commit
 * writes one hash; a reveal walks up to `numMoves` actions, each of which can
 * touch a zone index. Running out of gas mid-cycle is not a slow turn, it is a
 * missed reveal, which loses the turn AND blocks the next cycle until it is
 * acknowledged. Over-reserving costs a slightly larger first payment.
 *
 * ONE FIGURE, in the contracts package, because two consumers price with it and
 * must agree: the local chain's `creditsGasMultiplier` in `rocketh/config.ts`
 * (what a credit is, and so what one top-up sends) and the purchase stipend in
 * web/src/lib/world/config.ts. It used to live only in the latter, and the
 * chain's multiplier was missing, so the play key was topped up with the
 * framework's flat 0.01 fallback instead of a number of turns. Here rather than
 * in `rocketh/config.ts` because that file imports the deploy toolchain, which
 * the game's bundle has no business carrying.
 */
export const COMMIT_GAS = 100_000n;
export const REVEAL_GAS = 5_000_000n;
