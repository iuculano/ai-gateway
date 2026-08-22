<script lang="ts">
import '../app.css';
import favicon from '$lib/assets/favicon.svg';
import Sidebar from '$lib/components/app/sidebar.svelte';
import Topbar from '$lib/components/app/topbar.svelte';
import { Toaster } from '$lib/components/ui/sonner';

let { children, data } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Relay · AI Gateway</title>
</svelte:head>

<div class="flex h-screen w-full overflow-hidden">
	<Sidebar user={data.user} />
	<div class="flex min-w-0 flex-1 flex-col">
		<Topbar />
		<main class="flex-1 overflow-auto [scrollbar-gutter:stable] px-8 pt-[26px] pb-[60px]">
			{@render children()}
		</main>
	</div>
</div>

<Toaster theme="dark" position="bottom-center" />
