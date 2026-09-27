'use strict';
/**
 * shoppinglist.js — the reviewed shopping list (v5 F4, Decision 9, GOTK-179).
 *
 * The list has always been generated from the plan grid (v4 F4). What is new
 * is a REVIEW STEP between generating it and doing anything with it: the owner
 * culls what they already have, fixes a quantity, adds the thing that was never
 * in the plan, and only then copies it or sends it.
 *
 * WHY THAT MATTERS BEYOND CONVENIENCE: it puts the same checkpoint in front of
 * the Kroger send that the planner's Apply puts in front of the grid. The cart
 * call now carries exactly what the owner ticked, and they have seen the list
 * as a list before it becomes an order.
 *
 * EXCLUSIONS ARE SILENT (Decision 9). Unticking something asks no question and
 * draws no comment — no "are you sure", no "that was for Tuesday's curry". The
 * no-guilt rule covers shopping too: what they choose not to buy is not the
 * app's business.
 *
 * The reviewed state persists until regenerated, so closing the modal and
 * coming back shows the same ticks. Regenerating from the grid resets it and
 * says so, because a silent reset would quietly undo a cull they had made.
 */
const claude = require('./claude');
const planner = require('./planner');

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

const CATEGORY_TOOL = {
  name: 'record_categories',
  description: 'Put each shopping item in the aisle you would find it in.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The item, copied exactly as given.' },
            category: { type: 'string', enum: CATEGORIES },
          },
          required: ['name', 'category'],
        },
      },
    },
    required: ['items'],
  },
};

const CATEGORY_SYSTEM = `You sort shopping-list lines into supermarket aisles. That is the whole job.

- Use only the categories offered. If something genuinely does not fit, use "Other".
- Copy each name back exactly as given, so it can be matched up.
- A line may be a plain ingredient ("rolled oats") or the name of a dish someone planned to eat ("chicken caesar salad"). For a dish, file it where its MAIN ingredient lives — a caesar salad under Meat & fish for the chicken, eggs on toast under Dairy & eggs. Do not put a dish under Frozen unless it is actually a frozen product.
- Say nothing about the items themselves: no comment on what they are, whether they go together, or what someone might be cooking. You are labelling rows, not reading a diet.

Call record_categories exactly once, covering every item. Do not reply with prose.`;

/**
 * Ask which aisle each item belongs in, in ONE call for the whole list.
 *
 * Fails soft: anything unclassified becomes "Other", which is a slightly
 * untidy list rather than no list at all.
 */
async function categorise(cfg, names) {
  const out = new Map();
  if (!names.length) return out;
  try {
    const res = await claude.complete(cfg, {
      system: CATEGORY_SYSTEM,
      messages: [{ role: 'user', content: names.map((n) => `- ${n}`).join('\n') }],
      tools: [CATEGORY_TOOL],
    });
    const call = claude.toolUsesOf(res).find((t) => t.name === CATEGORY_TOOL.name);
    for (const row of (call && call.input && call.input.items) || []) {
      if (row && row.name && CATEGORIES.includes(row.category)) out.set(String(row.name), row.category);
    }
  } catch {
    /* fail soft: everything falls through to Other */
  }
  return out;
}

/** A stable key per line, so ticks survive a re-render. */
function keyOf(line) {
  return line.foodId || `name:${String(line.name || '').toLowerCase()}`;
}

/**
 * Generate the reviewed list from the week's grid.
 *
 * Deliberately destructive of any previous review for that week — that is what
 * "regenerating resets it" means — and the caller tells the owner so.
 */
async function generate(store, cfg, weekStart) {
  const source = planner.shoppingList(store, cfg, weekStart);
  const cats = await categorise(cfg, source.lines.map((l) => l.name));

  const items = source.lines.map((l) => ({
    key: keyOf(l),
    foodId: l.foodId || null,
    name: l.name,
    quantity: l.quantity || '',
    category: cats.get(l.name) || 'Other',
    // Everything starts ticked: the review is for taking things OUT, and a
    // list that arrives empty would make the owner do the work twice.
    included: true,
    fromRecipes: l.fromRecipes || [],
    manual: false,
  }));

  const list = {
    weekStart,
    generatedAt: new Date().toISOString(),
    items,
    recipesExpanded: source.recipesExpanded,
    fromPlan: source.fromPlan,
  };
  store.setShoppingList(weekStart, list);
  return list;
}

/** The saved review for a week, or null when one was never generated. */
function get(store, weekStart) {
  return store.getShoppingList(weekStart);
}

/** Apply one owner edit. Silent by design — no confirmations anywhere. */
function edit(store, weekStart, action, payload = {}) {
  const list = store.getShoppingList(weekStart);
  if (!list) return { error: 'There is no list to review yet.' };
  const items = list.items;

  if (action === 'toggle') {
    const row = items.find((i) => i.key === payload.key);
    if (!row) return { error: 'That item is not on the list.' };
    row.included = payload.included === undefined ? !row.included : Boolean(payload.included);
  } else if (action === 'quantity') {
    const row = items.find((i) => i.key === payload.key);
    if (!row) return { error: 'That item is not on the list.' };
    row.quantity = String(payload.quantity || '').slice(0, 80);
  } else if (action === 'remove') {
    const i = items.findIndex((x) => x.key === payload.key);
    if (i === -1) return { error: 'That item is not on the list.' };
    items.splice(i, 1);
  } else if (action === 'add') {
    const name = String(payload.name || '').trim().slice(0, 200);
    if (!name) return { error: 'Give the item a name.' };
    items.push({
      key: `manual:${name.toLowerCase()}:${items.length}`,
      foodId: null,
      name,
      quantity: String(payload.quantity || '').slice(0, 80),
      category: CATEGORIES.includes(payload.category) ? payload.category : 'Other',
      included: true,
      fromRecipes: [],
      // Marked so regenerating can tell the owner what it is about to lose.
      manual: true,
    });
  } else {
    return { error: `No such action: ${action}.` };
  }

  store.setShoppingList(weekStart, list);
  return { list };
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

/** The plain text the Copy button puts on the clipboard. */
function asText(list) {
  const groups = grouped(list);
  if (!groups.length) return 'Nothing ticked.';
  return groups
    .map((g) => `${g.category}\n${g.items.map((i) => `- ${i.name}${i.quantity ? ` — ${i.quantity}` : ''}`).join('\n')}`)
    .join('\n\n');
}

/** What the Kroger handoff receives: ticked items only, as grocery lines. */
function forKroger(list) {
  return included(list).map((i) => ({ name: i.name, quantity: 1 }));
}

module.exports = {
  CATEGORIES,
  CATEGORY_TOOL,
  CATEGORY_SYSTEM,
  categorise,
  generate,
  get,
  edit,
  included,
  grouped,
  asText,
  forKroger,
  keyOf,
};
