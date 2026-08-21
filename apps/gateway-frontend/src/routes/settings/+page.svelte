<script lang="ts">
import { toast } from 'svelte-sonner';
import FilterTabs from '$lib/components/app/filter-tabs.svelte';
import PageHeader from '$lib/components/app/page-header.svelte';
import ToolbarButton from '$lib/components/app/toolbar-button.svelte';
import SettingRow from '$lib/components/settings/setting-row.svelte';
import SettingsSection from '$lib/components/settings/settings-section.svelte';
import { Input } from '$lib/components/ui/input';
import * as Select from '$lib/components/ui/select';
import { Switch } from '$lib/components/ui/switch';

/**
 * Settings, as a skeleton.
 *
 * NOTHING HERE IS WIRED. There is no organization_settings table, no API module
 * and no store - every control below is local $state that resets on navigation,
 * and Save only says so. The shape is the deliverable: which settings exist,
 * where they live, and which of them a request header can still override.
 *
 * The organizing idea is that this page is mostly the other half of the `ai-*`
 * header block in chat-completions.schemas.ts. Those headers are per-request
 * with no default anywhere, so an organization that wants "never store prompt
 * bodies" has to edit every call site. Each row that a header overrides names
 * it, which is also what stops the two from drifting apart silently.
 *
 * Tabs rather than one long scroll because the groups have different audiences:
 * Defaults and Policy are the platform team's, Preferences is per-user, and
 * General is read once and never again.
 */

type Tab = 'general' | 'defaults' | 'data' | 'limits' | 'policy' | 'notifications' | 'preferences';

const TABS = [
  { id: 'general' as const, label: 'General' },
  { id: 'defaults' as const, label: 'Defaults' },
  { id: 'data' as const, label: 'Data' },
  { id: 'limits' as const, label: 'Limits' },
  { id: 'policy' as const, label: 'Policy' },
  { id: 'notifications' as const, label: 'Notifications' },
  { id: 'preferences' as const, label: 'Preferences' },
];

let tab: Tab = $state('general');

// Matches the dialogs' field styling - same height, radius and focus ring, so a
// box here and a box in the create-key dialog are the same control.
const FIELD_CLASS =
  'h-8 rounded-[7px] border-line-strong bg-surface-5 px-2.5 text-[12.5px] text-zinc-200 focus-visible:border-emerald-500 focus-visible:ring-[3px] focus-visible:ring-emerald-500/12 dark:bg-surface-5';

const TRIGGER_CLASS =
  'h-8 w-full rounded-[7px] border-line-strong bg-surface-5 px-2.5 text-[12.5px] text-zinc-200 dark:bg-surface-5 dark:hover:bg-surface-6';

/**
 * Placeholder values, grouped by tab.
 *
 * One object per group rather than a flat bag of `let`s, so that the eventual
 * swap for a store is a change of the right-hand side and nothing else.
 */
const org = $state({
  slug: 'acme-platform',
});

const defaults = $state({
  logRequests: true,
  storeRequestBodies: true,
  storeResponseBodies: true,
  timeoutMs: 60_000,
  maxRetries: '2',
  allowCustomBaseUrl: true,
  allowedHosts: '',
});

const data = $state({
  recordRetention: '365 days',
  payloadRetention: '30 days',
});

const limits = $state({
  keyRateLimit: 0,
  keyRateWindow: 60,
  keyExpiry: '90 days',
  monthlyCap: 0,
  alertThreshold: 80,
  onBreach: 'Block requests',
});

const policy = $state({
  onGuardrailError: 'Fail open',
  streamingGuardrails: 'Flag asynchronously',
  unpricedModels: 'Warn',
  blockDeprecated: false,
});

const notifications = $state({
  budgetThreshold: true,
  guardrailBlock: true,
  keyExpiring: true,
  providerErrors: false,
});

const preferences = $state({
  timezone: 'UTC',
  timestamps: 'Relative',
  analyticsRange: 'Last 7 days',
  pageSize: '50',
});

