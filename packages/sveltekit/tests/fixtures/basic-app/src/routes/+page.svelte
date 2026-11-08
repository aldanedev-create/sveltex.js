<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>SvelteX fixture</title></svelte:head>
<main><h1>{data.message}</h1></main>
