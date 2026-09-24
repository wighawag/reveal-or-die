import {get, writable, type Readable} from 'svelte/store';
import {
	SEATS_BY_DEFAULT,
	clampSeats,
	tableOf,
	type Table,
} from '$lib/offline-seats';
import {CHAIN_ID_STORAGE_KEY, startOfflineWorld} from '$lib/offline';

/**
 * THE LOBBY: how many seats are at the table, decided before the world boots.
 *
 * WHY IT HAS TO BE BEFORE. Membership is baked into a world by PROVISIONING -
 * what enrols a player is holding this game's stake, and that is handed out
 * once, while the world is being built. So the seat count is not a setting a
 * live world could take: changing it would mean staking for somebody or
 * withdrawing somebody mid-cycle, which under the manual policy means changing
 * the denominator unanimity is measured against while a cycle is open. The
 * lobby therefore runs first, and changing the count starts a NEW world - a
 * path that already exists, because `openWorld` mints a fresh chain id and
 * everything a player keeps is keyed by it.
 *
 * WHICH IS WHY A WORLD THAT EXISTS IS NOT SILENTLY REUSED AT A NEW COUNT. A
 * booted world keeps the membership it was provisioned with, and this says so:
 * a browser that already has a world goes straight back into it at the count
 * it was built with, and the only way to a different count is to leave the
 * table, which is an explicit press that throws that world away.
 *
 * AND IT IS NOT A GATE ON THE WAY BACK IN. The choice is made once, on a first
 * visit; a reload restores the world and boots straight into it, because
 * asking a returning player the question they already answered is exactly the
 * kind of dialog-with-one-answer this slice removed from the board.
 *
 * WHAT IS DELIBERATELY NOT HERE IS HOTSEAT. A seat whose occupant is a second
 * human is several ACCOUNTS against one world, in a context built for exactly
 * one, and it reopens the account-picker question `lib/embedded/wallet.ts`
 * closed on purpose. What this owes hotseat is the seat model
 * (`$lib/offline-seats`) and nothing else - and the test of that model is that
 * adding an occupant would not change a line of this file.
 */

/**
 * How many seats the world in this browser was built with.
 *
 * ITS OWN RECORD rather than something read back off the chain, and the reason
 * is ordering: the count is needed to BUILD the world (provisioning stakes for
 * each seat), so a world that had to be booted before it could be counted
 * could not be booted at all. The chain is still the authority on who is
 * actually enrolled - `getAttendance` is what the world test asserts against -
 * this is only what the next boot should ask for.
 *
 * Note it is NOT keyed by chain id, unlike everything else a world persists,
 * and that is deliberate: `openWorld` may mint a fresh id underneath (a
 * restore that turns out to be incoherent starts a new world), and the seats
 * the player asked for survive that.
 */
const SEATS_STORAGE_KEY = 'offline-world:seats';

export type LobbyState = {
	/**
	 * `Opening` is BEFORE THE BROWSER HAS LOOKED, and it is load-bearing rather
	 * than a tidy initial value. This app prerenders (ADR-0002), and whether
	 * there is already a world here is a question only `localStorage` can
	 * answer - so the server cannot know which of the other two states is
	 * right. A chooser rendered in prerendered HTML would be on screen before
	 * any handler was attached, and a press against it would be swallowed and
	 * then overwritten the moment `enterOfflineLobby` ran. That is measured
	 * rather than feared: a run that chose eight seats got three, silently,
	 * because the click landed before hydration.
	 *
	 * `Choosing` is the only state with a decision left in it. `Sat` means the
	 * table is settled and the world is building or built; the route shows the
	 * world from then on.
	 */
	step: 'Opening' | 'Choosing' | 'Sat';
	/** How many seats, which is the one number the player picks. */
	seats: number;
	/** Who is in each of them. See `$lib/offline-seats`. */
	table: Table;
};

/**
 * WHAT THE WORLD DOES FOR THE PLAYER THAT AN ONLINE GAME WOULD HAVE ASKED FOR.
 *
 * Said out loud rather than done invisibly, and this is the whole reason the
 * sentence exists. Offline, registering this browser's key is a question with
 * one answer, so the world answers it (`$lib/offline-authorise`). Online it is
 * a real transaction the player signs and pays for, and it is the step that
 * makes every later move promptless. A player who met it for the first time on
 * a real chain, having never been told it exists, would meet it as an
 * unexplained demand at the worst possible moment - in front of a board they
 * had already decided to play.
 *
 * WORDED SO THAT IT IS TRUE IN BOTH PLACES IT IS SHOWN, which took a second
 * draft. The first said the world HAD registered a key, which is a fact in the
 * strip above a running world and a falsehood in the lobby, where no world
 * exists yet - and the lobby is where a player most wants to know what sitting
 * down is about to do. One sentence describing what an offline world does is
 * true in both, and is one string rather than two to keep in step.
 */
