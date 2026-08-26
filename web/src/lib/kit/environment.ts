export {version, browser} from '$app/environment';

/**
 * SvelteKit's build version, re-exported so the rest of the app can report it
 * without naming the framework.
 *
 * This is a build identity string (`config.kit.version.name`, defaulting to a
 * timestamp), and it is genuinely SvelteKit's: Vite has no equivalent, which is
 * why this is a re-export here rather than an `import.meta.env` read like the
 * one in `core/service-worker/index.ts`.
 *
 * A re-export rather than a wrapper on purpose. There is nothing to adapt, only
 * somewhere for the import to live, and inventing a function around a constant
 * would be indirection pretending to be a seam.
 */

/**
 * Whether this is running in a browser rather than being prerendered.
 *
 * Also a genuine framework fact rather than something to adapt: SvelteKit
 * renders every page once at build time, so a module that touches `window`,
 * `localStorage` or a canvas has to be able to ask. `import.meta.env.SSR` is
 * Vite's near-equivalent and is NOT the same question, since it is about how
 * the module was bundled rather than where it is executing.
 *
 * Prefer not to reach for it. Most uses are better served by doing the work in
 * `onMount`, which cannot run off-browser at all; this is for module-scope code
 * that has no lifecycle to hang off, which is the case the splash screen's
 * asset loading actually is.
 */
