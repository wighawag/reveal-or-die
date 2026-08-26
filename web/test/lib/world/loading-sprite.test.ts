import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Assets, Texture} from 'pixi.js';
import {
	LoadingSprite,
	resetRegisteredAliases,
} from '$lib/world/render/LoadingSprite';

/**
 * The two defects docs/audits/03-renderer.md 3.5 named, pinned.
 *
 * Both are silent, which is the only reason they are worth a test: neither
 * throws, so nothing in the app would ever report them. The audit found them by
 * reading, and reading is exactly what stops happening once a file has been
 * moved twice.
 */

const URI = 'data:image/png;base64,AAAA';

beforeEach(() => {
	resetRegisteredAliases();
	// The constructor kicks off a real load, which has nothing to fetch from in
	// node. Held pending so the tests drive `onLoaded` themselves, which is the
	// point: the interesting moment is when the texture arrives, not whether it
	// can be fetched here.
	vi.spyOn(Assets, 'load').mockReturnValue(new Promise(() => {}));
	vi.spyOn(Assets, 'add').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('a texture that arrives after the object is gone', () => {
	it('does not attach to a destroyed container', () => {
		// `AvatarObject.onRemoved` calls `destroy({children: true})`, and an avatar
		// is removed whenever it leaves the camera's zones. During a pan that
		// happens continuously, and a blockie takes long enough to decode to lose
		// the race routinely.
		const sprite = new LoadingSprite(URI);
		sprite.destroy({children: true});

		sprite.onLoaded(Texture.EMPTY);

		// The CHILD COUNT, not `not.toThrow()`, which was the first thing written
		// here and was worthless: pixi v8 accepts addChild on a destroyed container
		// without complaint (verified), so that assertion passed with the guard
		// deleted. The whole defect is that it is silent, so the test has to look at
		// the thing that silently happens.
		expect(sprite.children).toHaveLength(0);
	});

	it('still attaches when the object is alive', () => {
		// Guards the guard: a check written the wrong way round would make every
		// blockie invisible for ever, and the test above would still pass.
		const sprite = new LoadingSprite(URI);
		expect(sprite.children.length).toBe(0);
		sprite.onLoaded(Texture.EMPTY);
		expect(sprite.children.length).toBe(1);
	});
});

describe('two avatars owned by the same account', () => {
	it('registers the alias once', () => {
		// The blockie URI is derived from the OWNER, so two avatars of one account
		// produce the same alias. Not an edge case: it is what an account playing
		// two avatars looks like, and docs/plans/web-port.md recommends exactly
		// that arrangement. pixi warns and ignores the second registration, which
		// is noise that hides real warnings.
		new LoadingSprite(URI);
		new LoadingSprite(URI);

		expect(Assets.add).toHaveBeenCalledTimes(1);
	});

	it('still registers a different owner', () => {
		new LoadingSprite(URI);
		new LoadingSprite('data:image/png;base64,BBBB');

		expect(Assets.add).toHaveBeenCalledTimes(2);
	});
});
