// integration-sync — runs queued sync_jobs against external partner APIs.
//
// This is a SCAFFOLD: the heavy provider logic is deliberately deferred until
// the operator has signed up with each partner and pasted credentials into
// `integrations.config`. Each branch case below logs what it would do and
// returns success so the queue drains.
//
// Suggested cron: every 5 minutes (configure in Supabase Dashboard or here).

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { loadEntitlements } from '../_shared/entitlements.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: jobs, error } = await admin
    .from('sync_jobs')
    .select('id, integration_id, kind, payload, attempts, integrations(provider, config, branch_id, is_active)')
    .eq('status', 'queued')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(20);
  if (error) return json(500, { error: error.message });

  let ok = 0;
  let failed = 0;
  let skipped = 0;

  // One entitlement lookup per branch, not per job — a drain batch is usually
  // many jobs for a handful of branches.
  const entCache = new Map<string, boolean>();
  async function branchEntitled(branchId: string): Promise<boolean> {
    const hit = entCache.get(branchId);
    if (hit !== undefined) return hit;
    const ent = await loadEntitlements(admin, { branchId });
    entCache.set(branchId, ent.entitled);
    return ent.entitled;
  }

  for (const job of jobs ?? []) {
    // deno-lint-ignore no-explicit-any
    const j = job as any;
    const integration = Array.isArray(j.integrations) ? j.integrations[0] : j.integrations;
    if (!integration?.is_active) {
      await admin.from('sync_jobs').update({ status: 'failed', last_error: 'integration_inactive', finished_at: new Date().toISOString() }).eq('id', j.id);
      failed++;
      continue;
    }
    // A suspended tenant's jobs stay queued rather than failing — nothing is lost,
    // and the drain picks them up the moment billing is restored. `scheduled_for`
    // is pushed out so a large suspended backlog cannot starve paying tenants of
    // the 20-job window.
    if (!(await branchEntitled(integration.branch_id))) {
      await admin.from('sync_jobs').update({
        last_error: 'billing_inactive',
        scheduled_for: new Date(Date.now() + 60 * 60_000).toISOString(),
      }).eq('id', j.id);
      skipped++;
      continue;
    }
    await admin.from('sync_jobs').update({ status: 'running', started_at: new Date().toISOString(), attempts: j.attempts + 1 }).eq('id', j.id);
    try {
      const result = await runJob(integration.provider, integration.config, j.kind, j.payload, integration.branch_id);
      await admin.from('sync_jobs').update({ status: 'done', result, finished_at: new Date().toISOString() }).eq('id', j.id);
      await admin.from('integrations').update({ last_synced_at: new Date().toISOString(), last_error: null }).eq('id', integration.id ?? j.integration_id);
      ok++;
    } catch (err) {
      const msg = (err as Error).message ?? 'unknown';
      await admin.from('sync_jobs').update({ status: 'failed', last_error: msg, finished_at: new Date().toISOString() }).eq('id', j.id);
      await admin.from('integrations').update({ last_error: msg }).eq('id', integration.id ?? j.integration_id);
      failed++;
    }
  }

  return json(200, { ok, failed, skipped, processed: (jobs ?? []).length });
});

async function runJob(
  provider: string,
  config: Record<string, unknown>,
  kind: string,
  _payload: Record<string, unknown>,
  _branchId: string,
): Promise<Record<string, unknown>> {
  // STUB: in a real impl, each provider gets its own client.
  // To enable a provider, paste credentials into `integrations.config` and
  // replace this switch with a real fetch to the provider's REST API.
  switch (provider) {
    case 'doordash':
    case 'ubereats':
    case 'grubhub':
      if (!config.api_key) throw new Error(`${provider}_missing_api_key`);
      return { provider, kind, note: 'stub — wire partner API client here' };
    case 'quickbooks':
    case 'xero':
      if (!config.refresh_token) throw new Error(`${provider}_missing_refresh_token`);
      return { provider, kind, note: 'stub — call OAuth refresh + push invoices' };
    case 'google_business':
    case 'yelp':
    case 'tripadvisor':
      if (!config.api_key && !config.account_id) throw new Error(`${provider}_missing_credentials`);
      return { provider, kind, note: 'stub — fetch reviews / update hours' };
    case 'mailchimp':
    case 'klaviyo':
      if (!config.api_key) throw new Error(`${provider}_missing_api_key`);
      return { provider, kind, note: 'stub — sync customer list' };
    case 'slack':
    case 'discord':
      if (!config.webhook_url) throw new Error(`${provider}_missing_webhook`);
      return { provider, kind, note: 'stub — post to channel' };
    default:
      throw new Error(`unknown_provider:${provider}`);
  }
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
