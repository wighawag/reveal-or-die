/**
 * One avatar, as a pixi display object.
 *
 * Owns everything it draws, INCLUDING its own planned path. The version this
 * replaces drew the path into a container shared by every avatar, which only
 * worked because exactly one of them was ever player-controlled: whoever was
 * updated last cleared it and redrew, so two controlled avatars would have
 * fought over it and a removal could wipe a path that belonged to somebody
 * else. A child of the avatar cannot have that problem, and it is also removed
 * for free when the avatar is.
 */
import {AnimatedSprite, Container, Graphics, Texture} from 'pixi.js';
import {LoadingSprite} from './LoadingSprite';
import {Blockie} from '$lib/core/utils/ethereum/blockie';
import type {Position} from 'reveal-or-die-contracts';
import type {AvatarView} from '../view';
import {sprites, spritesReady} from './assets';
import {createWalk, type Walk} from './walk';

/**
 * How long one cell of a replayed turn takes, and the whole turn at most.
 *
 * The reveal window is short and the next epoch does not wait, so an animation
 * that outlasts it would draw a board one turn behind the chain.
 */
const SECONDS_PER_STEP = 0.18;
const MAX_WALK_SECONDS = 1.2;

/** Frames of the spawn animation, named entry_001.png .. entry_021.png. */
function entryTextures(): Texture[] | undefined {
	const sheet = sprites();
	if (!sheet) return undefined;
	const textures: Texture[] = [];
	for (let i = 1; i <= 21; i++) {
		const frame = sheet.textures[`entry_${String(i).padStart(3, '0')}.png`];
		if (!frame) return undefined;
		textures.push(frame);
	}
	return textures;
}

export class AvatarObject extends Container {
	private readonly blockie: LoadingSprite;
	private readonly path = new Container();
	private readonly highlight: Graphics;
	private readonly deadCross: Graphics;
	private entering: AnimatedSprite | undefined;
	/**
	 * The turn being replayed, and which epoch's turn it is.
	 *
	 * The epoch is what makes it play ONCE: the state store re-reads every few
	 * seconds and hands the same resolved turn back each time until the next
	 * epoch resolves.
	 */
	private walk: Walk | undefined;
	private walkedEpoch: number | undefined;
	/**
	 * Where the chain says this avatar stands, kept so a finished walk can land
	 * on it exactly.
	 *
	 * The last cell of an accepted turn IS the avatar's new position, so the two
	 * agree by construction - but `update` is only called when the diff says
	 * something changed, so a walk that ended anywhere else would stay there
	 * indefinitely. One assignment is cheaper than that class of drift.
	 */
	private destination: Position;

	constructor(
		private readonly cellSize: number,
		entity: AvatarView,
	) {
		super();

		const half = cellSize / 2;

		this.blockie = new LoadingSprite(Blockie.getURI(entity.owner));
		this.blockie.zIndex = 1;
		this.blockie.x = -half + 2;
		this.blockie.y = -half + 2;
		this.blockie.scale = (cellSize - 4) / 8;
		this.addChild(this.blockie);

		this.highlight = new Graphics()
			.rect(-half, -half, cellSize, cellSize)
			.stroke({width: 1, color: 0x00ff00});
		this.highlight.visible = false;
		this.addChild(this.highlight);

		this.deadCross = new Graphics()
			.moveTo(-half, -half)
			.lineTo(half, half)
			.moveTo(-half, half)
			.lineTo(half, -half)
			.stroke({width: 1, color: 0xff0000});
		this.deadCross.zIndex = 2;
		this.deadCross.visible = false;
		this.addChild(this.deadCross);

		// The path is drawn in WORLD space, so it hangs off the avatar's parent
		// rather than the avatar: a child would be positioned relative to the
		// avatar and would move with it. Added by the renderer, not here, for the
		// same reason.
		this.path.zIndex = 0;

		// AN AVATAR THAT IS ALREADY ON THE BOARD DOES NOT REPLAY ITS LAST TURN.
		// Everything visible was fetched with whatever turn produced it, so
		// without this every avatar would walk its previous move again on arrival:
		// on a page load, on an account switch, and every time one is panned into
		// view. Marking that turn as already seen is what makes the animation mean
		// "this just happened".
		this.walkedEpoch = entity.lastTurn?.epoch;
		this.destination = entity.position;

		this.update(entity);
	}

	/** The path container, which the renderer parents into the scene. */
	get pathLayer(): Container {
		return this.path;
	}

	update(entity: AvatarView) {
		this.destination = entity.position;
		this.updateWalk(entity);
		if (!this.walk) {
			this.position.set(
				entity.position.x * this.cellSize,
				entity.position.y * this.cellSize,
			);
		}

		this.deadCross.visible = entity.life === 0;
		this.highlight.visible = entity.isPlayer && !entity.entering;

		this.updateEntering(entity);
		this.updatePath(entity);
	}

