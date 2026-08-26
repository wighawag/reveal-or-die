/**
 * One cell on screen.
 *
 * Draws two things the player needs to tell apart at a glance: what is on
 * chain, and what they have merely planned. The second is the one a
 * commit-reveal game has that an ordinary one does not, and it is drawn as an
 * outline rather than a fill so it never reads as confirmed.
 *
 * Note what is deliberately NOT drawn: which share of a cell is this player's.
 * The contract can answer it (`getStakeOnCell`) but only per cell, and a
 * client-side tally of "what I revealed this session" would be wrong after any
 * reload. Better to show nothing than something that is quietly false.
 */
import {Container, Graphics} from 'pixi.js';
import type {CellView} from '../view';

const CONFIRMED_COLOUR = 0x4f8cff;
const PLANNED_COLOUR = 0xffd166;

export class CellObject extends Container {
	private readonly body: Graphics;
	private readonly outline: Graphics;

	constructor(
		private readonly cellSize: number,
		cell: CellView,
	) {
		super();
		this.body = new Graphics();
		this.outline = new Graphics();
		this.addChild(this.body);
		this.addChild(this.outline);
		this.update(cell);
	}

	/**
	 * Called only when something visible actually changed.
	 *
	 * Redrawing a `Graphics` on every state emit is the easy way to make a pixi
	 * scene slow, so this used to guard itself with a hand-built key string
	 * (`${stake}:${claimants}:${planned}`). That guard now lives in the renderer
	 * as a typed comparison, which is the same idea without the failure mode:
	 * a field left out of a key string is silent, and shows up as a cell that
	 * simply never updates.
	 */
	update(cell: CellView) {
		this.x = cell.position.x * this.cellSize;
		this.y = cell.position.y * this.cellSize;

		const size = this.cellSize;
		const half = size / 2;

		this.body.clear();
		if (cell.numClaimants > 0) {
			// Contested cells are shared, not won: the fill shows there is stake
			// here, and the claimant count is what says it is not one player's.
			const inset = size * 0.15;
			this.body
				.rect(-half + inset, -half + inset, size - 2 * inset, size - 2 * inset)
				.fill({
					color: CONFIRMED_COLOUR,
					alpha: Math.min(0.35 + 0.2 * cell.numClaimants, 0.95),
				});
		}

		this.outline.clear();
		if (cell.planned) {
			this.outline
				.rect(-half, -half, size, size)
				.stroke({color: PLANNED_COLOUR, width: 2, alignment: 0.5});
		}
	}

	onRemoved() {
		this.body.destroy();
		this.outline.destroy();
	}
}
