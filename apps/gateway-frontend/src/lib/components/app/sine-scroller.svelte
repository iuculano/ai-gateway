<script lang="ts">
import { MediaQuery } from 'svelte/reactivity';

/**
 * An old-school demoscene sine scroller.
 *
 * The text runs right to left and each glyph rides a wave that is fixed in
 * SPACE, not in the string - so the letters ripple through the curve as they
 * travel, which is what the C64/Amiga intros actually did. A wave attached to
 * the string would just wobble the whole line up and down.
 */
let {
  text,
  height = 132,
}: {
  text: string;
  /** Canvas height. Needs room for the font plus twice the amplitude. */
  height?: number;
} = $props();

const FONT_PX = 34;
const FONT = `700 ${FONT_PX}px "Geist Mono Variable", ui-monospace, monospace`;
const INK = '#10b981';

/** Scroll speed, px per ms. ~90px/s reads without being a chore. */
const SPEED = 0.09;
/** Peak vertical travel, px either side of the middle. */
const AMPLITUDE = 21;
/** Distance for one full wave, px. Roughly four characters per hump. */
const WAVELENGTH = 190;
/** Wave drift, radians per ms. Slow enough to look alive, not seasick. */
const DRIFT = 0.0011;
/** Blank run between repeats so the loop point does not read as a typo. */
const GAP = 140;

const TAU = Math.PI * 2;

const reduced = new MediaQuery('prefers-reduced-motion: reduce');

let canvas: HTMLCanvasElement | undefined = $state();
let width = $state(0);

// Lives outside the frame loop: a resize tears the loop down and starts a new
// one, and the text should carry on from where it was rather than snap back.
let travelled = 0;
let phase = 0;

$effect(() => {
  const element = canvas;
  if (!element || width === 0) return;

  const ctx = element.getContext('2d');
  if (!ctx) return;

  // Assigning width/height also resets the transform, so the DPR scale below
  // applies once per setup rather than compounding across resizes.
  const dpr = window.devicePixelRatio || 1;
  element.width = Math.round(width * dpr);
  element.height = Math.round(height * dpr);
  ctx.scale(dpr, dpr);
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.shadowColor = INK;
  ctx.shadowBlur = 14;

  const chars = [...text];

  /** Per-glyph advances, measured once - this redraws the whole line 60x a second. */
  const measure = () => chars.map((char) => ({ char, advance: ctx.measureText(char).width }));
  const runOf = (glyphs: { advance: number }[]) => glyphs.reduce((sum, g) => sum + g.advance, 0) + GAP;

  let glyphs = measure();
  let run = runOf(glyphs);
  let cancelled = false;

  // The webfont may still be loading, which would freeze the fallback's advances
  // in place. Re-measure once it lands.
  document.fonts?.ready.then(() => {
    if (cancelled) return;
    glyphs = measure();
    run = runOf(glyphs);
  });

  const render = () => {
    ctx.clearRect(0, 0, width, height);
    const midY = height / 2;

    // Copies tile leftwards from the one entering at the right edge, so the
    // line is full from the first frame instead of scrolling in from an empty
    // canvas. Each sits exactly one run behind the last, so the wrap is seamless.
    const copies = Math.ceil(width / run) + 1;

    for (let copy = 0; copy < copies; copy++) {
      let x = width - travelled - copy * run;

      for (const glyph of glyphs) {
        if (x > -glyph.advance && x < width) {
          ctx.fillText(glyph.char, x, midY + Math.sin((x / WAVELENGTH) * TAU + phase) * AMPLITUDE);
        }
        x += glyph.advance;
      }
    }
  };

  let last = performance.now();
  let frame = requestAnimationFrame(function step(now) {
    const dt = now - last;
    last = now;

    travelled = (travelled + dt * SPEED) % run;
    phase = (phase + dt * DRIFT) % TAU;

    render();
    frame = requestAnimationFrame(step);
  });

  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
});
</script>

<div class="w-full" bind:clientWidth={width}>
	{#if reduced.current}
		<!-- Motion is the whole point, so there is nothing to degrade to but the words. -->
		<p class="px-[18px] py-9 text-center font-mono text-[22px] font-bold text-emerald-500">
			{text}
		</p>
	{:else}
		<!-- The canvas is decoration; the words themselves go to screen readers. -->
		<span class="sr-only">{text}</span>
		<canvas bind:this={canvas} class="block" style:width="{width}px" style:height="{height}px" aria-hidden="true"
		></canvas>
	{/if}
</div>
