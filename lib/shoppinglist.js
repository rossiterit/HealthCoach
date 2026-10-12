'use strict';
/**
 * shoppinglist.js — the reviewed shopping list (v5 F4/F5, Decisions 9, 11, 12;
 * GOTK-179, GOTK-181).
 *
 * The list has always been generated from the plan grid (v4 F4). Decision 9
 * put a REVIEW STEP between generating it and doing anything with it: the
 * owner culls what they already have, fixes a quantity, adds the thing that
 * was never in the plan, and only then copies it or sends it.
 *
 * Decision 11 makes the lines shoppable. Recipe text ("spring onions, 3,
 * thinly sliced") becomes a shopping term (green onions) with the prep kept as
 * a note; the same ingredient from several recipes becomes one line; each line
 * is matched to a King Soopers product WHEN THE LIST IS BUILT, so the review
 * shows exactly what Send will put in the cart, as a whole number of packages.
 *
 * THIS MODULE STILL REACHES NOTHING OUTSIDE THE APP. The product search is
 * handed in by the caller as `match(terms, reason)` — the button route and the
 * chat tool pass kroger.matchTerms; nothing else does. So the only ways a
 * search can happen are the three owner actions that call generate() or
 * edit('add'), and a test proves this file requires no network module.
 *
 * WHAT COMES BACK FROM A SEARCH IS DATA. Product names and sizes are stored to
 * be shown as text; they are never sent to the model and never acted on.
 *
 * EXCLUSIONS ARE SILENT (Decision 9). Unticking asks no question and draws no
 * comment. The no-guilt rule covers shopping too.
 *
 * STALE IS SAID, NEVER FIXED BEHIND THE OWNER'S BACK (Decision 12). The list
 * remembers a fingerprint of the plan it was built from; when the grid has
 * moved on, opening it says so, and keeps their ticks and edits until they
 * tap Rebuild.
 */
const crypto = require('crypto');
const claude = require('./claude');
const planner = require('./planner');
const shopterms = require('./shopterms');

const { splitLine, termKey, splitNeeds, packageCount, STATUS_TEXT } = shopterms;

/** The aisles, in the order a shop is usually walked. */
const CATEGORIES = [
  'Produce',
  'Meat & fish',
  'Dairy & eggs',
  'Bakery',
  'Tins & jars',
  'Dry goods',
  'Frozen',
  'Drinks',
  'Other',
];

// ---------------------------------------------------------------------------
// recipe lines -> shopping terms (one model call per chunk, fail soft)
// ---------------------------------------------------------------------------

const CATEGORY_TOOL = {
  name: 'record_shopping_lines',
  description: 'For each numbered recipe line, record what to look for in the shop, the prep note, and the aisle.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'The number of the line, as given.' },
            term: { type: 'string', description: 'What a shopper would search a US supermarket for. 1–5 words.' },
            note: { type: 'string', description: 'Prep or choice text from the line that is not part of the product. Empty if none.' },
            category: { type: 'string', enum: CATEGORIES },
            not_bought: { type: 'boolean', description: 'True only for things nobody buys: tap water, ice, boiling water.' },
          },
          required: ['index', 'term', 'category'],
        },
      },
    },
    required: ['items'],
  },
};

const CATEGORY_SYSTEM = `You turn recipe ingredient lines into supermarket shopping terms, and file each in an aisle. That is the whole job.

Each line is numbered. For every line, record:
- term: the product a shopper would type into a US supermarket's search (King Soopers). Plain words, 1-5 of them, no punctuation except a hyphen or %.
  - Use the American shop name: spring onions -> green onions, coriander -> cilantro, courgette -> zucchini, aubergine -> eggplant, rocket -> arugula, beef mince -> ground beef, double cream -> heavy cream.
  - Drop amounts, sizes and preparation: "a good pinch smoked paprika" -> smoked paprika; "garlic, minced" -> garlic; "0.13 small white onion" -> onions.
  - White, yellow and brown onions are the same thing to shop for: use "onions". Red onion stays "red onion".
  - Garlic cloves are bought as garlic. Keep a brand when the line names one ("Noosa yoghurt" -> Noosa yogurt).
  - "X or Y": pick the first, written as a product ("potato or brioche burger buns" -> potato buns).
- note: the preparation or choice text you dropped ("thinly sliced", "or red pepper flakes"). Empty when there is none. Never put an amount here.
- not_bought: true only for things that come out of the tap or the freezer rather than the shop — water, ice cubes, boiling water. Leave it out otherwise.
- category: the aisle, from the categories offered. For a dish name, file it where its MAIN ingredient lives. Use "Other" only when nothing fits.

Say nothing about the food: no comment on what it is, whether it is healthy, or what someone is cooking. You are labelling rows, not reading a diet.

Call record_shopping_lines exactly once, covering every line. Do not reply with prose.`;