	/**
	 * Start replaying a turn the chain has just reported, if there is a new one.
	 *
	 * The path comes from `CommitmentRevealed`, so it is what the contract
	 * ACCEPTED rather than what the player asked for: a step that walked into a
	 * wall is not in it, and the walk ends where the avatar actually stands.
	 * That is also why it works for every avatar rather than just this client's.
	 */
	private updateWalk(entity: AvatarView) {
		const turn = entity.lastTurn;
		if (!turn || turn.epoch === this.walkedEpoch) return;
		this.walkedEpoch = turn.epoch;

		// Only the steps. An Enter names the cell the avatar appeared on and an
		// Exit names the one it left from, and neither is a journey: the entering
		// animation covers the first, and the second ends with the avatar gone.
		const path = turn.actions
			.filter((action) => action.type === 'move')
			.map((action) => action.to);
		if (path.length === 0) return;

		// ALREADY THERE, SO TOO LATE. The turn and the position it produced are
		// supposed to arrive together; when they do not - the reads split across
		// the reveal's block, or a log read that failed once and succeeded the
		// next poll - the position lands first and this turn lands a poll later,
		// when the avatar is already drawn where the walk would end. Replaying
		// from there would run BACKWARDS through the path and forward again,
		// which is worse than not replaying at all. `walkedEpoch` was already
		// set above, so the turn is not retried either: the moment for it has
		// passed.
		const drawnAt: Position = {
			x: this.position.x / this.cellSize,
			y: this.position.y / this.cellSize,
		};
		if (drawnAt.x === entity.position.x && drawnAt.y === entity.position.y) {
			return;
		}

		// From where it is DRAWN, not from where the turn started: on a slow frame
		// or a re-render mid-walk that is the honest starting point, and it is
		// already the previous cell in the ordinary case.
		const from: Position = drawnAt;
		this.walk = createWalk({
			from,
			path,
			secondsPerStep: SECONDS_PER_STEP,
			maxSeconds: MAX_WALK_SECONDS,
		});
	}

	/**
	 * Advance the replay by one frame. Called by the renderer, which owns the
	 * frame loop; the object never reaches for a clock of its own.
	 *
	 * Takes MILLISECONDS, which is what `Frame.deltaMs` is. The walk thinks in
	 * seconds like the rest of the game's timings, and converting HERE is what
	 * keeps the two from being confused again: the first version of this passed
	 * `frame.deltaMs` straight through as seconds, so one 60fps frame advanced a
	 * walk by sixteen of them and every turn "replayed" as a single jump.
	 */
	tick(deltaMs: number) {
		if (!this.walk) return;
		const at = this.walk.advance(deltaMs / 1000);
		if (this.walk.done) {
			this.walk = undefined;
			this.position.set(
				this.destination.x * this.cellSize,
				this.destination.y * this.cellSize,
			);
			return;
		}
		this.position.set(at.x * this.cellSize, at.y * this.cellSize);
	}

	private updateEntering(entity: AvatarView) {
		if (!this.entering && entity.entering && spritesReady()) {
			// Built on first use rather than in the constructor: the object can be
			// created before the sprite bundle has arrived, and pixi answers a too
			// early `Assets.get` with undefined rather than an error.
			const textures = entryTextures();
			if (textures) {
				this.entering = new AnimatedSprite({
					textures,
					animationSpeed: 0.15,
					loop: true,
					autoPlay: true,
				});
				this.entering.zIndex = 0;
				this.entering.scale = this.cellSize / 64;
				this.entering.anchor.set(0.5, 0.7);
				this.addChild(this.entering);
			}
		}

		if (this.entering) this.entering.visible = entity.entering;
		// While spawning, the spawn animation stands in for the avatar itself.
		this.blockie.visible = !entity.entering || !this.entering;
	}

	private updatePath(entity: AvatarView) {
		this.path.removeChildren();
		if (!entity.isPlayer || entity.planned.length === 0) return;

		const size = Math.max(2, Math.round(this.cellSize / 5));
		const offset = (this.cellSize - size) / 2 - this.cellSize / 2;

		for (const action of entity.planned) {
			if (action.type === 'exit') {
				// LEAVING IS DRAWN, and it used to be skipped, which was fine only
				// while nothing could plan one. An exit has no destination cell of its
				// own - it happens where the moves end - so a dot like the others would
				// be invisible under the last step. A ring round that cell is the
				// difference between a player seeing their turn and pressing a key that
				// appears to do nothing until their avatar vanishes a round later.
				const half = this.cellSize / 2;
				const ring = new Graphics()
					.rect(-half + 1, -half + 1, this.cellSize - 2, this.cellSize - 2)
					.stroke({width: 2, color: 0xffcc00});
				ring.x = action.to.x * this.cellSize;
				ring.y = action.to.y * this.cellSize;
				this.path.addChild(ring);
				continue;
			}
			const dot = new Graphics()
				.rect(offset, offset, size, size)
				.fill(0x00ff00);
			dot.x = action.to.x * this.cellSize;
			dot.y = action.to.y * this.cellSize;
			this.path.addChild(dot);
		}
	}

	onRemoved() {
		this.path.removeChildren();
		this.path.removeFromParent();
		this.destroy({children: true});
	}
}
