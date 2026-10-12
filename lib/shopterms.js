'use strict';
/**
 * shopterms.js — recipe lines into things you can shop for (v5 Decision 11, GOTK-181).
 *
 * A recipe says "spring onions, 3, thinly sliced" or "a good pinch smoked
 * paprika". A shop sells green onions and smoked paprika. This module holds the
 * deterministic half of that translation:
 *
 *   - splitting a recipe line into a SEARCH TERM and a NOTE (the prep text,
 *     kept visible, never searched for);
 *   - a merge key, so the same ingredient from two recipes is one line;
 *   - reading an amount ("1.25 x 400 g can", "1/2 cup", "1300 g") and a
 *     package size ("1 lb", "12 ct", "32 fl oz");
 *   - turning what the recipes need into a WHOLE number of the matched package.
 *
 * The model does the judgement part (spring onions are green onions) in
 * shoppinglist.js; everything here is plain code, so it is the fallback when
 * the model is unavailable and the floor its answers are checked against.
 *
 * Pure: no store, no model, no network.
 */

// ---------------------------------------------------------------------------
// recipe line -> search term + note
// ---------------------------------------------------------------------------

/** Pantry-sized measures: never worth more than one package. */
const PANTRY_WORDS = /\b(pinch(es)?|dash(es)?|splash(es)?|drizzle|sprinkle|to taste|to serve|a few|handful)\b/i;

const LEAD_FILLER = /^(a|an|some|good|generous|large|small|heaped|level|scant)\s+/i;
const LEAD_MEASURE = /^(pinch|dash|splash|drizzle|sprinkle|handful|few|cloves?|cups?|tbsp|tsp|tablespoons?|teaspoons?|g|kg|oz|lbs?|ml|cans?|tins?|jars?|slices?|sprigs?|bunch(es)?|heads?|stalks?|pieces?)(es)?\.?\s+(of\s+)?/i;
// A leading amount, but not part of the name: "93% lean ground turkey" keeps its 93%.
const LEAD_NUMBER = /^[\d./½¼¾⅓⅔⅛-]+(?:\s+[\d./]+)?\s+(?:x\s+)?(?!%)/i;

/**
 * Split a recipe line into what to search for and what to keep as a note.
 * "bresaola, thinly sliced" -> { term: "bresaola", note: "thinly sliced" }.
 * "a good pinch smoked paprika" -> { term: "smoked paprika", note: "a good pinch" }.
 */
function splitLine(name) {
  let s = String(name || '').replace(/\s+/g, ' ').trim();
  const notes = [];

  // Parenthesised asides are notes: "fresh mozzarella (bocconcini)".
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => { if (inner.trim()) notes.push(inner.trim()); return ' '; });

  // Everything after the first comma is preparation: "garlic, minced".
  const comma = s.indexOf(',');
  if (comma > 0) {
    const rest = s.slice(comma + 1).trim();
    if (rest) notes.push(rest);
    s = s.slice(0, comma);
  }

  // "Aleppo pepper or red pepper flakes": search the first, note the choice.
  // A one-word first choice usually shares the noun at the end of the second
  // ("potato or brioche burger buns", "grapeseed or other oil"), so it takes
  // that noun with it rather than searching for "potato".
  const or = /\s+or\s+/i.exec(s);
  if (or) {
    const first = s.slice(0, or.index).trim();
    const second = s.slice(or.index + or[0].length).trim();
    notes.push(`or ${second}`);
    const noun = second.split(/\s+/).pop();
    s = first.split(/\s+/).length === 1 && noun && noun.toLowerCase() !== first.toLowerCase() ? `${first} ${noun}` : first;
  }

  // Leading amounts and measures belong in the note, not the search.
  const before = s.trim();
  let t = before;
  for (let i = 0; i < 4; i += 1) {
    const next = t.replace(LEAD_NUMBER, '').replace(LEAD_FILLER, '').replace(LEAD_MEASURE, '').trim();
    if (next === t) break;
    t = next;
  }
  if (t !== before && t) notes.unshift(before.slice(0, before.length - t.length).trim());

  const term = t.replace(/\s+/g, ' ').trim();
  return { term: term || String(name || '').trim(), note: notes.filter(Boolean).join('; ') };
}

/**
 * The merge key for a term: case, plural and filler words do not make a
 * different ingredient. "Yellow onions" and "yellow onion" are one line.
 */
function termKey(term) {
  return String(term || '')
    .toLowerCase()
    .replace(/[^a-z0-9% ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && /(oes|ies)$/.test(w) ? w.replace(/ies$/, 'y').replace(/oes$/, 'o')
      : w.length > 3 && /[^siu]s$/.test(w) ? w.slice(0, -1) : w))
    .join(' ');
}

// ---------------------------------------------------------------------------
// amounts and package sizes
// ---------------------------------------------------------------------------

