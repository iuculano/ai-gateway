<script lang="ts">
import { Input } from '#lib/components/ui/input/index.ts';

interface Props {
  id: string;
  label: string;
  options: string[];
  value: string;
  allLabel?: string;
  class?: string;
}

let { id, label, options, value = $bindable(''), allLabel, class: fieldClass = '' }: Props = $props();

let open = $state(false);
let query = $state('');
let highlighted = $state(0);

const blankLabel = $derived(allLabel ?? `All ${label.toLowerCase()}s`);

// The blank option first, then whatever matches what was typed. The value in
// force is always offered, even when the options no longer include it.
const matches = $derived([
  { value: '', label: blankLabel },
  ...[...new Set(value ? [value, ...options] : options)]
    .filter((option) => option.toLowerCase().includes(query.trim().toLowerCase()))
    .map((option) => ({ value: option, label: option })),
]);

function show(): void {
  open = true;
  query = '';
  highlighted = 0;
}

function showIfClosed(): void {
  if (!open) {
    show();
  }
}

function choose(next: string): void {
  value = next;
  open = false;
  query = '';
}

function move(index: number): void {
  highlighted = (index + matches.length) % matches.length;
  document.getElementById(`${id}-option-${highlighted}`)?.scrollIntoView({ block: 'nearest' });
}

function onInput(event: Event & { currentTarget: HTMLInputElement }): void {
  query = event.currentTarget.value;
  open = true;

  // Typing lands on the first real match, past the blank option.
  highlighted = query.trim() && matches.length > 1 ? 1 : 0;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    open = false;

    return;
  }

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();

    if (open) {
      move(highlighted + (event.key === 'ArrowDown' ? 1 : -1));
    } else {
      show();
    }

    return;
  }

  if (event.key === 'Enter' && open) {
    event.preventDefault();

    const option = matches[highlighted];

    if (option) {
      choose(option.value);
    }
  }
}
</script>

<div class="relative min-w-0 {fieldClass}">
	<Input
		{id}
		value={open ? query : value}
		placeholder={open ? `Search ${label.toLowerCase()}s…` : blankLabel}
		aria-label={label}
		role="combobox"
		aria-expanded={open}
		aria-autocomplete="list"
		aria-controls="{id}-listbox"
		aria-activedescendant={open && matches[highlighted] ? `${id}-option-${highlighted}` : undefined}
		autocomplete="off"
		spellcheck={false}
		class="h-8 w-full rounded-lg border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-300"
		onfocus={show}
		onclick={showIfClosed}
		oninput={onInput}
		onblur={() => (open = false)}
		onkeydown={onKeydown}
	/>
	{#if open}
		<ul id="{id}-listbox" role="listbox" aria-label={label}
			class="absolute right-0 top-full z-50 mt-1 max-h-[264px] w-max min-w-full max-w-[min(360px,80vw)] overflow-y-auto rounded-lg border border-line-strong bg-surface-3 py-1 shadow-lg">
			{#each matches as option, index (option.value)}
				<li role="none">
					<button type="button" role="option" tabindex="-1" id="{id}-option-{index}"
						aria-selected={value === option.value}
						class="flex w-full items-center justify-between gap-3 px-2.5 py-[7px] text-left text-[12.5px] text-zinc-200 {index === highlighted ? 'bg-surface-5' : 'hover:bg-surface-4'}"
						onpointerdown={(event) => { event.preventDefault(); choose(option.value); }}
						onclick={() => choose(option.value)}
						onmouseenter={() => (highlighted = index)}>
						<span class="truncate" title={option.label}>{option.label}</span>
						{#if value === option.value}<span class="text-emerald-400" aria-hidden="true">✓</span>{/if}
					</button>
				</li>
			{/each}
			{#if matches.length === 1 && query.trim()}
				<li role="none" class="px-2.5 py-2 text-xs text-zinc-500">No matching {label.toLowerCase()}s</li>
			{/if}
		</ul>
	{/if}
</div>
