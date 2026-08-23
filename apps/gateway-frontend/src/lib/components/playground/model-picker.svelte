<script lang="ts">
import { onMount } from 'svelte';
import { listProviders } from '$lib/api/models';
import { Input } from '$lib/components/ui/input';
import { fmtContext, fmtPricePerMillion, providerTone } from '$lib/data/format';

/**
 * A model field that suggests from the catalogue without being limited to it.
 *
 * Free text on purpose. An Azure deployment is named by whoever created it, so
 * it is not in the catalogue and never will be - a strict dropdown would make
 * the gateway's own Azure support unreachable from this page. The catalogue is
 * a source of suggestions here, not an allowlist.
 */
let {
  value = $bindable(),
  disabled = false,
  id = 'playground-model',
  class: fieldClass = '',
}: {
  value: string;
  disabled?: boolean;
  id?: string;
  class?: string;
} = $props();

interface Option {
  /** What goes in the field: the explicit `provider/name` form. */
  slug: string;
  provider: string;
  name: string;
  cost_input: number | null;
  context_limit: number | null;
}

let options: Option[] = $state([]);
let open = $state(false);
let highlighted = $state(0);
let input: HTMLInputElement | null = $state(null);

/**
 * Where to draw the list, in viewport coordinates.
 *
 * The list is positioned `fixed` rather than absolutely, because every place
 * this field is used sits inside something that clips: the settings rail is
 * `overflow-y-auto` and Panel is `overflow-hidden`. An absolutely positioned
 * list is clipped by either one, which cut the suggestions off at the edge of
 * whichever box contained them.
 */
let anchor = $state<{ top: number; left: number; width: number } | null>(null);

function measure() {
  if (!input) return;

  const rect = input.getBoundingClientRect();
  anchor = { top: rect.bottom + 4, left: rect.left, width: rect.width };
}

// Re-measured while open, in the capture phase so it also follows a scroll of
// an ancestor container rather than only the window.
$effect(() => {
  if (!open) return;

  const reposition = () => measure();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  return () => {
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
  };
});

onMount(async () => {
  try {
    const result = await listProviders();

    options = result.data.flatMap((provider) =>
      provider.models
        .filter((model) => model.delisted_at === null)
        .map((model) => ({
          slug: `${provider.id}/${model.name}`,
          provider: provider.id,
          name: model.name,
          cost_input: model.cost_input,
          context_limit: model.context_limit,
        })),
    );
  } catch {
    // Suggestions are a convenience. Losing them leaves a plain text field,
    // which is exactly what this was before the catalogue existed.
    options = [];
  }
});

const matches = $derived.by(() => {
  const query = value.trim().toLowerCase();
  const pool = query.length === 0 ? options : options.filter((o) => o.slug.toLowerCase().includes(query));

  // Cheapest first within the list, so the top of a broad match is the
  // affordable end rather than whatever the provider happened to publish first.
  return [...pool].sort((a, b) => (a.cost_input ?? Number.MAX_VALUE) - (b.cost_input ?? Number.MAX_VALUE)).slice(0, 50);
});

function choose(option: Option) {
  value = option.slug;
  open = false;
  input?.focus();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    open = false;
    return;
  }

  if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    open = true;
    return;
  }

  if (!open || matches.length === 0) return;

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    highlighted = (highlighted + 1) % matches.length;
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    highlighted = (highlighted - 1 + matches.length) % matches.length;
  } else if (event.key === 'Enter') {
    const option = matches[highlighted];
    // Only intercept Enter when the reader is actually pointed at a suggestion.
    // Otherwise it belongs to the form, which runs the request.
    if (option) {
      event.preventDefault();
      choose(option);
    }
  }
}
</script>

<div class="relative">
	<!-- The shared Input, not a bare element: its base classes carry the border,
	     the focus ring and the disabled treatment, and FIELD_CLASS assumes them.
	     Everything below reaches the element through restProps.

	     The placeholder is a prompt rather than an example id. An empty compare
	     column sat beside a filled one, and a placeholder that looked like a
	     value made the two indistinguishable; the format is explained under the
	     field, and the list itself teaches it. -->
	<Input
		{id}
		bind:ref={input}
		bind:value
		type="text"
		role="combobox"
		aria-expanded={open}
		aria-controls="{id}-listbox"
		autocomplete="off"
		spellcheck={false}
		placeholder="Choose a model…"
		{disabled}
		class="w-full font-mono {fieldClass}"
		onfocus={() => {
			measure();
			open = true;
			highlighted = 0;
		}}
		oninput={() => {
			measure();
			open = true;
			highlighted = 0;
		}}
		onblur={() => (open = false)}
		onkeydown={onKeydown}
	/>

	{#if open && matches.length > 0 && anchor}
		<ul
			id="{id}-listbox"
			role="listbox"
			class="fixed z-50 max-h-[264px] overflow-y-auto rounded-lg border border-line-strong bg-surface-3 py-1 shadow-[0_8px_24px_rgba(0,0,0,.45)]"
			style:top="{anchor.top}px"
			style:left="{anchor.left}px"
			style:width="{anchor.width}px"
		>
			{#each matches as option, index (option.slug)}
				{@const tone = providerTone(option.provider)}
				<li role="none">
					<button
						type="button"
						role="option"
						aria-selected={index === highlighted}
						class="flex w-full items-center gap-2 px-2.5 py-[7px] text-left {index === highlighted
							? 'bg-surface-5'
							: 'hover:bg-surface-4'}"
						onpointerdown={(event) => {
							// Ahead of blur, which would close the list before the click
							// landed and make every suggestion unselectable.
							event.preventDefault();
							choose(option);
						}}
						onmouseenter={() => (highlighted = index)}
					>
						<span class="size-[6px] flex-none rounded-full" style:background={tone.color}></span>
						<span class="min-w-0 flex-1 truncate font-mono text-[12.5px] text-zinc-200">{option.name}</span>
						<span class="flex-none text-[11px] text-zinc-600 tabular-nums">
							{fmtContext(option.context_limit)}
						</span>
						<span class="w-[62px] flex-none text-right text-[11px] text-zinc-500 tabular-nums">
							{fmtPricePerMillion(option.cost_input)}
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>
