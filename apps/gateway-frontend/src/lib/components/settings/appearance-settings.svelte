<script lang="ts">
import { onMount } from 'svelte';
import SettingRow from './setting-row.svelte';
import SettingsSection from './settings-section.svelte';
import * as Select from '$lib/components/ui/select';
import { Button } from '$lib/components/ui/button';

const accents = [
  { id: 'emerald', label: 'Emerald' },
  { id: 'blue', label: 'Blue' },
  { id: 'violet', label: 'Violet' },
  { id: 'neutral', label: 'Neutral' },
];
const cornersOptions = [
  { id: 'square', label: 'Square' },
  { id: 'soft', label: 'Soft' },
  { id: 'rounded', label: 'Rounded' },
];
let accent = $state('emerald');
let corners = $state('soft');
let ready = $state(false);
let storageUnavailable = $state(false);

onMount(() => {
  const root = document.documentElement;
  accent = accents.some((option) => option.id === root.dataset.accent) ? root.dataset.accent! : 'emerald';
  corners = cornersOptions.some((option) => option.id === root.dataset.corners) ? root.dataset.corners! : 'soft';
  ready = true;
});

function apply(nextAccent: string, nextCorners: string) {
  if (!accents.some((option) => option.id === nextAccent) || !cornersOptions.some((option) => option.id === nextCorners)) return;
  accent = nextAccent;
  corners = nextCorners;
  document.documentElement.dataset.accent = accent;
  document.documentElement.dataset.corners = corners;
  try {
    localStorage.setItem('relay.appearance.v1', JSON.stringify({ accent, corners }));
    storageUnavailable = false;
  } catch {
    storageUnavailable = true;
  }
}
</script>

<SettingsSection title="Appearance" description="Changes apply immediately and save automatically on this browser.">
  <SettingRow label="Accent color" description="The color of actions, selections, and focus outlines.">
    <Select.Root type="single" value={accent} onValueChange={(value) => apply(value, corners)} disabled={!ready}>
      <Select.Trigger aria-label="Accent color" class="w-full">{accents.find((option) => option.id === accent)?.label}</Select.Trigger>
      <Select.Content>
        {#each accents as option (option.id)}
          <Select.Item value={option.id} label={option.label} />
        {/each}
      </Select.Content>
    </Select.Root>
  </SettingRow>
  <SettingRow label="Corners" description="The shape of buttons, fields, panels, and dialogs.">
    <Select.Root type="single" value={corners} onValueChange={(value) => apply(accent, value)} disabled={!ready}>
      <Select.Trigger aria-label="Corners" class="w-full">{cornersOptions.find((option) => option.id === corners)?.label}</Select.Trigger>
      <Select.Content>
        {#each cornersOptions as option (option.id)}
          <Select.Item value={option.id} label={option.label} />
        {/each}
      </Select.Content>
    </Select.Root>
  </SettingRow>
  <div class="flex items-center justify-between gap-4 px-4 py-3">
    <p class="text-xs text-muted-foreground" role="status">{storageUnavailable ? 'Applied for now. Browser storage is unavailable, so changes may not survive a reload.' : 'Appearance is personal to this browser.'}</p>
    <Button variant="outline" disabled={!ready} onclick={() => apply('emerald', 'soft')}>Reset appearance</Button>
  </div>
</SettingsSection>
