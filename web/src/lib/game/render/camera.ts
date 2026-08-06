/**
 * The camera.
 *
 * Renderer-agnostic on purpose. The read side is what decides which part of the
 * world to load, so the state layer depends on it; if it imported pixi then
 * every game on this template would have to render with pixi. The control side
 * talks to whatever surface is mounted through a small adapter the renderer
 * registers, so a pixi Viewport and a WebGL camera both fit.
 */
import {writable, type Readable} from 'svelte/store';

/** Camera position and extent, in game units (not pixels). */
export type Camera = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type CameraWatcher = Readable<Camera>;

/**
 * What the mounted surface must provide for the camera to be able to drive it.
 * Registered by the renderer when it starts; absent before then, which is why
 * every method here is best-effort.
 */
export type CameraSurface = {
	/** Centre the view on a point, in game units. */
	moveCenter(x: number, y: number): void;
};

export type CameraControl = {
	/** Called by the renderer once its surface exists. */
	attach(surface: CameraSurface): void;
	detach(): void;
	/** Called by the renderer each frame with the surface's real extent. */
	update(values: Camera): void;
	follow(x: number, y: number): void;
	move(dx: number, dy: number): void;
};

export function createCamera(): {
	camera: CameraWatcher;
	cameraControl: CameraControl;
} {
	let $camera: Camera = {x: 0, y: 0, width: 0, height: 0};
	const cameraStore = writable<Camera>($camera);
	let surface: CameraSurface | undefined;

	const cameraControl: CameraControl = {
		attach(next: CameraSurface) {
			surface = next;
		},
		detach() {
			surface = undefined;
		},
		follow(x: number, y: number) {
			surface?.moveCenter(x, y);
		},
		move(dx: number, dy: number) {
			surface?.moveCenter($camera.x + dx, $camera.y + dy);
		},
		update(values: Camera) {
			if (
				$camera.x !== values.x ||
				$camera.y !== values.y ||
				$camera.width !== values.width ||
				$camera.height !== values.height
			) {
				$camera = values;
				cameraStore.set($camera);
			}
		},
	};

	return {camera: {subscribe: cameraStore.subscribe}, cameraControl};
}
