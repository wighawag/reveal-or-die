/**
 * A sprite that shows up when its texture arrives.
 *
 * Used for the owner blockie on an avatar, which is a data URI derived from an
 * address rather than a file in the asset bundle, so it cannot be preloaded
 * with everything else: it is not known until the board says who is standing
 * there.
 */
import {Assets, Container, Sprite, Texture} from 'pixi.js';

/**
 * Which aliases have been registered with pixi already.
 *
 * `Assets.add` warns and ignores the second registration of an alias, and two
 * avatars owned by the same account produce the SAME blockie URI, which is not
 * a rare case: it is what an account playing two avatars looks like, and it is
 * the arrangement docs/plans/web-port.md says to use for two browsers.
 */
const registered = new Set<string>();

export class LoadingSprite extends Container {
	constructor(url: string) {
		super();

		if (!registered.has(url)) {
			registered.add(url);
			Assets.add({alias: url, src: url, data: {scaleMode: 'nearest'}});
		}

		Assets.load(url)
			.then((texture) => this.onLoaded(texture))
			.catch((err) => {
				// Nothing to do about it and nothing to show: the avatar draws
				// without its blockie rather than not at all.
				console.error(err);
			});
	}

	onLoaded(texture: Texture) {
		/**
		 * THE LOAD OUTLIVES THE OBJECT, routinely.
		 *
		 * `AvatarObject.onRemoved` calls `destroy({children: true})`, and an avatar
		 * is removed whenever it leaves the camera's zones, which during a pan is
		 * constantly. Decoding a blockie takes long enough for that to happen in
		 * between.
		 *
		 * Adding to a destroyed container does NOT throw in pixi v8 (verified), so
		 * without this the failure is silent: a sprite attached to a corpse, and a
		 * texture kept alive by it for the rest of the session. That is the shape
		 * the canvas host is already careful about for its own unmount race, and
		 * this is the same race one layer down.
		 */
		if (this.destroyed) return;

		this.addChild(new Sprite(texture));
	}
}

/** For tests: forget which aliases have been registered. */
export function resetRegisteredAliases() {
	registered.clear();
}