/** Lines per model call. Small enough to stay quick; run side by side. */
const CHUNK = 30;

/** A term the model gave back is only used if it looks like a shelf item. */
function usableTerm(t) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s || s.length > 50 || s.split(' ').length > 6) return null;
  if (/[;?!:·|\n.,]/.test(s)) return null;
  return s;
}

/**
 * Turn recipe lines into { term, note, category }, one per line, in order.
 *
 * Fails soft, per line: whatever the model does not answer well falls back to
 * the plain-code split in shopterms.js and the "Other" aisle — a slightly
 * untidy list rather than no list at all.
 */
async function normalise(cfg, names) {
  const out = names.map((n) => ({ ...splitLine(n), category: 'Other' }));
  if (!names.length) return out;

  const chunks = [];
  for (let i = 0; i < names.length; i += CHUNK) chunks.push(i);

  await Promise.all(chunks.map(async (start) => {
    const slice = names.slice(start, start + CHUNK);
    try {
      const res = await claude.complete(cfg, {
        system: CATEGORY_SYSTEM,
        messages: [{ role: 'user', content: slice.map((n, i) => `${start + i + 1}. ${n}`).join('\n') }],
        tools: [CATEGORY_TOOL],
      });
      const call = claude.toolUsesOf(res).find((t) => t.name === CATEGORY_TOOL.name);
      for (const row of (call && call.input && call.input.items) || []) {
        const i = Number(row && row.index) - 1;
        if (!Number.isInteger(i) || i < start || i >= start + slice.length) continue;
        const term = usableTerm(row.term);
        if (term) {
          out[i].term = term;
          out[i].note = String(row.note || '').trim().slice(0, 120);
        }
        if (CATEGORIES.includes(row.category)) out[i].category = row.category;
        if (row.not_bought === true) out[i].notBought = true;
      }
    } catch {
      /* fail soft: this chunk keeps the plain-code split */
    }
  }));
  return out;
}

/** Kept for callers that only want aisles. */
async function categorise(cfg, names) {
  const rows = await normalise(cfg, names);
  return new Map(names.map((n, i) => [String(n), rows[i].category]));
}

// ---------------------------------------------------------------------------
// lines, merging and package counts
// ---------------------------------------------------------------------------

/** A stable key per line, so ticks survive a re-render. */
function keyOf(line) {
  return line.key || line.foodId || `name:${String(line.name || '').toLowerCase()}`;
}

function joinNote(a, b) {
  const parts = [...String(a || '').split('; '), ...String(b || '').split('; ')].map((s) => s.trim()).filter(Boolean);
  return [...new Set(parts)].join('; ');
}

function joinQuantity(a, b) {
  return [a, b].filter(Boolean).join(' + ');
}

/**
 * Recompute the package count unless the owner has set it themselves.
 *
 * Two sources add up: what the recipes need, measured against the matched
 * package (`needs`), and whole packages asked for directly (`extra` — a
 * hand-added item with no amount is one package). Keeping them apart is what
 * lets a merge carry both rather than losing one to a "minimum of one".
 */
function recount(item) {
  if (item.countSet) return item;
  const size = item.match ? item.match.size : null;
  const fromNeeds = item.needs && item.needs.length ? packageCount(item.needs, size) : 0;
  item.count = Math.min(Math.max(fromNeeds + (item.extra || 0), 1), 24);
  return item;
}

/**
 * Fold `src` into `target`: one line, quantities carried, nothing dropped.
 * Used for the same ingredient from two recipes, a hand-added duplicate, and
 * two lines that resolve to the same product (Decision 11c).
 */
