/**
 * Keeps the pixi scene in step with the view state.
 *
 * One object per view cell: created when a cell first appears, updated while it
 * is present, removed when it goes. Nothing here reads the chain or knows the
 * rules; it only mirrors what the view state says, which is what makes the
 * renderer a seam the game fills rather than a place logic accumulates.
 */
import type {Container} from 'pixi.js';
import type {GameRenderer} from '$lib/game/core/seams';
import type {ViewStateStore} from '$lib/view';
import type {BoardView} from '../view';
import {CellObject} from './CellObject';

export function createBoardRenderer(params: {
	viewState: ViewStateStore<BoardView>;
	cellSize: number;
}): GameRenderer<Container> {
	const {viewState, cellSize} = params;

	const objects = new Map<bigint, CellObject>();
	let unsubscribe: (() => void) | undefined;

	return {
		onAppStarted(container: Container) {
			unsubscribe = viewState.subscribe(($view) => {
				if ($view.step === 'Unloaded') return;

				const seen = new Set<bigint>();

				for (const [id, cell] of $view.cells) {
					seen.add(id);
					let object = objects.get(id);
					if (!object) {
						object = new CellObject(cellSize, cell);
						container.addChild(object);
						objects.set(id, object);
					}
					object.update(cell);
				}

				for (const [id, object] of [...objects]) {
					if (seen.has(id)) continue;
					object.onRemoved();
					container.removeChild(object);
					objects.delete(id);
				}
			});
		},

		onAppStopped() {
			unsubscribe?.();
			unsubscribe = undefined;
			// The pixi Application is destroyed by the canvas, which takes the
			// display objects with it; only this module's own map has to be let go.
			objects.clear();
		},

		/** Per-frame hook. Nothing here animates independently of state yet. */
		tick() {},
	};
}
