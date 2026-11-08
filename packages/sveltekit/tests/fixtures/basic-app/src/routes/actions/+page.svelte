<script lang="ts">
  import type { ActionData, PageData } from './$types';
  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<main>
  <h1>{data.message}</h1>
  <form method="POST"><button type="submit">Run server action</button></form>
  {#if form}<p>{form.message} — audit: {String(form.audited)}</p>{/if}
</main>