function mergeInto(target, src) {
  target.needs = [...(target.needs || []), ...(src.needs || [])];
  target.quantity = joinQuantity(target.quantity, src.quantity);
  target.note = joinNote(target.note, src.note);
  target.aliases = [...new Set([...(target.aliases || []), ...(src.aliases || [])])];
  for (const r of src.fromRecipes || []) if (!target.fromRecipes.includes(r)) target.fromRecipes.push(r);
  target.extra = (target.extra || 0) + (src.extra || 0);
  target.included = target.included || src.included;
  target.manual = Boolean(target.manual && src.manual);
  if (!target.match && src.match) {
    target.match = src.match;
    target.candidates = src.candidates;
    target.status = src.status;
  }
  if (target.countSet || src.countSet) {
    target.count = Math.min((target.count || 1) + (src.count || 1), 24);
    target.countSet = true;
  } else {
    recount(target);
  }
  return target;
}

/** Merge lines that share a key (by term) or a product (by UPC). */
function mergeAll(items, keyFn) {
  const out = [];
  const seen = new Map();
  for (const item of items) {
    const k = keyFn(item);
    if (k && seen.has(k)) mergeInto(seen.get(k), item);
    else {
      if (k) seen.set(k, item);
      out.push(item);
    }
  }
  return out;
}

const upcOf = (i) => (i.match && i.match.upc ? `upc:${i.match.upc}` : null);

/** Attach one search result to a line. */
function applyResult(item, result) {
  if (result && Array.isArray(result.candidates) && result.candidates.length) {
    item.candidates = result.candidates;
    item.match = result.candidates[0];
    item.status = 'matched';
  } else {
    item.candidates = [];
    item.match = null;
    item.status = (result && result.kind) || 'no_response';
  }
  return recount(item);
}

/** A fingerprint of what the plan asks to be bought — not of the list's edits. */
function planFingerprint(source) {
  const rows = (source.lines || []).map((l) => [l.foodId || null, l.name, l.quantity || '']);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32);
}

/**
 * Generate the reviewed list from the week's grid.
 *
 * Deliberately destructive of any previous review for that week — that is what
 * "regenerating resets it" means — and the caller tells the owner so.
 *
 * `match(terms, reason)` is the product search, handed in by the caller. It is
 * optional: without it the list is built but unmatched, and says so per line.
 */
async function generate(store, cfg, weekStart, { match = null, reason = 'create' } = {}) {
  const source = planner.shoppingList(store, cfg, weekStart);
  const norm = await normalise(cfg, source.lines.map((l) => l.name));

  let items = source.lines.map((l, i) => {
    const n = norm[i];
    // The recipe's wording is only worth showing when the model renamed the
    // thing ("spring onions" -> green onions), not when it merely trimmed it.
    const sameAsTerm = termKey(n.term) === termKey(splitLine(l.name).term);
    return {
      key: `t:${termKey(n.term)}`,
      foodId: l.foodId || null,
      name: n.term,
      // The prep text stays visible as a note; so does the recipe's own name
      // for the ingredient when the search term differs from it.
      note: joinNote(sameAsTerm ? '' : l.name, n.note),
      quantity: l.quantity || '',
      // "garlic cloves: 6" means six cloves, not six bulbs.
      needs: splitNeeds(l.quantity).map((q) => (/\bcloves?\b/i.test(l.name) && /^[\d./\s]+$/.test(q) ? `${q} cloves` : q)),
      category: n.category,
      // Everything starts ticked — the review is for taking things OUT — except
      // what nobody buys (tap water, ice). That starts under "Not buying",
      // still visible and one tap from coming back.
      included: !n.notBought,
      fromRecipes: l.fromRecipes || [],
      manual: false,
      aliases: [termKey(n.term), termKey(l.name)],
      status: 'not_searched',
      match: null,
      candidates: [],
      count: 1,
      extra: 0,
      countSet: false,
    };
  });

  // The same ingredient from two recipes is one line (Decision 11c).
  items = mergeAll(items, (i) => i.key).map(recount);

  if (typeof match === 'function') {
    const results = await match(items.map((i) => i.name), reason);
    for (const item of items) applyResult(item, results.get(item.name));
    // ...and so are two lines that turn out to be the same product.
    items = mergeAll(items, upcOf);
  }

  const list = {
    weekStart,
    generatedAt: new Date().toISOString(),
    items,
    recipesExpanded: source.recipesExpanded,
    fromPlan: source.fromPlan,
    planFingerprint: planFingerprint(source),
    matched: typeof match === 'function',
  };
  store.setShoppingList(weekStart, list);
  return list;
}

