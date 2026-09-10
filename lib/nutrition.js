'use strict';
/**
 * nutrition.js — the nutrition payload shape, and where the numbers come from.
 *
 * The build package's Decision 10 named SnapCalorie's /analysis endpoint as the
 * nutrition engine, with an explicit fallback: "if the API is unavailable, log
 * the meal with Claude's estimate flagged as estimate." The owner descoped
 * SnapCalorie on 2026-09-10, so v1 runs entirely on that fallback path — the
 * behaviour was already specified, it is simply now the only path.
 *
 * What that costs us is precision, not structure. This module still normalises
 * every entry into one canonical shape with a `source` stamp, so that:
 *   - the chat page can honestly badge every figure as an estimate,
 *   - a real engine can be introduced later without a schema migration, and
 *   - old rows stay truthful about where their numbers came from.
 *
 * Fields beyond the macros (fibre, sugars, added sugars, sodium, ultra-processed)
 * are kept because F6/F8 want the full payload retained for future coaches, even
 * though v1's own coaching replies mostly lean on calories and protein.
 */

const NUMERIC_FIELDS = [
  'calories_kcal',
  'protein_g',
  'carb_g',
  'fat_g',
  'saturated_fat_g',
  'fiber_g',
  'sugar_g',
  'added_sugar_g',
  'sodium_mg',
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/** Normalise one nutrition object into the canonical shape. Unknown -> null. */
function normalise(raw = {}) {
  const out = {};
  for (const f of NUMERIC_FIELDS) out[f] = num(raw[f]);
  out.ultra_processed = typeof raw.ultra_processed === 'boolean' ? raw.ultra_processed : null;
  return out;
}

/** Sum a list of per-item nutrition objects into a meal total. */
function total(items = []) {
  const sum = {};
  for (const f of NUMERIC_FIELDS) {
    let acc = null;
    for (const it of items) {
      const v = num(it?.nutrition?.[f]);
      if (v === null) continue;
      acc = (acc === null ? 0 : acc) + v;
    }
    sum[f] = acc === null ? null : Math.round(acc * 10) / 10;
  }
  // A meal counts as ultra-processed if any item is; unknown if nothing said.
  const flags = items.map((it) => it?.nutrition?.ultra_processed).filter((v) => typeof v === 'boolean');
  sum.ultra_processed = flags.length ? flags.some(Boolean) : null;
  return sum;
}

/**
 * Build the stored nutrition block for a meal parsed by the coach.
 * `engine` comes from config; only 'estimate' is wired in v1.
 */
function build(items, engine) {
  const cleanItems = (items || []).map((it) => ({
    name: String(it.name || '').slice(0, 200),
    brand: it.brand ? String(it.brand).slice(0, 120) : null,
    quantity: it.quantity ? String(it.quantity).slice(0, 80) : null,
    nutrition: normalise(it.nutrition),
  }));

  return {
    items: cleanItems,
    nutrition: total(cleanItems),
    source: engine === 'estimate' ? 'claude-estimate' : String(engine),
    estimate: true, // v1 has no measured source; every figure is an estimate
  };
}

/** One-line provenance note the chat page and check-in can show verbatim. */
function provenanceLabel(source) {
  return source === 'claude-estimate' ? 'estimated' : String(source || 'unknown');
}

module.exports = { normalise, total, build, provenanceLabel, NUMERIC_FIELDS };
