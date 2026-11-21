<script lang="ts">
import * as Select from '#lib/components/ui/select/index.ts';

// Fills the form with a ready-made request.

interface Props {
  examples: { label: string }[];
  onpick: (index: number) => void;
  disabled?: boolean;
}

let { examples, onpick, disabled = false }: Props = $props();

// Reset after every pick, so that choosing the same example twice still fires.
let value = $state('');
</script>

<Select.Root
	type="single"
	bind:value
	onValueChange={(next) => {
		if (next) onpick(Number(next));
		value = '';
	}}
	{disabled}
>
	<Select.Trigger
		class="h-[30px] rounded-lg border-line-strong bg-surface-3 px-2.5 text-[12.5px] text-zinc-300 dark:bg-surface-3 dark:hover:bg-surface-4"
	>
		Examples
	</Select.Trigger>
	<Select.Content>
		{#each examples as example, index (index)}
			<Select.Item value={String(index)} label={example.label} />
		{/each}
	</Select.Content>
</Select.Root>
