<script lang="ts">
import { MediaQuery } from 'svelte/reactivity';

// An old-school demoscene sine scroller. The text runs right to left and each
// glyph rides a wave that is fixed in space and not in the string, so the
// letters ripple through the curve as they travel. A wave attached to the
// string would only wobble the whole line up and down.

interface Props {
  text: string;

  /**
   * The canvas height, which needs room for the font and twice the amplitude.
   */
  height?: number;
}

interface Glyph {
  char: string;
  advance: number;
}

let { text, height = 132 }: Props = $props();

const FONT_PX = 34;
const FONT = `700 ${FONT_PX}px "Geist Mono Variable", ui-monospace, monospace`;
const INK = '#10b981';

// Scroll speed in px per ms, which is about 90px a second.
const SPEED = 0.09;

// Peak vertical travel, in px either side of the middle.
const AMPLITUDE = 21;

// The distance one full wave covers in px, roughly four characters to a hump.
const WAVELENGTH = 190;

// How fast the wave drifts, in radians per ms.
const DRIFT = 0.0011;

// The blank run between repeats, so that the loop point does not read as a
// typo.
const GAP = 140;

const TAU = Math.PI * 2;

const reduced = new MediaQuery('prefers-reduced-motion: reduce');

let canvas: HTMLCanvasElement | undefined = $state();
let width = $state(0);

// Kept outside the frame loop. A resize tears the loop down and starts a new
// one, and the text should carry on from where it was.
let travelled = 0;
let phase = 0;

// Each glyph's advance and the length of one run of the text, measured once
// and not on every frame.
let glyphs: Glyph[] = [];
let run = 0;

function measure(ctx: CanvasRenderingContext2D): void {
  glyphs = [];
  run = GAP;

  for (const char of text) {
    const advance = ctx.measureText(char).width;

    glyphs.push({ char: char, advance: advance });
    run += advance;
  }
}

function render(ctx: CanvasRenderingContext2D): void {
  ctx.clearRect(0, 0, width, height);

  // Copies tile leftwards from the one entering at the right edge, so that the
  // line is full from the first frame. Each sits exactly one run behind the
  // last, which makes the wrap seamless.
  const copies = Math.ceil(width / run) + 1;

  for (let copy = 0; copy < copies; copy++) {
    let x = width - travelled - copy * run;

    for (const glyph of glyphs) {
      if (x > -glyph.advance && x < width) {
        ctx.fillText(glyph.char, x, height / 2 + Math.sin((x / WAVELENGTH) * TAU + phase) * AMPLITUDE);
      }

      x += glyph.advance;
    }
  }
}

$effect(() => {
  const element = canvas;
  const ctx = element?.getContext('2d');

  if (!element || !ctx || width === 0) {
    return;
  }

  // Assigning the size also resets the transform, so the scale below applies
  // once per setup and does not compound across resizes.
  const dpr = window.devicePixelRatio || 1;
  element.width = Math.round(width * dpr);
  element.height = Math.round(height * dpr);
  ctx.scale(dpr, dpr);
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = INK;
  ctx.shadowColor = INK;
  ctx.shadowBlur = 14;

  measure(ctx);

  // The webfont may still be loading, which would leave the fallback's advances
  // in place, so the text is measured again once it lands.
  let cancelled = false;

  void document.fonts.ready.then(() => {
    if (!cancelled) {
      measure(ctx);
    }
  });

  let last = performance.now();
  let frame = requestAnimationFrame(function step(now) {
    const elapsed = now - last;
    last = now;

    travelled = (travelled + elapsed * SPEED) % run;
    phase = (phase + elapsed * DRIFT) % TAU;

    render(ctx);
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
		<!-- The canvas is decoration, and the words themselves go to screen readers. -->
		<span class="sr-only">{text}</span>
		<canvas bind:this={canvas} class="block" style:width="{width}px" style:height="{height}px" aria-hidden="true"
		></canvas>
	{/if}
</div>
