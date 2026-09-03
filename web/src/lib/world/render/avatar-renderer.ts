/**
 * The world, drawn as a pixi scene graph.
 *
 * STATEFUL rendering: one display object per avatar, created when it first
 * appears, updated when it changes, destroyed when it goes. The create /
 * update / destroy bookkeeping is the framework's
 * (`$lib/game/render/stateful`); what is left here is only the part about
 * avatars.
 *
 * Nothing here reads the chain or knows the rules. It mirrors what the view
 * state says, which is what makes the renderer a seam the game fills rather
 * than a place logic accumulates.
 */
import type {Container} from 'pixi.js';
import type {GameRenderer} from '$lib/game/core/seams';
import {createStatefulRenderer} from '$lib/game/render/stateful';
import type {Changed} from '$lib/game/render/reconcile';
import type {ViewStateStore} from '$lib/view';
import type {AvatarView, WorldView} from '../view';
import {AvatarObject} from './AvatarObject';
import {loadWorldAssets} from './assets';
import {createTerrainLayer, type TerrainLayer} from './terrain';

/**
 * Whether an avatar needs redrawing.
 *
 * Supplied rather than left at the default (reference inequality) because
 * `mergeWorldView` rebuilds every `AvatarView` on every derive, so by reference
 * every avatar changes each time the poller returns, whether or not anything
 * moved. On a busy board that is the difference between redrawing nothing and
 * redrawing everything, several times a minute.
 *
 * `isPlayer` is compared because it decides how the avatar is drawn. It used to
 * be pushed in through a separate call on every emission, which meant it was
 * NOT part of what the diff compared, and an avatar that became the player's
 * without otherwise changing would keep drawing as somebody else's.
 *
 * `owner` is compared even though an avatar's owner rarely changes, because it
 * chooses the blockie. `position` is compared rather than assumed stable: this
 * is the one entity field that changes constantly.
 */
export const avatarChanged: Changed<AvatarView> = (previous, next) =>
	previous.position.x !== next.position.x ||
	previous.position.y !== next.position.y ||
	previous.life !== next.life ||
	previous.owner !== next.owner ||
	previous.isPlayer !== next.isPlayer ||
	previous.entering !== next.entering ||
	previous.plannedPosition.x !== next.plannedPosition.x ||
	previous.plannedPosition.y !== next.plannedPosition.y ||
	previous.planned.length !== next.planned.length ||
	// The epoch of the last RESOLVED turn, which is what starts a replay. It is
	// compared because a turn can arrive without moving the avatar at all - a
	// step the contract refused, an exit - and `update` is the only place the
	// object hears about it.
	previous.lastTurn?.epoch !== next.lastTurn?.epoch;

export function createAvatarRenderer(params: {
	viewState: ViewStateStore<WorldView>;
	cellSize: number;
}): GameRenderer<Container> {
	const {viewState, cellSize} = params;

	/**
	 * The map, which is not view state and never diffs.
	 *
	 * Built here and driven from `tick` rather than from the subscription,
	 * because what changes is the CAMERA and not the chain. See ./terrain.ts.
	 */
	let terrain: TerrainLayer | undefined;

	/**
	 * The live avatar objects, so each can be advanced every frame.
	 *
	 * A SECOND COLLECTION, kept in step by the two handlers below, and it should
	 * not have to exist: `Reconciler` already holds the key-to-object map and
	 * exposes only `get` and `size`, so there is no way to enumerate what is on
	 * screen. `docs/audits/03-renderer.md` 3.8 names that as the gap and the
	 * backport that closes it (`values()` on the reconciler, which the template's
	 * own README implies exists when it sells the stateful renderer for
	 * "per-object animation"). When that lands upstream, this set goes away.
	 */
	const live = new Set<AvatarObject>();

	return createStatefulRenderer<
		Container,
		WorldView,
		bigint,
		AvatarView,
		AvatarObject
	>({
		viewState,
		entities: (view) => view.avatars,
		changed: avatarChanged,

		// Art is not needed to draw an avatar (the blockie is a data URI), so the
		// bundle is started here and never awaited. See ./assets.ts for why this
		// is not a gate in the host.
		onStarted(surface) {
			void loadWorldAssets();
			terrain = createTerrainLayer(cellSize);
			// FIRST CHILD and a very negative zIndex: the avatar objects sort
			// themselves back-to-front with `zIndex = 10 * y`, which switches this
			// container to sorted rendering, and anything left at 0 would sort into
			// the middle of them rather than underneath.
			surface.addChild(terrain.view);
		},

		onStopped() {
			terrain?.destroy();
			terrain = undefined;
			// The reconciler destroys the objects themselves; this only lets go of
			// the references, so a remount does not tick objects that are gone.
			live.clear();
		},

		// Terrain follows the camera, so it is redrawn per frame rather than per
		// state change. `update` returns immediately unless the visible box has
		// actually moved by a whole cell.
		tick({frame}) {
			terrain?.update(frame);
			// The frame loop is the only clock the objects get: an avatar replaying a
			// turn advances here rather than holding a timer of its own, so a
			// backgrounded tab, a paused loop or an unmounted canvas stops the
			// animation with everything else.
			for (const object of live) object.tick(frame.deltaMs);
		},

		add({entity, surface}) {
			const object = new AvatarObject(cellSize, entity);
			surface.addChild(object);
			// The planned path is positioned in WORLD space, so it is a sibling of
			// the avatar rather than a child; a child would move with it.
			surface.addChild(object.pathLayer);
			live.add(object);
			return object;
		},

		update({object, entity}) {
			object.update(entity);
		},

		remove({object, surface}) {
			live.delete(object);
			surface.removeChild(object);
			object.onRemoved();
		},
	});
}
