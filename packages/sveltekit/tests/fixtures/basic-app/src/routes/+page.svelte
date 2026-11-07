<script lang="ts">
  let { data } = $props<{ data: { message: string } }>();
</script>

<svelte:head><title>SvelteX fixture</title></svelte:head>
<main><h1>{data.message}</h1></main>
