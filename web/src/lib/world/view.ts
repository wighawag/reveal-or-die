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
import type {Position} from 'reveal-or-die-contracts';
import type {Avatar, WorldState} from './state';

/** A planned action for this epoch, before it is committed. */
export type PlannedAction = {
	type: 'enter' | 'move' | 'exit';
	to: Position;
};

export type AvatarView = Avatar & {
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

	// Planned to ENTER: there is nothing on chain behind this avatar yet, so the
	// entity is invented here. Drawing it is the point. A player who picks a
	// spawn and sees nothing appear until the reveal lands an epoch later has no
	// way to tell the click registered.
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
		entering: true,
	});

	return {avatars, activeAvatarID: activeID, epoch};
};
