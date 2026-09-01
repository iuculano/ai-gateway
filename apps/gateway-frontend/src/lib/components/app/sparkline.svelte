<script lang="ts">
import { linePoints } from '$lib/data/format';

let {
  values,
  stroke,
  width = 92,
  height = 34,
  class: className = '',
}: {
  values: number[];
  stroke: string;
  width?: number;
  height?: number;
  class?: string;
} = $props();
</script>

<svg {width} {height} viewBox="0 0 {width} {height}" fill="none" preserveAspectRatio="none" class={className}>
	<polyline
		points={linePoints(values, width, height)}
		fill="none"
		{stroke}
		stroke-width="1.6"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
</svg>
