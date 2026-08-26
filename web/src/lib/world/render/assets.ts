/**
 * The sprite bundle: loading it, and reporting how far it has got.
 *
 * THIS GAME'S PROBLEM, not the framework's. The template's pixi host calls
 * `onAppStarted` as soon as the app is ready and loads nothing, because a
 * commit-reveal app need not be a game with art at all. So the bundle is owned
 * here, beside the renderer that needs it, and the app decides what to show
 * while it arrives (see `lib/ui/loading/`).
 *
 * Loading starts at module scope rather than on `onStarted`, so it overlaps
 * with everything else the app is doing instead of waiting for a canvas to
 * mount.
 */
import {Assets, TextureStyle, type Spritesheet} from 'pixi.js';
import {writable, type Readable} from 'svelte/store';
import {browser} from '$lib/kit/environment';
import manifest from '$lib/manifest.json';

// Pixel art: never smooth it. Set before anything is loaded, since it is the
// default applied at texture construction.
TextureStyle.defaultOptions.scaleMode = 'nearest';

const BUNDLE = 'default';
const SPRITES = 'sprites';

let ready = false;

/**
 * 0 to 1. Reaches 1 whether the bundle loaded or failed; see below.
 *
 * A `writable` rather than a `readable` with a start function, because loading
 * begins at module scope and the splash subscribes later. A `readable` only
 * runs its producer while something is subscribed, so every update published
 * before the first subscriber would be dropped and a late subscriber would read
 * 0 forever, which is precisely the loading screen that never goes away.
 */
const progress = writable(0);
export const assetProgress: Readable<number> = {subscribe: progress.subscribe};
const setProgress = (value: number) => progress.set(value);

/** Whether the sprite sheet can be read right now. */
export function spritesReady(): boolean {
	return ready;
}

/** The loaded sheet, or undefined while it is still in flight. */
export function sprites(): Spritesheet | undefined {
	return ready ? Assets.get(SPRITES) : undefined;
}

let loading: Promise<void> | undefined;

/**
 * Begin loading, once per page.
 *
 * Idempotent because `Assets.init` may only be called once and throws on the
 * second attempt, while this is reachable from both the splash and the renderer.
 */
export function loadWorldAssets(): Promise<void> {
	if (loading) return loading;

	loading = (async () => {
		await Assets.init({manifest});
		await Assets.loadBundle(BUNDLE, (value) => setProgress(value));
		ready = true;
		setProgress(1);
	})().catch((err) => {
		// Progress is driven to 1 on failure ON PURPOSE. It is what the splash
		// waits on, and a bundle that 404s would otherwise leave the player
		// staring at a loading screen forever with no way past it. Missing art is
		// a degraded picture, not a broken game: avatars draw from blockies, which
		// are data URIs and need no bundle.
		console.error('could not load the sprite bundle', err);
		setProgress(1);
	});

	return loading;
}

if (browser) {
	void loadWorldAssets();
}