const RETENTION_OPTIONS = ['7 days', '30 days', '90 days', '180 days', '365 days', 'Forever'];
const EXPIRY_OPTIONS = ['30 days', '90 days', '365 days', 'Never'];
const RETRY_OPTIONS = ['0', '1', '2', '3', '5', '10'];

/**
 * The roles from ROLE_SCOPES_MAP in authorization.ts, listed rather than edited.
 *
 * Making this editable is a real feature and probably the most asked-for one on
 * this page, but it is also a security boundary: it needs audit rows and a rule
 * that an organization cannot strip its own last api-keys:write. Showing what
 * the constant already says costs nothing and lies about nothing.
 */
const ROLES = [
  { name: 'admin', grants: 'All 14 scopes' },
  { name: 'user', grants: '7 read scopes + chat-completions:write' },
];

function save() {
  toast.info('Settings are a preview - there is no API behind this page yet.');
}
</script>

<PageHeader title="Settings" description="Organization defaults, data retention, and policy for every request Relay routes.">
	{#snippet actions()}
		<ToolbarButton variant="primary" onclick={save}>Save changes</ToolbarButton>
	{/snippet}
</PageHeader>

<!-- Says it once, at the top, instead of a disabled Save button that leaves the
     reader guessing which parts are real. -->
<div class="mb-[18px] flex items-start gap-2.5 rounded-[9px] border border-amber-500/25 bg-amber-500/[.06] px-3.5 py-3">
	<svg class="mt-px flex-none text-amber-500" width="15" height="15" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.3" stroke="currentColor" stroke-width="1.4" /><path d="M8 4.8v3.6M8 11h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
	<p class="text-[12.5px] leading-[1.55] text-amber-200/70">
		<span class="font-medium text-amber-200">Preview.</span>
		No settings API exists yet, so nothing on this page is read by the gateway or survives a reload. Rows are marked
		with what each one is still waiting on.
	</p>
</div>

<div class="mb-[18px]">
	<FilterTabs tabs={TABS} bind:value={tab} />
</div>

<!-- max-w rather than full bleed: these are label/control pairs, and at 1600px
     a row puts its switch half a screen from the thing it is labelled with. -->
<div class="flex max-w-[880px] flex-col gap-3.5">
	{#if tab === 'general'}
		<SettingsSection
			title="Organization"
			description="Identity is owned by your identity provider. Relay caches it on sign-in and does not sync, so the name here follows whatever the IdP last said."
		>
			<SettingRow label="Name" description="Change this in your identity provider; it updates here at next sign-in." pending="Read-only">
				<span class="text-[12.5px] text-zinc-400">Acme Platform</span>
			</SettingRow>

			<SettingRow label="Slug" description="Used in URLs and as the stable handle for this organization.">
				<Input bind:value={org.slug} class={FIELD_CLASS} />
			</SettingRow>

			<SettingRow label="Organization ID" description="What every log, key and audit row is scoped to." pending="Read-only">
				<span class="font-mono text-[11.5px] text-zinc-500">0199c4a1-…-7f2e</span>
			</SettingRow>

			<SettingRow label="Status" description="Suspension is set by an operator, not from here." pending="Read-only">
				<span class="rounded-[5px] bg-emerald-500/12 px-1.5 py-px text-[11px] font-medium text-emerald-400">active</span>
			</SettingRow>
		</SettingsSection>

		<SettingsSection
			title="Roles and scopes"
			description="Roles arrive as an IdP claim and map to the API's fine-grained scopes. The mapping is a constant in the backend today - making it editable needs audit coverage and a lockout guard first."
		>
			{#each ROLES as role (role.name)}
				<SettingRow label={role.name} description={role.grants} pending="Hard-coded">
					<span class="text-[12.5px] text-zinc-600">authorization.ts</span>
				</SettingRow>
			{/each}
		</SettingsSection>
	{:else if tab === 'defaults'}
		<SettingsSection
			title="Logging"
			description="What Relay records for a request that says nothing about it. Any request can still override these per call with the header shown beside each row."
		>
			<SettingRow
				label="Record requests"
				description="Off writes no log row at all - no cost, no latency, no trace. Analytics and spend go blank for anything routed this way."
				header="ai-log-skip"
				pending="Not wired"
			>
				<Switch bind:checked={defaults.logRequests} />
			</SettingRow>

			<SettingRow
				label="Store request bodies"
				description="Prompts are written to object storage and are the most sensitive data Relay holds. Off keeps the log row and its costs, and drops the payload."
				header="ai-log-omit-request"
				pending="Not wired"
			>
				<Switch bind:checked={defaults.storeRequestBodies} />
			</SettingRow>

			<SettingRow
				label="Store response bodies"
				description="The completion side of the same exchange, stored and omitted independently."
				header="ai-log-omit-response"
				pending="Not wired"
			>
				<Switch bind:checked={defaults.storeResponseBodies} />
			</SettingRow>
		</SettingsSection>

		<SettingsSection title="Delivery" description="How Relay calls the upstream provider when a request does not say.">
			<SettingRow label="Request timeout" description="Milliseconds to wait on the provider before giving up." header="ai-timeout-ms" pending="Not wired">
				<Input type="number" bind:value={defaults.timeoutMs} class={FIELD_CLASS} />
			</SettingRow>

			<SettingRow label="Max retries" description="Attempts after the first. Capped at 10 per request today." header="ai-max-retries" pending="Not wired">
				<Select.Root type="single" bind:value={defaults.maxRetries}>
					<Select.Trigger class={TRIGGER_CLASS}>{defaults.maxRetries}</Select.Trigger>
					<Select.Content>
						{#each RETRY_OPTIONS as option (option)}
							<Select.Item value={option} label={option} />
						{/each}
					</Select.Content>
				</Select.Root>
			</SettingRow>

			<SettingRow
				label="Allow custom base URLs"
				description="A caller can name any host to forward to, and its provider credential goes with it. Fine for BYOK development, an exfiltration path for a managed organization."
				header="ai-base-url"
				pending="Not enforced"
			>
				<Switch bind:checked={defaults.allowCustomBaseUrl} />
			</SettingRow>

			<SettingRow label="Allowed hosts" description="Comma-separated. Empty means any host, which is what the gateway does now." pending="Not enforced">
				<Input bind:value={defaults.allowedHosts} placeholder="api.openai.com, …" class={FIELD_CLASS} />
			</SettingRow>
		</SettingsSection>
	{:else if tab === 'data'}
		<SettingsSection
			title="Retention"
			description="Nothing prunes anything today - both of these grow without bound. The two halves are separate on purpose: cost history is small and worth keeping for a year, while the payloads it refers to are neither."
		>
			<SettingRow
				label="Log records"
				description="The row itself: model, tokens, cost, latency, tags. What analytics and spend are computed from."
				pending="Needs a prune worker"
			>
				<Select.Root type="single" bind:value={data.recordRetention}>
					<Select.Trigger class={TRIGGER_CLASS}>{data.recordRetention}</Select.Trigger>
					<Select.Content>
						{#each RETENTION_OPTIONS as option (option)}
							<Select.Item value={option} label={option} />
						{/each}
					</Select.Content>
				</Select.Root>
			</SettingRow>

			<SettingRow
				label="Stored payloads"
				description="The prompt and completion objects in storage. Deleting these leaves the log row intact, so spend history survives a short retention window."
				pending="Needs a prune worker"
			>
				<Select.Root type="single" bind:value={data.payloadRetention}>
					<Select.Trigger class={TRIGGER_CLASS}>{data.payloadRetention}</Select.Trigger>
					<Select.Content>
						{#each RETENTION_OPTIONS as option (option)}
							<Select.Item value={option} label={option} />
						{/each}
					</Select.Content>
				</Select.Root>
			</SettingRow>
		</SettingsSection>

		<SettingsSection title="Erasure" description="One-shot deletions, for a subject request or an incident. Audit-logged when they exist.">
			<SettingRow label="Delete all stored payloads" description="Drops every prompt and completion object for this organization. Log rows and costs stay." pending="Not wired">
				<ToolbarButton onclick={save}>Delete payloads</ToolbarButton>
			</SettingRow>
		</SettingsSection>
	{:else if tab === 'limits'}
		<SettingsSection
			title="New API keys"
			description="Applied at creation and editable per key afterwards. Keys are created unlimited and non-expiring today, which is rarely what anyone means."
		>
			<SettingRow label="Default rate limit" description="Requests per window. Zero means unlimited." pending="Not wired">
				<Input type="number" bind:value={limits.keyRateLimit} class={FIELD_CLASS} />
			</SettingRow>

			<SettingRow label="Default window" description="Seconds the limit above is counted over." pending="Not wired">
				<Input type="number" bind:value={limits.keyRateWindow} class={FIELD_CLASS} />
			</SettingRow>

			<SettingRow label="Default expiry" description="How long a newly created key lives before it stops authenticating." pending="Not wired">
				<Select.Root type="single" bind:value={limits.keyExpiry}>
					<Select.Trigger class={TRIGGER_CLASS}>{limits.keyExpiry}</Select.Trigger>
					<Select.Content>
						{#each EXPIRY_OPTIONS as option (option)}
							<Select.Item value={option} label={option} />
						{/each}
					</Select.Content>
				</Select.Root>
			</SettingRow>
		</SettingsSection>

		<SettingsSection
			title="Budget"
			description="An organization-wide ceiling on provider spend. Enforcing this needs cost reservation before dispatch, so that concurrent requests cannot all pass the same check."
		>
			<SettingRow label="Monthly cap" description="US dollars. Zero means no cap." pending="Phase 3">
				<Input type="number" bind:value={limits.monthlyCap} class={FIELD_CLASS} />
			</SettingRow>

			<SettingRow label="Alert threshold" description="Percent of the cap that fires a notification." pending="Phase 3">
				<Input type="number" bind:value={limits.alertThreshold} class={FIELD_CLASS} />
			</SettingRow>

			<SettingRow label="When the cap is reached" description="Whether spend past the cap is refused or merely recorded." pending="Phase 3">
				<Select.Root type="single" bind:value={limits.onBreach}>
					<Select.Trigger class={TRIGGER_CLASS}>{limits.onBreach}</Select.Trigger>
					<Select.Content>
						<Select.Item value="Block requests" label="Block requests" />
						<Select.Item value="Alert only" label="Alert only" />
					</Select.Content>
				</Select.Root>
			</SettingRow>
		</SettingsSection>
	{:else if tab === 'policy'}
		<SettingsSection
			title="Guardrails"
			description="Individual rules live on the Guardrails page. These are the organization-wide decisions that page has nowhere to put."
		>
			<SettingRow
				label="If a guardrail fails to evaluate"
				description="Fail open lets the request through when a rule errors; fail closed refuses it. There is no safe default - the answer depends on whether the rule is a filter or a control."
				pending="Needs enforcement"
			>
				<Select.Root type="single" bind:value={policy.onGuardrailError}>
					<Select.Trigger class={TRIGGER_CLASS}>{policy.onGuardrailError}</Select.Trigger>
					<Select.Content>
						<Select.Item value="Fail open" label="Fail open" />
						<Select.Item value="Fail closed" label="Fail closed" />
					</Select.Content>
				</Select.Root>
			</SettingRow>

			<SettingRow
				label="Streaming responses"
				description="A streamed response cannot be blocked without buffering it first, which costs the latency streaming was for. The alternative is flagging after the fact, which does not stop delivery."
				pending="Needs enforcement"
			>
				<Select.Root type="single" bind:value={policy.streamingGuardrails}>
					<Select.Trigger class={TRIGGER_CLASS}>{policy.streamingGuardrails}</Select.Trigger>
					<Select.Content>
						<Select.Item value="Flag asynchronously" label="Flag asynchronously" />
						<Select.Item value="Buffer and block" label="Buffer and block" />
					</Select.Content>
				</Select.Root>
			</SettingRow>
		</SettingsSection>

		<SettingsSection title="Models" description="What the catalogue is allowed to route to, above whatever each model row says.">
			<SettingRow
				label="Models with no published price"
				description="Four of OpenAI's models publish no price at all. Unpriced is not free, and this decides whether it is spendable."
				pending="Needs cost accounting"
			>
				<Select.Root type="single" bind:value={policy.unpricedModels}>
					<Select.Trigger class={TRIGGER_CLASS}>{policy.unpricedModels}</Select.Trigger>
					<Select.Content>
						<Select.Item value="Allow" label="Allow" />
						<Select.Item value="Warn" label="Warn" />
						<Select.Item value="Block" label="Block" />
					</Select.Content>
				</Select.Root>
			</SettingRow>

			<SettingRow label="Block deprecated models" description="Refuse any model the catalogue marks deprecated or has delisted upstream." pending="Not wired">
				<Switch bind:checked={policy.blockDeprecated} />
			</SettingRow>
		</SettingsSection>
	{:else if tab === 'notifications'}
		<SettingsSection
			title="Events"
			description="Which events are worth interrupting someone for. Delivery reuses the webhook endpoints configured on the Webhooks page - this is when to fire, not where to."
		>
			<SettingRow label="Budget threshold reached" description="Fires once per period when spend crosses the alert threshold." pending="Not wired">
				<Switch bind:checked={notifications.budgetThreshold} />
			</SettingRow>

			<SettingRow label="Guardrail blocked a request" description="A blocking rule refused a request before it reached a provider." pending="Not wired">
				<Switch bind:checked={notifications.guardrailBlock} />
			</SettingRow>

			<SettingRow label="API key expiring" description="Seven days before a key stops authenticating." pending="Not wired">
				<Switch bind:checked={notifications.keyExpiring} />
			</SettingRow>

			<SettingRow label="Provider error rate" description="Sustained upstream failures for a provider this organization routes to." pending="Not wired">
				<Switch bind:checked={notifications.providerErrors} />
			</SettingRow>
		</SettingsSection>
	{:else}
		<SettingsSection
			title="Display"
			description="Yours alone, not the organization's. These belong in local storage or on the user row rather than in organization settings."
		>
			<SettingRow label="Timezone" description="Every stored timestamp carries a zone; this is only how the dashboard renders them." pending="Not wired">
				<Select.Root type="single" bind:value={preferences.timezone}>
					<Select.Trigger class={TRIGGER_CLASS}>{preferences.timezone}</Select.Trigger>
					<Select.Content>
						<Select.Item value="UTC" label="UTC" />
						<Select.Item value="Local" label="Local" />
					</Select.Content>
				</Select.Root>
			</SettingRow>

			<SettingRow label="Timestamps" description="Relative reads better while tailing; absolute is what you want when comparing against another system's logs." pending="Not wired">
				<Select.Root type="single" bind:value={preferences.timestamps}>
					<Select.Trigger class={TRIGGER_CLASS}>{preferences.timestamps}</Select.Trigger>
					<Select.Content>
						<Select.Item value="Relative" label="Relative" />
						<Select.Item value="Absolute" label="Absolute" />
					</Select.Content>
				</Select.Root>
			</SettingRow>

			<SettingRow label="Default analytics range" description="What the Analytics page opens on." pending="Not wired">
				<Select.Root type="single" bind:value={preferences.analyticsRange}>
					<Select.Trigger class={TRIGGER_CLASS}>{preferences.analyticsRange}</Select.Trigger>
					<Select.Content>
						<Select.Item value="Last 24 hours" label="Last 24 hours" />
						<Select.Item value="Last 7 days" label="Last 7 days" />
						<Select.Item value="Last 30 days" label="Last 30 days" />
					</Select.Content>
				</Select.Root>
			</SettingRow>

			<SettingRow label="Rows per page" description="Applies to logs, audit and delivery tables." pending="Not wired">
				<Select.Root type="single" bind:value={preferences.pageSize}>
					<Select.Trigger class={TRIGGER_CLASS}>{preferences.pageSize}</Select.Trigger>
					<Select.Content>
						{#each ['20', '50', '100'] as option (option)}
							<Select.Item value={option} label={option} />
						{/each}
					</Select.Content>
				</Select.Root>
			</SettingRow>
		</SettingsSection>
	{/if}
</div>
