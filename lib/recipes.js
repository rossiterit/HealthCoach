'use strict';
/**
 * recipes.js — the recipe model and its arithmetic (v4 F1, GOTK-170).
 *
 * A recipe is a composed library item: a name, a servings count, ingredient
 * rows that point at other library items, and ordered steps. Decision 2 makes
 * PER SERVING the canonical unit — every figure the owner sees is derived from
 * it, and changing the servings count rescales what is displayed without
 * touching what is stored.
 *
 * HOW AN INGREDIENT'S MACROS ARE COMPUTED — the one modelling decision the
 * spec left open, and worth stating plainly because it bounds how precise any
 * of this can be.
 *
 * A library item's macros describe ONE serving of that item as the library
 * stores it: "Porridge oats — 1 bowl (40 g)". A recipe row, though, says
 * something like "200 g oats". Turning the second into the first needs unit
 * conversion and density data this app does not have, and v4 explicitly
 * excludes scaling beyond servings math. So each ingredient row carries two
 * things that are deliberately kept apart:
 *
 *   quantity  free text, exactly as the owner or the coach wrote it, shown in
 *             the editor and the cook view and never parsed for arithmetic;
 *   amount    a number: how many of that library item's own servings this row
 *             represents. It is what the macro maths multiplies by.
 *
 * The nutrition panel states this basis rather than implying a precision we do
 * not have, and every figure stays flagged as an estimate (v1 Decision 10).
 * Getting `amount` wrong is a correction like any other — by chat or in the
 * editor — rather than a silent inaccuracy.
 *
 * NO GRADING (Decision 8). Nothing in this module scores a recipe, ranks one
 * against another, or computes a "healthiness" of any kind. There is no field
 * here a view could render as a verdict, which is the same way the planner's
 * totals row was kept honest in v3.
 */
const nutritionLib = require('./nutrition');

const MAX_INGREDIENTS = 60;
const MAX_STEPS = 60;

// ---------------------------------------------------------------------------
// normalising what comes in
// ---------------------------------------------------------------------------

function posIntOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10000) : null;
}

/** Ingredient rows: a library reference, display text, and a numeric multiple. */
function normaliseIngredients(list) {
  return (Array.isArray(list) ? list : []).slice(0, MAX_INGREDIENTS).map((r) => ({
    // Null is legitimate: a row can name something not in the library yet
    // (create-on-miss happens at save time, not here), and a recipe with an
    // unlinked row is more useful than a refused save.
    foodId: r.foodId || null,
    name: String(r.name || '').trim().slice(0, 200),
    quantity: r.quantity ? String(r.quantity).trim().slice(0, 80) : '',
    amount: amountOf(r.amount),
  })).filter((r) => r.name);
}

/** How many of the library item's own servings this row is. Defaults to one. */
function amountOf(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(n, 100) * 100) / 100;
}

function normaliseSteps(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, MAX_STEPS)
    .map((s) => String(typeof s === 'string' ? s : s && s.text ? s.text : '').trim().slice(0, 1000))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// the arithmetic
// ---------------------------------------------------------------------------

/**
 * What one ingredient row contributes: its library item's macros times the
 * row's `amount`. An unlinked row contributes nothing and says so, rather than
 * quietly counting as zero calories — the difference matters when the panel is
 * explaining where a number came from.
 */
function ingredientNutrition(store, row) {
  const item = row.foodId ? store.getFood(row.foodId) : null;
  if (!item) return { nutrition: null, item: null, linked: false };
  const scaled = {};
  for (const f of nutritionLib.NUMERIC_FIELDS) {
    const v = item.nutrition ? item.nutrition[f] : null;
    scaled[f] = v === null || v === undefined ? null : Math.round(v * row.amount * 10) / 10;
  }
  scaled.ultra_processed = item.nutrition ? item.nutrition.ultra_processed : null;
  return { nutrition: scaled, item, linked: true };
}

/** Totals for the whole recipe, plus how much of it we could actually compute. */
function totals(store, recipe) {
  const parts = (recipe.ingredients || []).map((r) => ingredientNutrition(store, r));
  const linked = parts.filter((p) => p.linked);
  return {
    nutrition: nutritionLib.total(linked.map((p) => ({ nutrition: p.nutrition }))),
    ingredientCount: (recipe.ingredients || []).length,
    // Stated so the panel can be honest when some rows are not in the library:
    // a total from 4 of 6 ingredients is not a total, and should not look like one.
    countedCount: linked.length,
    complete: linked.length === (recipe.ingredients || []).length && linked.length > 0,
  };
}

/** The canonical unit (Decision 2): everything the owner sees derives from this. */
function perServing(store, recipe) {
  const t = totals(store, recipe);
  const servings = Math.max(parseInt(recipe.servings, 10) || 1, 1);
  const out = {};
  for (const f of nutritionLib.NUMERIC_FIELDS) {
    const v = t.nutrition[f];
    out[f] = v === null || v === undefined ? null : Math.round((v / servings) * 10) / 10;
  }
  out.ultra_processed = t.nutrition.ultra_processed;
  return out;
}

/**
 * A recipe dressed as a library item, so search, favourites and the planner can
 * treat it exactly like a meal without knowing it is a recipe. Per-serving
 * macros are its nutrition, because one serving is what lands in a planner slot.
 */
function asLibraryItem(store, recipe) {
  return {
    id: recipe.id,
    name: recipe.name,
    kind: 'recipe',
    quantity: '1 serving',
    nutrition: perServing(store, recipe),
    // Estimated, like everything else in this app: the figures come from the
    // ingredients' own estimates, so a recipe cannot be more certain than they are.
    source: 'recipe-estimate',
    estimate: true,
    // Enough for a card to show "serves 4" without a second lookup.
    servings: recipe.servings,
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
  };
}

