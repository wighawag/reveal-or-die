<!--
	The phase dial.

	This game's own clock, kept from the pre-port UI because it is the thing a
	player looks at constantly and a pie reads faster than a bar. What changed is
	only where it gets its numbers: it used to reach into the context and read
	`twoPhase`, `localState` and `deployments` itself, and now it takes a finished
	model as props. Everything it used to decide lives in `./hud.ts`.

	FOUR PARTS OF THE ROUND, one colour each, rather than the old two: the move
	window, the commit lock, the reveal, and the catch-up at the boundary. The
	middle two were folded into one "wait" before, which was fine to play on and
	useless to debug against.

	Purely presentational, so it can sit anywhere: the HUD renders it, and the
	tutorial points at `#game-clock`.
-->
<script lang="ts">
	let {
		phase,
		progress,
		secondsLeft,
		size = 100,
	}: {
		phase: 'play' | 'commit' | 'reveal' | 'catching-up';
		/** How far through this part of the round, 0..1. */
		progress: number;
		/**
		 * Seconds left in this part, or undefined when nobody can know. Only the
		 * catch-up has no countdown: it lasts until the board's own epoch catches
		 * up with the clock's, and a dial pretending otherwise would be a lie.
		 */
		secondsLeft?: number;
		size?: number;
	} = $props();

	const phaseLabel = $derived(
		phase === 'play'
			? 'Move window'
			: phase === 'commit'
				? 'Committing'
				: phase === 'reveal'
					? 'Revealing'
					: 'Catching up',
	);

	const center = $derived(size / 2);
	const radius = $derived(size * 0.4);

	// One colour per part of the round: green to move, amber while the
	// commitments land, red for the reveal, blue for the catch-up.
	const COLOURS = {
		play: 'oklch(57.7% 0.245 27.325)',
		commit: 'oklch(75% 0.15 80)',
		reveal: 'oklch(58% 0.21 27)',
		'catching-up': 'oklch(62% 0.15 250)',
	} as const;
	const FILL = {
		play: 'oklch(79.2% 0.209 151.711)',
		commit: 'oklch(85.2% 0.199 91.936)',
		reveal: 'oklch(57.7% 0.245 27.325)',
		'catching-up': 'oklch(40% 0.12 250)',
	} as const;
	const colour = $derived(COLOURS[phase]);
	const background = $derived(FILL[phase]);

	function piePath(fraction: number): string {
		const angle = Math.min(1, Math.max(0, fraction)) * 360;
		if (angle === 0) return '';
		const point = (degrees: number) => [
			center + radius * Math.cos(((degrees - 90) * Math.PI) / 180),
			center + radius * Math.sin(((degrees - 90) * Math.PI) / 180),
		];
		const [startX, startY] = point(0);
		const [endX, endY] = point(angle >= 360 ? 359.999 : angle);
		const largeArc = angle > 180 ? 1 : 0;
		return `M ${center} ${center} L ${startX} ${startY} A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY} Z`;
	}

	const path = $derived(piePath(progress));
</script>

<div
	id="game-clock"
	class="relative inline-block"
	style="width: {size}px; height: {size}px"
	role="timer"
	aria-label="{phaseLabel}, {secondsLeft === undefined
		? 'unknown time left'
		: `${secondsLeft} seconds left`}"
>
	<svg width={size} height={size} viewBox="0 0 {size} {size}">
		<circle cx={center} cy={center} r={radius} fill={background} />
		{#if path}
			<path d={path} fill={colour} class="drop-shadow" />
		{/if}
		<text
			x={center}
			y={center}
			text-anchor="middle"
			dominant-baseline="central"
			class="fill-white font-mono text-[1.5rem] font-bold"
			style="paint-order: stroke; stroke: rgba(0,0,0,0.6); stroke-width: 4px"
		>
			{secondsLeft ?? '?'}
		</text>
	</svg>
</div>
