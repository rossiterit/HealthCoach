#!/usr/bin/env node
'use strict';
/**
 * kroger-locations.js — find the owner's King Soopers, once.
 *
 *   node bin/kroger-locations.js [zip]
 *
 * Decision 8 puts the preferred store id in config rather than letting the app
 * pick one, because "which shop" is the owner's call and a silently-chosen
 * store would price the whole list against somewhere they never go. This prints
 * the candidates and their ids; the owner (or the builder) pastes one into
 * config.json under kroger.locationId.
 *
 * Uses the client-credentials token, so it works before the one-time OAuth
 * authorisation — finding a store needs no access to anyone's cart.
 */
const path = require('path');

const { load } = require(path.join(__dirname, '..', 'lib', 'config'));
const kroger = require(path.join(__dirname, '..', 'lib', 'kroger'));

(async () => {
  const cfg = load();
  const zip = process.argv[2] || cfg.kroger.zip;

  if (!zip) {
    console.error('Give me a five-digit zip: node bin/kroger-locations.js 80010');
    process.exit(2);
  }
  if (!kroger.configured(cfg)) {
    // Says what is wrong without naming a path or a value.
    console.error(kroger.unavailableReason(cfg));
    process.exit(1);
  }

  const out = await kroger.findLocations(cfg, zip);
  if (out.error) {
    console.error(out.error);
    process.exit(1);
  }
  if (!out.locations.length) {
    console.log(`No King Soopers found near ${zip}.`);
    return;
  }

  console.log(`King Soopers near ${zip}:\n`);
  for (const l of out.locations) {
    console.log(`  ${l.locationId}  ${l.name}`);
    if (l.address) console.log(`  ${' '.repeat(l.locationId.length)}  ${l.address}`);
  }
  console.log('\nPaste the one you use into config.json under kroger.locationId.');
})().catch((e) => {
  // Scrubbed: a thrown network error can carry a URL, and a URL can carry auth.
  console.error('Store lookup failed:', kroger.scrub(e.message, load()));
  process.exit(1);
});
