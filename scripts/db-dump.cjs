#!/usr/bin/env node
/**
 * Offline backup helper — dumps critical tables from the live Supabase project
 * to a timestamped JSON file. Run on a cron (e.g. daily) and ship the output
 * to S3/R2 for offsite retention.
 *
 * Usage:
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=<service_role> \
 *   node scripts/db-dump.cjs ./backups
 *
 * Supabase already offers PITR + daily backups on the Pro tier; this script is
 * a belt-and-suspenders second copy that you control. It does NOT replace
 * Supabase's first-party backup — review the Dashboard → Database → Backups.
 */

const fs = require('node:fs');
const path = require('node:path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = process.argv[2] ?? './backups';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}

const TABLES = [
  // Tenancy + auth
  'restaurants', 'branches', 'brands', 'staff_members', 'subscriptions',
  // Menu
  'menu_categories', 'menu_items', 'modifier_groups', 'modifier_options',
  'menu_item_modifiers', 'combo_sets', 'combo_items',
  // Orders + payments
  'orders', 'order_items', 'payments', 'tax_invoices',
  // Customers + loyalty
  'customers', 'customer_addresses', 'loyalty_points', 'loyalty_transactions',
  // Drivers + delivery
  'drivers', 'driver_approvals', 'driver_schedules', 'deliveries',
  // Operations
  'reservations', 'tables', 'broadcasts',
  // Franchise
  'franchise_groups', 'franchise_menu_locks',
];

async function fetchAll(table) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) {
      throw new Error(`${table}: ${res.status} ${await res.text()}`);
    }
    const chunk = await res.json();
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

(async () => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(OUT_DIR, `dump-${ts}`);
  fs.mkdirSync(out, { recursive: true });

  const summary = {};
  for (const table of TABLES) {
    try {
      const rows = await fetchAll(table);
      fs.writeFileSync(path.join(out, `${table}.json`), JSON.stringify(rows, null, 2));
      summary[table] = rows.length;
      console.log(`✓ ${table}: ${rows.length} rows`);
    } catch (err) {
      console.error(`✗ ${table}:`, err.message);
      summary[table] = `ERR: ${err.message}`;
    }
  }
  fs.writeFileSync(path.join(out, '_summary.json'), JSON.stringify({ ts, summary }, null, 2));
  console.log(`Wrote ${Object.keys(summary).length} files to ${out}`);
})();