/** Base units: grams, millilitres, and "each". */
const UNITS = {
  mass: { g: 1, gram: 1, grams: 1, kg: 1000, oz: 28.3495, ounce: 28.3495, ounces: 28.3495, lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592 },
  volume: {
    ml: 1, l: 1000, litre: 1000, liter: 1000, 'fl oz': 29.5735, tsp: 4.92892, teaspoon: 4.92892,
    tbsp: 14.7868, tablespoon: 14.7868, cup: 236.588, cups: 236.588, pt: 473.176, pint: 473.176,
    qt: 946.353, quart: 946.353, gal: 3785.41, gallon: 3785.41,
  },
  count: {
    '': 1, each: 1, ea: 1, ct: 1, count: 1, whole: 1, medium: 1, mediums: 1, large: 1, small: 1,
    piece: 1, pieces: 1, head: 1, bunch: 1, can: 1, cans: 1, jar: 1, bottle: 1, pack: 1, package: 1,
    // Garlic is sold by the bulb; a bulb is roughly ten cloves.
    clove: 0.1, cloves: 0.1,
  },
};

const FRACTIONS = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

function readNumber(str) {
  const s = String(str).trim().replace(/[½¼¾⅓⅔⅛]/g, (f) => ` ${FRACTIONS[f]}`).trim();
  // "1 1/2", "1/2", "1.25", "1 0.5" (from the unicode swap)
  const m = /^(\d+(?:\.\d+)?)(?:\s+(\d+(?:\.\d+)?)(?:\/(\d+))?)?(?:\/(\d+))?/.exec(s);
  if (!m) return null;
  let v = Number(m[1]);
  if (m[4]) v /= Number(m[4]);
  if (m[2]) v += m[3] ? Number(m[2]) / Number(m[3]) : Number(m[2]);
  return { value: v, rest: s.slice(m[0].length).trim() };
}

function unitOf(word) {
  const w = String(word || '').toLowerCase().replace(/\.$/, '');
  for (const dim of Object.keys(UNITS)) {
    if (Object.prototype.hasOwnProperty.call(UNITS[dim], w)) return { dim, factor: UNITS[dim][w] };
  }
  return null;
}

/**
 * Read one amount into a base unit. Null when it is not a measurable amount
 * ("a pinch", "a few, to serve", "2 cloves" — cloves are not how garlic is sold).
 */
function parseAmount(text) {
  const raw = String(text || '').replace(/\(as written\)/i, '').trim();
  if (!raw || PANTRY_WORDS.test(raw)) return null;
  const n = readNumber(raw);
  if (!n) return null;
  let { value } = n;
  let rest = n.rest;

  // "1.25 x 400 g can" — a multiple of a stated package.
  const times = /^x\s*/i.exec(rest);
  if (times) {
    const inner = readNumber(rest.slice(times[0].length));
    if (!inner) return null;
    value *= inner.value;
    rest = inner.rest;
  }

  // "4, about 200 g each" — a count of things of a stated weight.
  const each = /^,?\s*(?:about|approx\.?|~)?\s*([\d.]+)\s*(g|kg|oz|lb)\s+each\b/i.exec(rest);
  if (each) {
    const u = unitOf(each[2]);
    return { value: value * Number(each[1]) * u.factor, dim: 'mass' };
  }

  const fl = /^fl\.?\s*oz\b/i.exec(rest);
  const word = fl ? 'fl oz' : (/^[a-zA-Z]+/.exec(rest) || [''])[0];
  const unit = unitOf(word);
  if (!unit) return null;
  return { value: value * unit.factor, dim: unit.dim };
}

/** Read Kroger's package size ("1 lb", "12 ct", "32 fl oz", "3 lb bag"). */
function parseSize(size) {
  const s = String(size || '').trim().toLowerCase();
  if (!s) return null;
  // "6 ct / 1 lb" style: take the first readable part.
  for (const part of s.split(/[/|]/)) {
    const a = parseAmount(part);
    if (a && a.value > 0) return a;
  }
  return null;
}

/**
 * How many of the matched package cover what the recipes need.
 *
 * Every part of the need that can be measured in the package's own dimension
 * is added up and divided by the package size, rounded UP to a whole package.
 * Anything that cannot be compared — "a pinch", "2 tbsp" against a jar sold by
 * weight — counts as needing one package. So pantry amounts round up to one,
 * and the result is always a whole number of at least one.
 */
function packageCount(needs, size) {
  const pkg = parseSize(size);
  const parts = (needs || []).map(parseAmount);
  if (!pkg) return 1;
  let total = 0;
  let unmeasured = false;
  for (const p of parts) {
    if (p && p.dim === pkg.dim) total += p.value;
    else unmeasured = true;
  }
  const measured = total > 0 ? Math.ceil(total / pkg.value - 1e-9) : 0;
  return Math.min(Math.max(measured, unmeasured || !parts.length ? 1 : 0, 1), 24);
}

/**
 * Split the planner's joined quantity ("200 g + 60 g (2 big handfuls)") back
 * into its parts, so each can be measured on its own.
 */
function splitNeeds(quantity) {
  return String(quantity || '')
    .split(/\s+\+\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * What each line's match state means, in the owner's words (Decision 11e).
 * kroger.js uses the same three failure strings, so the review row, the send
 * summary and the chat all say the same thing.
 */
const STATUS_TEXT = {
  no_response: "King Soopers didn't respond",
  signin: 'King Soopers sign-in expired',
  no_match: 'No match for this item',
  not_searched: 'Not matched yet — Rebuild to match it',
};

module.exports = {
  STATUS_TEXT,
  splitLine,
  termKey,
  parseAmount,
  parseSize,
  packageCount,
  splitNeeds,
  PANTRY_WORDS,
};
