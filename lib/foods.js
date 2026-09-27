'use strict';
/**
 * foods.js — the owner's food library (v3 F1, GOTK-164).
 *
 * Decision 2: "Search = the Claude-built food library." Search matches the
 * owner's OWN library first; on a miss, DietCoach estimates the item, flags the
 * estimate, and saves it — so the library grows from use rather than shipping
 * pre-loaded. There is no external nutrition API here and no code path that
 * reaches one; that is Decision 2's second half and v3's governance line both.
 *
 * Why ranking rather than a plain substring filter: the library is the owner's
 * own vocabulary, so it stays small and personal ("porridge", "the good yoghurt",
 * "Friday curry"). With a hundred-odd rows, what matters is that typing three
 * letters puts the thing they meant at the top, not that the search is clever.
 * Exact beats prefix beats word-start beats substring, and ties break on the
 * shorter name — because "eggs" should outrank "eggs benedict" for the query
 * "eggs", and length is the only honest signal of that we have.
 *
 * On flagging: every row is an estimate and `estimate` is hard-wired true in the
 * store. This module never computes confidence, never grades its own guesses,
 * and never presents a figure as measured. v1 Decision 10's fallback clause is
 * the whole of our provenance story and it should stay visibly so.
 */
const claude = require('./claude');
const nutritionLib = require('./nutrition');

/** Normalise for matching: case, punctuation and runs of space all collapse. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Score a library row against a query. Higher is better; 0 means no match at
 * all. Deliberately a small integer ladder rather than a similarity metric —
 * it is inspectable, and a test can assert the ordering it produces.
 */
function score(name, q) {
  const n = norm(name);
  if (!n || !q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  // A word inside the name starting with the query: "curry" finds "Friday curry".
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) return 60;
  if (n.includes(q)) return 40;
  // Every query word appears somewhere: "chicken rice" finds "rice with chicken".
  const words = q.split(' ').filter(Boolean);
  if (words.length > 1 && words.every((w) => n.includes(w))) return 30;
  // Weakest tier: the query and the name merely share a word. This exists to
  // stop the library filling with near-duplicates — someone typing "eggs
  // florentine" should see the "Eggs Benedict" they already have before they
  // add a third eggs row. It ranks below everything else on purpose, and a
  // shared word is never treated as a hit: `miss` is still true, so the offer
  // to create the thing they actually typed stands.
  if (words.some((w) => w.length > 2 && new RegExp(`\\b${w}`).test(n))) return 10;
  return 0;
}

/**
 * Search the library. Returns ranked rows plus whether the query looks like a
 * miss — which is what the page uses to offer "add this", and what decides
 * whether create-on-miss runs.
 */
function search(store, query, { limit = 20 } = {}) {
  const q = norm(query);
  if (!q) return { query: String(query || ''), results: [], exact: null, miss: false };

  const ranked = store
    .libraryItems()
    .map((f) => ({ food: f, s: score(f.name, q) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.food.name.length - b.food.name.length || a.food.name.localeCompare(b.food.name))
    .slice(0, limit)
    .map((r) => r.food);

  const exact = store.libraryItems().find((f) => norm(f.name) === q) || null;
  return {
    query: String(query),
    results: ranked,
    exact,
    // A miss is "nothing in the library is this thing" — not "no results".
    // A query that returns near-matches can still be a miss, which is exactly
    // the case where the owner wants to add the new thing they typed.
    miss: !exact,
  };
}

// ---------------------------------------------------------------------------
// create-on-miss
// ---------------------------------------------------------------------------

const ESTIMATE_TOOL = {
  name: 'record_food_estimate',
  description: 'Return your best nutrition estimate for one food or composed meal, as a typical single serving.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The item, tidied to a short library name. Keep the owner\'s wording.' },
      kind: { type: 'string', enum: ['food', 'meal'], description: '"meal" for a composed dish, "food" for a single ingredient or product.' },
      quantity: { type: 'string', description: 'The serving these figures describe, e.g. "1 bowl (300g)", "2 slices".' },
      nutrition: {
        type: 'object',
        properties: {
          calories_kcal: { type: 'number' },
          protein_g: { type: 'number' },
          carb_g: { type: 'number' },
          fat_g: { type: 'number' },
          saturated_fat_g: { type: 'number' },
          fiber_g: { type: 'number' },
          sugar_g: { type: 'number' },
          added_sugar_g: { type: 'number' },
          sodium_mg: { type: 'number' },
          ultra_processed: { type: 'boolean' },
        },
      },
    },
    required: ['name', 'quantity', 'nutrition'],
  },
};