/** The saved review for a week, or null when one was never generated. */
function get(store, weekStart) {
  return store.getShoppingList(weekStart);
}

/**
 * Has the plan changed since this list was built? (Decision 12)
 *
 * Purely local: it re-reads the grid and compares fingerprints. It never
 * searches and never rebuilds — saying so is the whole of its job. A list from
 * before fingerprints existed cannot vouch for itself, so it counts as stale.
 */
function isStale(store, cfg, list) {
  if (!list) return false;
  if (!list.planFingerprint) return true;
  return planFingerprint(planner.shoppingList(store, cfg, list.weekStart)) !== list.planFingerprint;
}

function findItem(items, key) {
  return items.find((i) => i.key === key);
}

/**
 * Apply one owner edit. Silent by design — no confirmations anywhere.
 *
 * Async because adding an item by hand matches it at King Soopers there and
 * then (Decision 11) — through the `match` the caller hands in, never by
 * itself. Every other action is local.
 */
async function edit(store, weekStart, action, payload = {}, { match = null } = {}) {
  const list = store.getShoppingList(weekStart);
  if (!list) return { error: 'There is no list to review yet.' };
  let items = list.items;
  let merged = null;

  if (action === 'toggle') {
    const row = findItem(items, payload.key);
    if (!row) return { error: 'That item is not on the list.' };
    row.included = payload.included === undefined ? !row.included : Boolean(payload.included);
  } else if (action === 'quantity') {
    const row = findItem(items, payload.key);
    if (!row) return { error: 'That item is not on the list.' };
    row.quantity = String(payload.quantity || '').slice(0, 80);
    row.needs = splitNeeds(row.quantity);
    row.extra = 0;
    recount(row);
  } else if (action === 'count') {
    const row = findItem(items, payload.key);
    if (!row) return { error: 'That item is not on the list.' };
    const n = parseInt(payload.count, 10);
    if (!Number.isFinite(n) || n < 1) return { error: 'A count is a whole number, 1 or more.' };
    row.count = Math.min(n, 24);
    row.countSet = true;
  } else if (action === 'choose') {
    // Pick a different match from what the search already returned. No new
    // search: the choice is among the candidates the owner can see.
    const row = findItem(items, payload.key);
    if (!row) return { error: 'That item is not on the list.' };
    const pick = (row.candidates || []).find((c) => c.upc === String(payload.upc));
    if (!pick) return { error: 'That product was not one of the matches.' };
    row.match = pick;
    row.status = 'matched';
    recount(row);
    const other = items.find((i) => i !== row && i.match && i.match.upc === pick.upc);
    if (other) {
      mergeInto(other, row);
      items.splice(items.indexOf(row), 1);
      merged = other.key;
    }
  } else if (action === 'remove') {
    const i = items.findIndex((x) => x.key === payload.key);
    if (i === -1) return { error: 'That item is not on the list.' };
    items.splice(i, 1);
  } else if (action === 'add') {
    const typed = String(payload.name || '').trim().slice(0, 200);
    if (!typed) return { error: 'Give the item a name.' };
    const { term, note } = splitLine(typed);
    const quantity = String(payload.quantity || '').slice(0, 80);
    const tk = termKey(term);

    // Already on the list? Then it is one more of that, not a second line.
    const same = items.find((i) => (i.aliases || [termKey(i.name)]).includes(tk) || termKey(i.name) === tk);
    if (same) {
      same.extra = (same.extra || 0) + (quantity ? packageCount([quantity], same.match && same.match.size) : 1);
      same.quantity = joinQuantity(same.quantity, quantity ? `${quantity} added` : '1 added');
      same.included = true;
      recount(same);
      if (same.countSet) same.count = Math.min(same.count + 1, 24);
      merged = same.key;
    } else {
      const item = {
        key: `manual:${tk}:${Date.now().toString(36)}`,
        foodId: null,
        name: term,
        note,
        quantity,
        needs: quantity ? [quantity] : [],
        // No amount typed means one of whatever it matches.
        extra: quantity ? 0 : 1,
        category: CATEGORIES.includes(payload.category) ? payload.category : 'Other',
        included: true,
        fromRecipes: [],
        // Marked so regenerating can tell the owner what it is about to lose.
        manual: true,
        aliases: [tk],
        status: 'not_searched',
        match: null,
        candidates: [],
        count: 1,
        countSet: false,
      };
      if (typeof match === 'function') {
        const results = await match([term], 'add');
        applyResult(item, results.get(term));
      }
      const sameProduct = item.match && items.find((i) => i.match && i.match.upc === item.match.upc);
      if (sameProduct) {
        mergeInto(sameProduct, item);
        merged = sameProduct.key;
      } else {
        items.push(item);
      }
    }
  } else {
    return { error: `No such action: ${action}.` };
  }

  list.items = items;
  store.setShoppingList(weekStart, list);
  return { list, merged };
}

