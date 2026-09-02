/**
 * What the renderer draws: the world as the chain holds it, plus what the
 * player has planned and not yet committed.
 *
 * The planned layer is the whole reason a view state exists separately from the
 * onchain state. A commit-reveal game has a phase where the player's decisions
 * are real to them and invisible to everyone else, and the client is the only
 * thing that can show them. Planned movement is kept as its own field rather
 * than written over `position`, so the player can always tell where their
 * avatar IS from where they have said it should go.
 */
import type {ViewMerge} from '$lib/view';
import {ActionType, bigIntIDToXY, type Position} from 'reveal-or-die-contracts';
import type {Action} from './commit-reveal';
import type {Avatar, ResolvedTurn, WorldState} from './state';

/** A planned action for this epoch, before it is committed. */
export type PlannedAction = {
	type: 'enter' | 'move' | 'exit';
	to: Position;
};

/**
 * The contract's actions in the shape the view and the renderer read.
 *
 * Here rather than beside the planning code because BOTH sides of the board
 * need it now: what the player has planned, and what the chain says it carried
 * out (`CommitmentRevealed`). One mapping, so a plan and its outcome cannot be
 * drawn from two different vocabularies.
 */
export function toPlannedActions(actions: readonly Action[]): PlannedAction[] {
	return actions.map((a) => ({
		type:
			a.actionType === ActionType.Enter
				? ('enter' as const)
				: a.actionType === ActionType.Exit
					? ('exit' as const)
					: ('move' as const),
		to: bigIntIDToXY(a.data),
	}));
}

/**
 * What the chain says an avatar's last turn actually was.
 *
 * THE ACCEPTED PREFIX, not what the player revealed: `_reveal` emits
 * `actions[0:numActionsResolved]`, and a refused action sets `stopProcessing`
 * without incrementing that counter, so a turn whose third step walked into a
 * wall arrives here as two moves. That is what makes it worth drawing - it is
 * what HAPPENED, for every avatar on the board rather than only the player's.
 */
export type ResolvedTurnView = {
	epoch: number;
	actions: readonly PlannedAction[];
};

// `lastTurn` is REPLACED rather than inherited: the state layer holds the
// contract's own actions, and the view holds them mapped into the renderer's
// vocabulary, under the same name because they are the same fact.
export type AvatarView = Omit<Avatar, 'lastTurn'> & {
	/**
	 * WHOSE avatar this is, from the client's point of view.
	 *
	 * On the entity rather than held beside the view on purpose. The stateful
	 * renderer only calls `update` for entities its diff says changed, so
	 * anything that decides how an avatar is DRAWN has to be part of what the
	 * diff compares. Kept outside, "this one is mine" is applied once and then
	 * never re-applied, and the player's own avatar can end up drawn as somebody
	 * else's for the rest of the session.
	 */
	isPlayer: boolean;
	/** Where the player has said this avatar should go this epoch, in order. */
	planned: readonly PlannedAction[];
	/**
	 * Where it will stand if every planned action resolves. Equal to `position`
	 * when nothing is planned. The contract may still refuse a move (a wall, or
	 * an out-of-range step), so this is intent and not a prediction.
	 */
	plannedPosition: Position;
	/** Planned to enter this epoch, so it is not on chain yet at all. */
	entering: boolean;
	/**
	 * The turn the chain last resolved for this avatar, when it is recent enough
	 * to have been fetched.
	 *
	 * Undefined for an avatar whose reveal is outside the fetched block range, or
	 * that has not acted since. The renderer treats it as "nothing to replay" and
	 * draws the avatar where it stands.
	 */
	lastTurn?: ResolvedTurnView;
};

export type WorldView = {
	avatars: Map<bigint, AvatarView>;
	/** The avatar this client is playing, if one has been chosen. */
	activeAvatarID?: bigint;
	epoch: number;
};

export type LocalPlan = {
	/**
	 * ONE avatar per client. See docs/plans/web-port.md: authority is
	 * account-wide, so nothing on chain stops a second client moving the same
	 * avatar, and keeping the choice here is what keeps two clients apart.
	 */
	activeAvatarID?: bigint;
	/** The player's own address, so their avatars can be told apart. */
	player?: `0x${string}`;
	planned: readonly PlannedAction[];
};

/**
 * Combine confirmed world state with local intent.
 *
 * Avatars are copied rather than annotated in place: the onchain store stays
 * the single source of truth, and a re-derive must not leave a `planned` field
 * behind on it that a later merge would read as confirmed.
 */
/** The chain's own account of a turn, in the renderer's vocabulary. */
function resolvedTurnView(
	turn: ResolvedTurn | undefined,
): ResolvedTurnView | undefined {
	if (!turn) return undefined;
	return {epoch: turn.epoch, actions: toPlannedActions(turn.actions)};
}

export const mergeWorldView: ViewMerge<WorldState, LocalPlan, WorldView> = ({
	onchain,
	local,
	epoch,
}) => {
	const avatars = new Map<bigint, AvatarView>();

	for (const [id, avatar] of onchain.avatars) {
		avatars.set(id, {
			...avatar,
			isPlayer: id === local.activeAvatarID,
			planned: [],
			plannedPosition: avatar.position,
			entering: false,
			lastTurn: resolvedTurnView(avatar.lastTurn),
		});
	}

	const activeID = local.activeAvatarID;
	if (activeID === undefined || local.planned.length === 0) {
		return {avatars, activeAvatarID: activeID, epoch};
	}

	const last = local.planned[local.planned.length - 1];
	const existing = avatars.get(activeID);

	if (existing) {
		avatars.set(activeID, {
			...existing,
			planned: local.planned,
			plannedPosition: last.to,
		});
		return {avatars, activeAvatarID: activeID, epoch};
	}

	// NOTHING ON CHAIN BEHIND THIS AVATAR, so the entity is invented here.
	// Drawing it is the point, and there are two ways to arrive at it.
	//
	// Planned to ENTER, which is the ordinary one: a player who picks a spawn and
	// sees nothing appear until the reveal lands an epoch later has no way to
	// tell the click registered.
	//
	// Or planned to LEAVE and already gone from the read: `_exit` removes the
	// avatar from its zone, so the board loses it the moment the reveal lands,
	// while the round it belongs to has seconds left to run. The board's hold
	// cannot keep it - an avatar missing from the read is indistinguishable from
	// one the player panned away from, which is why `world/hold.ts` says it
	// cannot do exits - but the plan naming an Exit says so for this ONE avatar,
	// the player's, and inventing it keeps it on the board until the round ends
	// with everybody else's outcome.
	//
	// `entering` is therefore asked of the plan rather than assumed: it drives the
	// spawn animation and hides the blockie, and a leaving avatar must not be
	// drawn appearing.
	avatars.set(activeID, {
		avatarID: activeID,
		owner: local.player ?? '0x0000000000000000000000000000000000000000',
		inGame: false,
		position: last.to,
		lastEpoch: epoch,
		life: 1,
		isPlayer: true,
		planned: local.planned,
		plannedPosition: last.to,
		entering: local.planned.some((action) => action.type === 'enter'),
	});

	return {avatars, activeAvatarID: activeID, epoch};
};