const ESTIMATE_SYSTEM = `You estimate nutrition for one food at a time, for a private food library.

- Give figures for a TYPICAL SINGLE SERVING and say in the quantity field what serving you assumed. The owner can correct it, and they will if the serving is not theirs.
- Estimate honestly. Omit any field you genuinely cannot put a number on rather than inventing one; a missing figure is more useful than a confident wrong one.
- These are estimates and the app labels them as such everywhere. Do not add caveats, disclaimers, or any comment on whether the food is a good or bad choice — nothing you return is shown as advice, and this app never moralises about food.
- Call record_food_estimate exactly once. Do not reply with prose.`;

/**
 * Ask Claude for an estimate of one item. Returns the shape addFood wants.
 * Throws if the model will not produce a structured answer — the caller turns
 * that into a plain "couldn't estimate that" rather than saving a blank row,
 * because a library row with no figures is worse than no row.
 */
async function estimate(cfg, name) {
  const res = await claude.complete(cfg, {
    system: ESTIMATE_SYSTEM,
    messages: [{ role: 'user', content: `Estimate nutrition for: ${name}` }],
    tools: [ESTIMATE_TOOL],
  });

  const call = claude.toolUsesOf(res).find((t) => t.name === ESTIMATE_TOOL.name);
  if (!call || !call.input) throw new Error(`No estimate came back for "${name}".`);

  const input = call.input;
  return {
    name: String(input.name || name).slice(0, 200),
    kind: input.kind === 'meal' ? 'meal' : 'food',
    quantity: input.quantity ? String(input.quantity).slice(0, 80) : null,
    nutrition: nutritionLib.normalise(input.nutrition),
    source: 'claude-estimate',
  };
}

/**
 * Search, and create the item if the library does not already have it.
 * The create half is the only thing in v3 that calls the model outside a
 * conversational turn, and it still writes nowhere but this app's own store.
 */
async function findOrCreate(store, cfg, name) {
  const hit = search(store, name, { limit: 1 });
  // A recipe is a library item and so can match here, but it is not a valid
  // INGREDIENT: a recipe's macros are per-serving and computed from its own
  // rows, and nesting one inside another needs serving maths v4 does not have.
  // So only a plain food satisfies this; anything else creates a food.
  if (hit.exact && hit.exact.kind !== 'recipe') return { food: hit.exact, created: false };
  const drafted = await estimate(cfg, name);
  return { food: store.addFood(drafted), created: true };
}

// ---------------------------------------------------------------------------
// proposing a recipe row's serving multiplier (v4, owner refinement 2026-09-27)
// ---------------------------------------------------------------------------

const AMOUNT_TOOL = {
  name: 'record_serving_multiple',
  description: "Say how many of a library item's servings a recipe quantity represents.",
  input_schema: {
    type: 'object',
    properties: {
      amount: {
        type: 'number',
        description: 'The multiple. 200 g against a 40 g serving is 5. Half a serving is 0.5.',
      },
      reasoning: { type: 'string', description: 'One short clause, e.g. "200 g against a 40 g serving".' },
      confident: {
        type: 'boolean',
        description: 'False when the recipe quantity and the library serving cannot honestly be compared.',
      },
    },
    required: ['amount', 'confident'],
  },
};