/**
 * Display quantities for a chosen number of servings (Decision 2: "changing
 * servings rescales displayed quantities").
 *
 * The free-text quantity is rescaled only when it starts with a plain number,
 * which covers "200 g" and "2 tbsp" and stops short of guessing at "a splash of
 * oil". Anything it cannot rescale honestly it leaves alone and marks, so the
 * cook view can show it as-written rather than inventing a figure.
 */
function scaleQuantity(text, factor) {
  const s = String(text || '').trim();
  if (!s || factor === 1) return { text: s, scaled: false };
  const m = /^(\d+(?:\.\d+)?)(\s*\/\s*(\d+))?\s*(.*)$/.exec(s);
  if (!m) return { text: s, scaled: false };
  let value = Number(m[1]);
  if (m[3]) value = value / Number(m[3]);
  if (!Number.isFinite(value) || value <= 0) return { text: s, scaled: false };
  const out = Math.round(value * factor * 100) / 100;
  return { text: `${out}${m[4] ? ` ${pluralise(m[4], out)}` : ''}`, scaled: true };
}

// Unit abbreviations never take an -s: "2 gs" and "2 ozs" are worse than the
// problem being solved. Everything else is left to the rule below.
const ABBREVIATIONS = new Set(['g', 'kg', 'mg', 'ml', 'l', 'oz', 'lb', 'lbs', 'tsp', 'tbsp', 'cl', 'dl', 'qt', 'pt', 'fl']);

/**
 * Pluralise the unit when scaling takes a quantity past one — "1 can" doubled
 * is "2 cans", not "2 can". Deliberately timid: one plain word, not already
 * plural, not an abbreviation. Anything else is left exactly as written,
 * because a wrong plural reads worse than an unchanged one.
 */
function pluralise(unit, value) {
  const s = String(unit);
  if (!/^[a-z]+$/i.test(s)) return s;
  if (ABBREVIATIONS.has(s.toLowerCase())) return s;

  // Scaling DOWN past one: "2 cups" halved is "1 cup", not "1 cups". Timid for
  // the same reason as below — -ss and -us words are left alone, because
  // "glass" and "asparagus" are not plurals and butchering them reads worse
  // than an ugly number.
  if (value <= 1) {
    if (/(ss|us)$/i.test(s)) return s;
    if (/(shes|ches|xes|zes)$/i.test(s)) return s.slice(0, -2);
    if (/s$/i.test(s)) return s.slice(0, -1);
    return s;
  }

  if (/s$/i.test(s)) return s; // already plural
  if (/(sh|ch|x|z)$/i.test(s)) return `${s}es`; // box -> boxes, dish -> dishes
  return `${s}s`;
}

/** The whole recipe as the page and the API see it, at a chosen servings count. */
function view(store, recipe, forServings = null) {
  const servings = Math.max(parseInt(forServings || recipe.servings, 10) || 1, 1);
  const factor = servings / Math.max(parseInt(recipe.servings, 10) || 1, 1);
  const t = totals(store, recipe);
  const per = perServing(store, recipe);

  return {
    id: recipe.id,
    name: recipe.name,
    servings: recipe.servings,
    shownServings: servings,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    notes: recipe.notes,
    healthifiedFrom: recipe.healthifiedFrom,
    healthifyNote: recipe.healthifyNote,
    ingredients: (recipe.ingredients || []).map((r) => {
      const n = ingredientNutrition(store, r);
      const q = scaleQuantity(r.quantity, factor);
      return {
        foodId: r.foodId,
        name: r.name,
        quantity: q.text,
        quantityScaled: q.scaled,
        originalQuantity: r.quantity,
        amount: Math.round(r.amount * factor * 100) / 100,
        linked: n.linked,
        // What the maths actually used, so the panel can show its working.
        basis: n.linked ? `${r.amount} x ${n.item.quantity || 'library serving'}` : null,
        nutrition: n.nutrition,
      };
    }),
    steps: recipe.steps || [],
    nutrition: {
      total: t.nutrition,
      perServing: per,
      // Every figure here is an estimate, and the panel says so rather than
      // implying a precision the ingredient maths cannot support.
      estimate: true,
      ingredientCount: t.ingredientCount,
      countedCount: t.countedCount,
      complete: t.complete,
      basisNote:
        'Estimated from the ingredients, each counted as a multiple of its library serving.',
    },
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
  };
}

/** The list row: name, servings, per-serving calories (Decision 7). */
function listRow(store, recipe) {
  const per = perServing(store, recipe);
  return {
    id: recipe.id,
    name: recipe.name,
    servings: recipe.servings,
    caloriesPerServing: per.calories_kcal,
    ingredientCount: (recipe.ingredients || []).length,
    stepCount: (recipe.steps || []).length,
    healthifiedFrom: recipe.healthifiedFrom,
    updatedAt: recipe.updatedAt,
  };
}

/** One line for a chat echo. */
function describe(store, recipe) {
  const per = perServing(store, recipe);
  const cal = per.calories_kcal != null ? `, about ${per.calories_kcal} kcal a serving` : '';
  return `${recipe.name} — serves ${recipe.servings}, ${(recipe.ingredients || []).length} ingredients, ${(recipe.steps || []).length} steps${cal} (estimated)`;
}

module.exports = {
  MAX_INGREDIENTS,
  MAX_STEPS,
  normaliseIngredients,
  normaliseSteps,
  amountOf,
  posIntOrNull,
  ingredientNutrition,
  totals,
  perServing,
  asLibraryItem,
  scaleQuantity,
  view,
  listRow,
  describe,
};
