<!--
	The phase dial.

	This game's own clock, kept from the pre-port UI because it is the thing a
	player looks at constantly and a pie reads faster than a bar. What changed is
	only where it gets its numbers: it used to reach into the context and read
	`twoPhase`, `localState` and `deployments` itself, and now it takes a finished
	model as props. Everything it used to decide lives in `./hud.ts`.

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
		phase: 'play' | 'wait';
		/** How far through the phase, 0..1. */
		progress: number;
		secondsLeft: number;
		size?: number;
	} = $props();

	const center = $derived(size / 2);
	const radius = $derived(size * 0.4);

	// The dial fills as the phase is spent, starting at twelve o'clock.
	const colour = $derived(
		phase === 'play'
			? 'oklch(57.7% 0.245 27.325)'
			: 'oklch(85.2% 0.199 91.936)',
	);
	const background = $derived(
		phase === 'play'
			? 'oklch(79.2% 0.209 151.711)'
			: 'oklch(57.7% 0.245 27.325)',
	);

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
	aria-label="{phase === 'play' ? 'Move' : 'Wait'}, {secondsLeft} seconds left"
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
			{secondsLeft}
		</text>
	</svg>
</div>