const AMOUNT_SYSTEM = `You convert a recipe's ingredient quantity into a multiple of that ingredient's stored library serving.

You are given the library item's serving (for example "1 bowl (40 g)") and the quantity the recipe asks for (for example "200 g"). Answer with how many of that serving the recipe quantity is — here, 5.

- Compare like with like. If both are weights, divide. If the recipe says "2 cans" and the serving is "1 can (400 g)", the answer is 2.
- If the two genuinely cannot be compared — "a splash" against "100 ml", or a bare count against a weight with no hint of size — return your best single guess and set confident to false. The owner sees your number and can change it; a refusal helps them less than an honest rough figure they can correct.
- Return a plain multiple, never a percentage, and never zero or a negative number.
- Call record_serving_multiple exactly once. Do not reply with prose.`;

/**
 * Ask the coach what multiple of a library serving a recipe quantity is.
 *
 * The owner ratified the quantity/amount split on 2026-09-27 and asked that the
 * two stay coupled by default — so the editor proposes this number whenever the
 * quantity text changes, and the owner can type straight over it. It is a
 * proposal, not a computation: nothing here parses units, because unit
 * conversion is exactly what this app cannot do honestly, and the nutrition
 * panel goes on showing the basis either way.
 *
 * Fails soft on purpose. A proposal that cannot be made leaves the row exactly
 * as it was rather than blocking an edit or failing a save.
 */
async function proposeAmount(cfg, { itemName, itemServing, quantity }) {
  const q = String(quantity || '').trim();
  if (!q) return { amount: null, reason: 'no quantity given' };

  try {
    const res = await claude.complete(cfg, {
      system: AMOUNT_SYSTEM,
      messages: [
        {
          role: 'user',
          content:
            `Ingredient: ${itemName}\n` +
            `Its library serving: ${itemServing || 'one serving (not otherwise described)'}\n` +
            `The recipe asks for: ${q}`,
        },
      ],
      tools: [AMOUNT_TOOL],
    });
    const call = claude.toolUsesOf(res).find((t) => t.name === AMOUNT_TOOL.name);
    if (!call || !call.input) return { amount: null, reason: 'no proposal came back' };
    const n = Number(call.input.amount);
    if (!Number.isFinite(n) || n <= 0) return { amount: null, reason: 'no usable proposal' };
    return {
      amount: Math.round(Math.min(n, 100) * 100) / 100,
      reasoning: call.input.reasoning || null,
      confident: call.input.confident !== false,
    };
  } catch {
    return { amount: null, reason: 'could not work that out' };
  }
}

/** One line describing a library row, for chat echoes and tool results. */
function describe(food) {
  if (!food) return 'nothing';
  const n = food.nutrition || {};
  const bits = [];
  if (n.calories_kcal != null) bits.push(`${n.calories_kcal} kcal`);
  if (n.protein_g != null) bits.push(`${n.protein_g}g protein`);
  if (n.fat_g != null) bits.push(`${n.fat_g}g fat`);
  if (n.carb_g != null) bits.push(`${n.carb_g}g carb`);
  if (n.sodium_mg != null) bits.push(`${n.sodium_mg}mg sodium`);
  const serving = food.quantity ? ` (${food.quantity})` : '';
  return `${food.name}${serving}${bits.length ? ` — ${bits.join(', ')}` : ''}, estimated`;
}

/** The API/page view of a library row. */
function publicFood(food, favoriteSlot = null) {
  if (!food) return null;
  return {
    id: food.id,
    name: food.name,
    kind: food.kind,
    quantity: food.quantity,
    nutrition: food.nutrition,
    // Every figure in this app is an estimate and says so. There is no
    // "measured" branch to render, by design.
    estimate: true,
    provenance: nutritionLib.provenanceLabel(food.source),
    // Present on recipes only, so a search result or a favourite tile can say
    // "serves 4" without a second lookup.
    servings: food.servings === undefined ? null : food.servings,
    favoriteSlot,
  };
}

module.exports = { search, score, norm, estimate, findOrCreate, describe, publicFood, ESTIMATE_TOOL, proposeAmount, AMOUNT_TOOL };