export const THE_KEY_THIS_BROWSER_PLAYS_WITH =
	'Playing needs a key this browser holds, registered to your account and ' +
	'funded with gas, so your moves cost no prompts. An offline world does ' +
	'that for you. Online it is one transaction you sign and pay for, once.';

const lobby = writable<LobbyState>(seated('Opening', SEATS_BY_DEFAULT));

function seated(step: LobbyState['step'], seats: number): LobbyState {
	const count = clampSeats(seats);
	return {step, seats: count, table: tableOf(count)};
}

/** What the page renders. */
export const offlineLobby: Readable<LobbyState> = {subscribe: lobby.subscribe};

/**
 * Whether this browser already holds a world, and how many seats it has.
 *
 * BOTH OR NEITHER. A seat record with no world behind it is not a world to
 * carry on with, so it is ignored rather than acted on: the alternative boots
 * a brand new world at a remembered count without ever asking, which is the
 * silent reuse this file exists to avoid.
 */
function worldAlreadyHere(): number | undefined {
	if (typeof localStorage === 'undefined') return undefined;
	if (localStorage.getItem(CHAIN_ID_STORAGE_KEY) === null) return undefined;
	const seats = localStorage.getItem(SEATS_STORAGE_KEY);
	if (seats === null) return undefined;
	return clampSeats(seats);
}

/**
 * Open the lobby, which is the only thing the route does on mount.
 *
 * Boots straight into the world already here, or offers the choice.
 *
 * ONCE, AND ONLY OUT OF `Opening`. The lobby is app-scoped, like the world it
 * starts, so a player who navigates away and comes back mounts the route again
 * - and a second pass that reset the state would throw away a choice they were
 * in the middle of making, or re-offer one they had already made.
 */
export function enterOfflineLobby(): void {
	if (get(lobby).step !== 'Opening') return;
	const already = worldAlreadyHere();
	if (already === undefined) {
		lobby.set(seated('Choosing', SEATS_BY_DEFAULT));
		return;
	}
	sitDown(already);
}

/** Pick a different number of seats, before sitting down at them. */
export function chooseSeats(seats: number): void {
	lobby.set(seated('Choosing', seats));
}

/**
 * Take the table, and build the world around it.
 *
 * The count is recorded BEFORE the boot rather than after it, so a boot
 * interrupted half way (a closed tab, a failed deploy) is still remembered as
 * the table that world was being built for. The alternative loses the answer
 * precisely when the world is in the state hardest to reason about.
 */
export function sitDown(seats: number = SEATS_BY_DEFAULT): void {
	const state = seated('Sat', seats);
	if (typeof localStorage !== 'undefined') {
		localStorage.setItem(SEATS_STORAGE_KEY, String(state.seats));
	}
	lobby.set(state);
	void startOfflineWorld({table: state.table});
}

/**
 * Leave this table, so that the next visit chooses a new one.
 *
 * FORGETTING THE CHAIN ID IS WHAT MAKES IT A NEW WORLD: everything the player
 * kept is keyed by that id, so the next boot mints one and builds a world
 * beside the old one rather than into it. The old chain and its deployment
 * records stay in IndexedDB, orphaned, which is exactly what an incoherent
 * restore already does to them and is the honest outcome: they describe a
 * world nothing points at any more.
 *
 * AND IT RELOADS THE PAGE, which looks blunt and is the truthful shape. A
 * world is APP-SCOPED STATE built once (see `startOfflineWorld`): a chain in a
 * worker, a wallet announced on `window`, a context constructed around a
 * deployment address, and players spending its gas. Tearing all of that down
 * inside a live page to build a second one would be a whole second lifecycle,
 * existing only for a button nobody presses twice. A new world is a new page.
 */
export function leaveTheTable(): void {
	if (typeof localStorage !== 'undefined') {
		localStorage.removeItem(CHAIN_ID_STORAGE_KEY);
		localStorage.removeItem(SEATS_STORAGE_KEY);
	}
	if (typeof location !== 'undefined') location.reload();
}
