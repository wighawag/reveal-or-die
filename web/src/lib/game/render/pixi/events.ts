/**
 * What the canvas reports upward.
 *
 * The canvas knows about pixels and pointers; it must not know what a click
 * MEANS. It emits a world-space cell coordinate and the game decides what that
 * is, which is what keeps the render layer free of game rules and lets a game
 * swap the whole surface out.
 */
import {EventEmitter} from 'tseep/lib/ee-safe';

export type CanvasEvents = {
	/** A click that was not part of a drag, in whole game units (cells). */
	clicked: (position: {x: number; y: number}) => void;
};

export type CanvasEventEmitter = EventEmitter<CanvasEvents>;

export function createCanvasEventEmitter(): CanvasEventEmitter {
	return new EventEmitter<CanvasEvents>();
}
