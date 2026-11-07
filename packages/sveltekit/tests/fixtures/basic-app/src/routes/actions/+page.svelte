<script lang="ts">
  let { data, form } = $props<{ data: { message: string }; form?: { message: string; audited: boolean } }>();
</script>

<main>
  <h1>{data.message}</h1>
  <form method="POST"><button type="submit">Run server action</button></form>
  {#if form}<p>{form.message} — audit: {String(form.audited)}</p>{/if}
</main>
