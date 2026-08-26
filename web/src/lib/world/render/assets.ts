/**
 * The sprite bundle, and knowing when it has arrived.
 *
 * The framework's pixi host calls `onAppStarted` the moment the app is ready
 * and does not wait for any assets, because it has none of its own: nothing in
 * `game/render/pixi` touches `Assets`. A game with art therefore has to own
 * this itself, and the awkward part is not the loading but the ORDER. Scene
 * objects are created by the reconciler as entities appear, which can easily be
 * before the textures exist, and pixi's `Assets.get` returns undefined rather
 * than throwing, so a too-early read produces an invisible sprite and no error
 * anywhere.
 *
 * So: start loading on `onStarted`, expose a synchronous `spritesReady()` for
 * the objects to check, and let them build the parts that need textures the
 * first time they are updated after it flips. A gate in the host would be
 * better and is the shape worth backporting (see docs/plans/web-port.md); this
 * is the version that does not require changing the framework.
 */
import {Assets, type Spritesheet} from 'pixi.js';

const BUNDLE = 'default';
const SPRITES = 'sprites';

let loading: Promise<void> | undefined;
let ready = false;

/** Whether the sprite sheet can be read right now. */
export function spritesReady(): boolean {
	return ready;
}

/** The loaded sheet, or undefined while it is still in flight. */
export function sprites(): Spritesheet | undefined {
	return ready ? Assets.get(SPRITES) : undefined;
}

/**
 * Begin loading, once per page.
 *
 * Idempotent because the renderer is started and stopped whenever the canvas
 * remounts, while `Assets.init` may only be called once per page and throws on
 * the second attempt.
 */
export function loadWorldAssets(): Promise<void> {
	if (loading) return loading;

	loading = (async () => {
		const manifest = (await import('$lib/manifest.json')).default;
		await Assets.init({manifest});
		await Assets.loadBundle(BUNDLE);
		ready = true;
	})().catch((err) => {
		// Deliberately not rethrown. Missing art is a degraded picture, not a
		// broken game: the avatars still draw from their blockies, which are data
		// URIs and need no bundle at all.
		console.error('could not load the sprite bundle', err);
	});

	return loading;
}
