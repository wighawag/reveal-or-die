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
import {LoadingSprite} from '$lib/core/render/elements/LoadingSprite';
import {Blockie} from '$lib/core/utils/ethereum/blockie';
import type {AvatarView} from '../view';
import {sprites, spritesReady} from './assets';

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

		this.update(entity);
	}

	/** The path container, which the renderer parents into the scene. */
	get pathLayer(): Container {
		return this.path;
	}

	update(entity: AvatarView) {
		this.position.set(
			entity.position.x * this.cellSize,
			entity.position.y * this.cellSize,
		);

		this.deadCross.visible = entity.life === 0;
		this.highlight.visible = entity.isPlayer && !entity.entering;

		this.updateEntering(entity);
		this.updatePath(entity);
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
			if (action.type === 'exit') continue;
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
