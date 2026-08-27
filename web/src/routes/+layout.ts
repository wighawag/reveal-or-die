import {get} from 'svelte/store';
import {onDocumentLoaded} from '$lib/core/utils/web/hooks.js';
import {dev, version} from '$app/environment';
import {PUBLIC_ENABLE_SW_IN_DEV} from '$env/static/public';
import {serviceWorker} from '$lib';

import {logs} from 'named-logs';
import {setupLogging} from '$lib/debug/logging';
import {params} from '$lib';

// FIRST, and from module scope, because everything below logs. `named-logs` is
// inert until this runs, so a logger built earlier still works (the factory is
// shared) but a line WRITTEN earlier is gone for good.
//
// The service worker just below has the same "must be early" property for a
// different reason, which is why both live at module scope in this file rather
// than in a component.
const logging = setupLogging(params);

const logger = logs('init');

if (logging === 'restored') {
	// Said out loud, once. `factory.enable` persists to localStorage, so a
	// `?debug` from some previous session is still in force with nothing in the
	// URL to explain it. A console full of unexplained noise gets reported as a
	// bug in the app.
	console.warn(
		`named-logs is enabled from a previous session (localStorage "debug"). Use ?debug=off to stop.`,
	);
}

logger.debug(`initialization...`);

export const prerender = true;
export const trailingSlash = 'always';
export const ssr = true;

console.log(`VERSION: ${version}`);

// The service worker is registered in production. In dev it is skipped by
// default so HMR/reloads are not intercepted by the SW cache; set
// PUBLIC_ENABLE_SW_IN_DEV=true to opt in when developing the SW itself
// (push notifications, update flow, offline).
//
// `onDocumentLoaded` calls back SYNCHRONOUSLY when the document is already
// parsed, and that matters here: `register()` attaches a `message` listener on
// `navigator.serviceWorker`, and messages a controlling worker sent while the
// page was loading are queued and flushed right after `DOMContentLoaded`.
// Attaching in that same task keeps us ahead of the flush. Deferring it (an
// `await`, a `setTimeout`, or waiting on window's `load`) would drop those
// messages, which for this app are push notifications.
const enableSwInDev = PUBLIC_ENABLE_SW_IN_DEV === 'true';
if (!dev || enableSwInDev) {
	if (dev) {
		console.warn(
			`registering service-worker in dev mode (PUBLIC_ENABLE_SW_IN_DEV=true); HMR and reloads may be intercepted by the SW cache`,
		);
	}
	onDocumentLoaded(serviceWorker.register);
} else {
	console.warn(
		`skipping service-worker registration in dev mode, see src/routes/+layout.ts (set PUBLIC_ENABLE_SW_IN_DEV=true to enable)`,
	);
	// Skipping registration does not UNregister. A worker installed by a
	// production build previously served on this origin (preview, an E2E run, a
	// locally served build: all typically on this same port) is still installed
	// and still serving from its cache, which looks like a build or HMR fault
	// rather than a service worker one. Only ever removes OUR OWN worker.
	serviceWorker.unregisterStale();
}

// Dev/debug: attach svelte's store `get()` and the service worker store for
// console access. The E2E suite reads the registration decision through these
// same handles, rather than the app growing a test-only hook.
(globalThis as any).get = get;
(globalThis as any).serviceWorker = serviceWorker;
