#!/usr/bin/env node
'use strict';
/**
 * bin/briefing.js — run the daily briefing from outside the service.
 *
 * The service already ticks hourly on its own, so this is the operator's handle
 * rather than the primary path: it is what a cron entry or a manual run calls,
 * and it is how you rehearse the copy without sending anything.
 *
 * It is safe to run at any time and safe to run twice — checkin.run() consults
 * the store, not the clock, so the once-a-day cap holds regardless of what
 * triggered it.
 *
 *   node bin/briefing.js            send today's briefing if it hasn't gone out
 *   node bin/briefing.js --dry-run  compose and print it, send nothing
 *   node bin/briefing.js --force    send even if today's has already gone
 */
const { load } = require('../lib/config');
const { Store } = require('../lib/store');
const briefing = require('../lib/briefing');

async function main() {
  const args = process.argv.slice(2);
  const cfg = load();
  const store = new Store(cfg.dataDir).load();

  const out = await briefing.run(store, cfg, {
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
  });

  console.log(JSON.stringify(out, null, 2));
  // Non-zero only on a real failure; 'already-sent' is a correct, quiet outcome.
  process.exit(out.status === 'error' ? 1 : 0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
