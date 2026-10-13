<script lang="ts">
  let { policy }: { policy: unknown } = $props();
  const engineReference =
    'https://github.com/sakuraiyuta/kaoiro/blob/develop/' +
    'docs/reference/engines/grok-acp.md';
  const details = $derived.by(() => {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      return null;
    }
    const p = policy as Record<string, unknown>;
    const common = {
      profile: typeof p.grok_sandbox_env === 'string'
        ? p.grok_sandbox_env : 'unknown',
      version: typeof p.grok_version === 'string' ? p.grok_version : 'unknown',
    };
    const hooks = p.claude_hooks as Record<string, unknown> | undefined;
    if (
      p.inspect !== 'ok' || !Array.isArray(p.sources) ||
      !p.sources.every(s => typeof s === 'string') ||
      typeof p.managed_settings_active !== 'boolean' ||
      typeof p.rules_loaded !== 'number' ||
      typeof p.rules_skipped !== 'number' ||
      !hooks || typeof hooks.enabled !== 'boolean' ||
      typeof hooks.source !== 'string'
    ) {
      return { ...common, observed: null };
    }
    return {
      ...common,
      observed: {
        sources: p.sources as string[],
        managed: p.managed_settings_active,
        loaded: p.rules_loaded,
        skipped: p.rules_skipped,
        hooks: hooks.enabled,
        hooksSource: hooks.source,
      },
    };
  });
</script>

<div class="grok-permission-policy">
  <p>Approval decisions are made by grok from the Claude settings it loads;
    kaoiro receives the requests grok sends.</p>
  {#if details?.observed}
    <p>Sources: {details.observed.sources.join(', ') || 'none'}</p>
    <p>Managed settings: {String(details.observed.managed)};
      rules loaded: {details.observed.loaded};
      skipped: {details.observed.skipped}</p>
    <p>Claude hooks: {String(details.observed.hooks)}
      ({details.observed.hooksSource})</p>
  {:else}
    <p>permission sources unknown</p>
  {/if}
  <p>Sandbox profile: {details?.profile ?? 'unknown'};
    version: {details?.version ?? 'unknown'}</p>
  <a href={engineReference} target="_blank" rel="noreferrer">
    Grok engine reference
  </a>
</div>
