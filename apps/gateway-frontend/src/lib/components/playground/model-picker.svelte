<script lang="ts">
import { onMount } from 'svelte';
import { listAllProviders } from '#lib/api/models.ts';
import { Input } from '#lib/components/ui/input/index.ts';
import { type ModelOption, matchingOptions, modelOptions } from '#lib/data/catalog.ts';
import { fmtContext, fmtPricePerMillion, providerTone } from '#lib/data/format.ts';

// A model field that suggests models from the catalog. It stays a text field,
// because a request can name several models in a comma-separated routing list.

interface Props {
  value: string;
  disabled?: boolean;
  id?: string;
  class?: string;

  /**
   * Which endpoint's models to suggest. The same slug can be sold through
   * several.
   */
  type?: 'chat' | 'embedding' | 'decision';
}

let {
  value = $bindable(),
  disabled = false,
  id = 'playground-model',
  class: fieldClass = '',
  type = 'chat',
}: Props = $props();

let options: ModelOption[] = $state([]);
let open = $state(false);
let highlighted = $state(0);
let input: HTMLInputElement | null = $state(null);

// Where to draw the list, in viewport coordinates. It is positioned fixed and
// not absolutely, because everywhere this field is used sits inside something
// that clips its overflow, which would cut the suggestions off at its edge.
let anchor = $state<{ top: number; left: number; width: number } | null>(null);

const matches = $derived(matchingOptions(options, value));

function measure(): void {
  if (!input) {
    return;
  }

  const rect = input.getBoundingClientRect();

  anchor = { top: rect.bottom + 4, left: rect.left, width: rect.width };
}

function show(): void {
  measure();
  open = true;
  highlighted = 0;
}

function hide(): void {
  open = false;
}

function choose(option: ModelOption): void {
  value = option.slug;
  open = false;
  input?.focus();
}

function chooseOnPress(event: PointerEvent, option: ModelOption): void {
  // Ahead of blur, which would close the list before the click landed and make
  // every suggestion impossible to pick.
  event.preventDefault();
  choose(option);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    open = false;

    return;
  }

  if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    open = true;

    return;
  }

  if (!open || matches.length === 0) {
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    highlighted = (highlighted + 1) % matches.length;

    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    highlighted = (highlighted - 1 + matches.length) % matches.length;

    return;
  }

  // Enter is taken only when a suggestion is highlighted. Otherwise it belongs
  // to the form, which runs the request.
  const option = matches[highlighted];

  if (event.key === 'Enter' && option) {
    event.preventDefault();
    choose(option);
  }
}

// Measured again while the list is open. The scroll listener is in the capture
// phase, so that it also follows a scrolling ancestor and not only the window.
$effect(() => {
  if (!open) {
    return;
  }

  window.addEventListener('scroll', measure, true);
  window.addEventListener('resize', measure);

  return () => {
    window.removeEventListener('scroll', measure, true);
    window.removeEventListener('resize', measure);
  };
});

onMount(async () => {
  // Suggestions are a convenience. Losing them leaves a plain text field.
  try {
    const result = await listAllProviders();

    options = modelOptions(result.data, type);
  } catch {
    options = [];
  }
});
</script>

<div class="relative">
	<!-- The shared Input and not a bare element, because its base classes carry
	     the border, the focus ring and the disabled look that the callers' field
	     classes assume. Everything below reaches the element through its rest
	     props.

	     The placeholder is a prompt and not an example id. An empty compare
	     column sits beside a filled one, and a placeholder that looked like a
	     value would make the two hard to tell apart. -->
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
		onfocus={show}
		oninput={show}
		onblur={hide}
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
						onpointerdown={(event) => chooseOnPress(event, option)}
						onmouseenter={() => (highlighted = index)}
					>
						<!-- Named and not only coloured. Several providers resell the same
						     model, and a dot alone does not say which one this row would bill. -->
						<span class="flex w-[88px] flex-none items-center gap-[7px] text-[11.5px] text-zinc-500">
							<span class="size-[6px] flex-none rounded-full" style:background={tone.color}></span>
							<span class="truncate">{tone.label}</span>
						</span>
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