/** Only what is ticked. This is what Copy and Send both use. */
function included(list) {
  return (list && list.items ? list.items : []).filter((i) => i.included);
}

/** The list grouped into aisles, ticked items only, in shop order. */
function grouped(list) {
  const out = [];
  for (const category of CATEGORIES) {
    const rows = included(list).filter((i) => i.category === category);
    if (rows.length) out.push({ category, items: rows });
  }
  return out;
}

/**
 * Kroger's description already carries the brand where it matters ("Kroger®
 * 93/7 Lean Fresh Ground Turkey"); prepending the brand field turns produce
 * into "Fresh Berries Fresh Strawberries". So the description stands alone.
 */
function productLabel(m) {
  if (!m) return '';
  return `${m.description}${m.size ? `, ${m.size}` : ''}`;
}

/** The plain text the Copy button puts on the clipboard. Always works. */
function asText(list) {
  const groups = grouped(list);
  if (!groups.length) return 'Nothing ticked.';
  return groups
    .map((g) => `${g.category}\n${g.items.map((i) => {
      const qty = i.quantity ? ` — ${i.quantity}` : '';
      const pkg = i.match ? ` [${i.count || 1} × ${productLabel(i.match)}]` : ' [not matched at King Soopers]';
      return `- ${i.name}${qty}${pkg}`;
    }).join('\n')}`)
    .join('\n\n');
}

/**
 * What Send may carry: ticked AND matched lines, as UPC + whole-package count.
 * Ticked lines with no match are reported back with their reason and never
 * sent (Decision 11e).
 */
function forKroger(list) {
  const lines = [];
  const skipped = [];
  for (const i of included(list)) {
    if (i.match && i.match.upc) {
      lines.push({ key: i.key, name: i.name, upc: i.match.upc, quantity: Math.min(Math.max(i.count || 1, 1), 24), product: productLabel(i.match) });
    } else {
      skipped.push({ key: i.key, name: i.name, why: STATUS_TEXT[i.status] || STATUS_TEXT.not_searched });
    }
  }
  return { lines, skipped };
}

/**
 * The one plain summary after Send (Decision 11f): what was added, what was
 * not, and why. On failure, nothing was added — and it says so first.
 */
function summarise(outcome, { lines, skipped }) {
  const notAdded = skipped.map((s) => `  - ${s.name} — ${s.why}`);
  if (outcome.error) {
    return `Nothing was added to your cart — ${String(outcome.error).replace(/\.+$/, '')}. The list is still here to copy.`;
  }
  let text = `Added ${lines.length} item${lines.length === 1 ? '' : 's'} to your King Soopers cart:\n` +
    lines.map((l) => `  - ${l.product} ×${l.quantity}`).join('\n');
  if (notAdded.length) text += `\n\nNot added:\n${notAdded.join('\n')}`;
  text += '\n\nCheck it in your Kroger app before you order — I can add to the cart but I cannot change or remove anything, and I never check out.';
  return text;
}

module.exports = {
  CATEGORIES,
  CATEGORY_TOOL,
  CATEGORY_SYSTEM,
  normalise,
  categorise,
  generate,
  get,
  isStale,
  planFingerprint,
  edit,
  included,
  grouped,
  asText,
  forKroger,
  summarise,
  productLabel,
  keyOf,
  mergeInto,
};
