'use strict';
/**
 * planner.js — the week grid (v3 F2, GOTK-165).
 *
 * The planner holds INTENTIONS. Nothing in here writes to `meals`, and there is
 * deliberately no function in this file that could: the only bridge from a plan
 * to the food log is the explicit confirmation in planner-confirm territory
 * (F3), which is the whole of Decision 1. If you are reading this because you
 * want the grid to log something automatically, that is the decision you would
 * be overturning.
 *
 * SUNDAY IS ABSENT BY DESIGN (Decision 3). It is not hidden in the UI and
 * present in the data — the week is six days, `weekDates()` returns six dates,
 * and every mutation refuses a Sunday outright. The owner called it a free day;
 * a planner that quietly kept a Sunday column in its store would eventually leak
 * it back into a briefing or a total, so the exclusion lives at the bottom.
 *
 * THE NO-GUILT RULE APPLIES HERE (Decision 4). Totals are computed and returned
 * as plain numbers with an `estimate` flag. This module has no notion of a
 * target, a budget, a remaining allowance, an over/under, or a comparison
 * between days — not "it doesn't show them", it cannot compute them, because
 * there is no field anywhere in this file that such a view could read.
 */
const nutrition = require('./nutrition');
const foods = require('./foods');
const recipesLib = require('./recipes');
const { localDate, newId } = require('./store');

const SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks'];
const SLOT_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };

/** The five figures the totals row shows, in the order Decision 4 fixes them. */
const TOTAL_FIELDS = [
  { key: 'calories_kcal', label: 'Calories', unit: '' },
  { key: 'protein_g', label: 'Protein', unit: 'g' },
  { key: 'fat_g', label: 'Fat', unit: 'g' },
  { key: 'carb_g', label: 'Carbs', unit: 'g' },
  { key: 'sodium_mg', label: 'Sodium', unit: 'mg' },
];

// ---------------------------------------------------------------------------
// week arithmetic, in the owner's timezone
// ---------------------------------------------------------------------------

/** Day of week (1 = Monday ... 7 = Sunday) for an instant, in a named zone. */
function isoDayOfWeek(date, timezone) {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'long' }).format(date);
  return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].indexOf(name) + 1;
}

/** Shift a YYYY-MM-DD by whole days without tripping over DST or month ends. */
function addDays(dateStr, n) {
  // Noon UTC: far enough from either midnight that a ±1h DST shift cannot move
  // the calendar date, which a midnight-anchored date would do twice a year.
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday that starts the week containing `now`, as YYYY-MM-DD. */
function weekStartOf(now, timezone) {
  const today = localDate(now, timezone);
  return addDays(today, -(isoDayOfWeek(now, timezone) - 1));
}

/**
 * The six plannable dates of a week: Monday through Saturday.
 * Sunday is not returned, because Sunday is not part of the week here.
 */
function weekDates(weekStart) {
  return [0, 1, 2, 3, 4, 5].map((i) => addDays(weekStart, i));
}

/** True if this date is the free day. The one question the planner asks a date. */
function isSunday(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay() === 0;
}

/** Day labels for the grid header, e.g. { date, weekday: 'Monday', short: 'Mon', dayNum: 23 }. */
function weekDays(weekStart) {
  return weekDates(weekStart).map((date) => {
    const d = new Date(`${date}T12:00:00Z`);
    const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(d);
    return {
      date,
      weekday,
      short: weekday.slice(0, 3),
      dayNum: d.getUTCDate(),
      month: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'short' }).format(d),
    };
  });
}

/**
 * The two weeks the owner may plan: this one and the next (Decision 3).
 * Not a rolling window into the future — the spec fixed it at two, and a
 * planner you can run six weeks ahead is a different product.
 *
 * JUDGEMENT CALL, flagged to the owner: what "the current week" means when it
 * is Sunday. By ISO reckoning Sunday belongs to the week that just ended, so a
 * literal reading would open the planner on six days that are all in the past.
 * Sunday is also the owner's established planning moment — v2 already puts the
 * meal-plan prompt on the page that day — so Sunday rolls forward to the week
 * about to start. Every other day behaves exactly as the spec says. If the
 * owner wants the literal reading instead, this function is the only change.
 */
function plannableWeeks(now, timezone) {
  const current = weekStartOf(now, timezone);
  const first = isoDayOfWeek(now, timezone) === 7 ? addDays(current, 7) : current;
  return [first, addDays(first, 7)];
}

// ---------------------------------------------------------------------------
// reading a plan
// ---------------------------------------------------------------------------

/** Resolve a stored entry against the library, so corrections flow through. */
function resolveEntry(store, entry) {
  const food = store.libraryItem(entry.foodId);
  // A slotted recipe is one serving unless the owner says otherwise (v4
  // Decision 4). Everything else is a single item and stays at 1.
  const servings = food && food.kind === 'recipe' ? servingsOf(entry) : 1;
  const base = food ? food.nutrition || {} : {};
  const scaled = {};
  for (const f of nutrition.NUMERIC_FIELDS) {
    const v = base[f];
    scaled[f] = v === null || v === undefined ? null : Math.round(v * servings * 10) / 10;
  }
  scaled.ultra_processed = base.ultra_processed === undefined ? null : base.ultra_processed;

  return {
    entryId: entry.id,
    foodId: entry.foodId,
    // The library row is the source of truth for name and figures: correcting a
    // food by chat must change every plan that uses it. `name` is kept on the
    // entry only as a fallback for a row that somehow went missing.
    name: food ? food.name : entry.name,
    quantity: food ? food.quantity : null,
    nutrition: scaled,
    missing: !food,
    // Present on every card so a client never has to ask what kind it is.
    kind: food ? food.kind || 'food' : 'food',
    isRecipe: Boolean(food && food.kind === 'recipe'),
    servings,
    // What one serving costs, so the card can show the arithmetic when a
    // recipe is slotted at more than one.
    perServing: food && food.kind === 'recipe' ? base : null,
  };
}

/** A slotted recipe's servings: at least a quarter, at most 24, default one. */
function servingsOf(entry) {
  const n = Number(entry.servings);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(n, 24) * 100) / 100;
}

/**
 * Daily totals from the slotted cards. Estimates, and labelled so. There is no
 * target in scope here and nothing to compare against — see the header note.
 */
function dayTotals(store, day) {
  const entries = SLOTS.flatMap((s) => (day?.[s] || []).map((e) => resolveEntry(store, e)));
  const sum = nutrition.total(entries.map((e) => ({ nutrition: e.nutrition })));
  return {
    fields: TOTAL_FIELDS.map((f) => ({ ...f, value: sum[f.key] })),
    estimate: true,
    count: entries.length,
  };
}

/** The whole week as the page renders it. */
function view(store, cfg, weekStart) {
  const dates = weekDates(weekStart);
  const plan = store.getPlan(weekStart);

  return {
    weekStart,
    // Six days. There is no Sunday key to omit — it was never generated.
    days: weekDays(weekStart).map((d) => {
      const day = plan?.days?.[d.date] || {};
      return {
        ...d,
        slots: SLOTS.map((slot) => ({
          slot,
          label: SLOT_LABELS[slot],
          cards: (day[slot] || []).map((e) => resolveEntry(store, e)),
        })),
        totals: dayTotals(store, day),
        confirmed: Boolean(plan?.confirmed?.[d.date]),
      };
    }),
    slots: SLOTS.map((s) => ({ slot: s, label: SLOT_LABELS[s] })),
    dates,
    empty: !plan || dates.every((d) => SLOTS.every((s) => !(plan.days?.[d]?.[s] || []).length)),
  };
}

// ---------------------------------------------------------------------------
// changing a plan
// ---------------------------------------------------------------------------

function guard(weekStart, date, slot) {
  // Sunday is checked FIRST. It would be refused anyway — it is not one of the
  // six dates — but "that date is not in this week" is a confusing thing to
  // say about a day that plainly is. The refusal should name the actual reason.
  if (isSunday(date)) return 'Sunday is a free day — it is not planned here.';
  if (!weekDates(weekStart).includes(date)) return 'That date is not in this week.';
  if (!SLOTS.includes(slot)) return `No such slot: ${slot}.`;
  return null;
}

/** Put a library item into a day slot. Multiple cards per slot are allowed. */
function assign(store, weekStart, { date, slot, foodId, servings }) {
  const bad = guard(weekStart, date, slot);
  if (bad) return { error: bad };
  const food = store.libraryItem(foodId);
  if (!food) return { error: 'That is not in the library.' };

  const plan = store.ensurePlan(weekStart, weekDates(weekStart));
  const entry = { id: newId('slot'), foodId: food.id, name: food.name, addedAt: new Date().toISOString() };
  // Stored only for recipes: a food has no servings dimension to set.
  if (food.kind === 'recipe') entry.servings = servingsOf({ servings });
  plan.days[date][slot].push(entry);
  store.touchPlan(weekStart);
  return { entry: resolveEntry(store, entry), date, slot };
}

/** Find an entry anywhere in a week. Returns { entry, date, slot, index }. */
function locate(plan, entryId) {
  for (const [date, day] of Object.entries(plan?.days || {})) {
    for (const slot of SLOTS) {
      const index = (day[slot] || []).findIndex((e) => e.id === entryId);
      if (index !== -1) return { entry: day[slot][index], date, slot, index };
    }
  }
  return null;
}

/** Take a card out of the grid. Never touches the library row it points at. */
function remove(store, weekStart, entryId) {
  const plan = store.getPlan(weekStart);
  const found = plan && locate(plan, entryId);
  if (!found) return { error: 'That card is not in this week.' };
  plan.days[found.date][found.slot].splice(found.index, 1);
  store.touchPlan(weekStart);
  // Explicit: removing a card from a day does not remove the food from the
  // library, and the response says so, so no client can render it as a delete.
  return { removed: entryId, deletedFromLibrary: false };
}

/** Drag a card from one slot to another. A move, not a copy. */
function move(store, weekStart, entryId, { date, slot }) {
  const bad = guard(weekStart, date, slot);
  if (bad) return { error: bad };
  const plan = store.getPlan(weekStart);
  const found = plan && locate(plan, entryId);
  if (!found) return { error: 'That card is not in this week.' };

  plan.days[found.date][found.slot].splice(found.index, 1);
  store.ensurePlan(weekStart, weekDates(weekStart));
  plan.days[date][slot].push(found.entry);
  store.touchPlan(weekStart);
  return { entry: resolveEntry(store, found.entry), date, slot, from: { date: found.date, slot: found.slot } };
}

/**
 * Slot -> favourite tile. Decision 5 calls this a COPY: the day keeps its meal.
 * That is why this returns without touching the grid at all — the favourite is
 * a pin of the same library row, and the card stays exactly where it was.
 */
function pinFromSlot(store, weekStart, entryId, slot = null) {
  const plan = store.getPlan(weekStart);
  const found = plan && locate(plan, entryId);
  if (!found) return { error: 'That card is not in this week.' };
  const out = store.pinFavorite(found.entry.foodId, slot);
  if (out.error) return { error: out.error };
  return {
    ...out,
    // The day is untouched. Stated in the payload because "copy, not move" is
    // the half of Decision 5 most likely to be got wrong by a future client.
    keptInDay: { date: found.date, slot: found.slot, entryId },
  };
}

/**
 * Which slots a proposal may fill (v5 F2/F3).
 *
 * Decision 3: the coach never overwrites an owner-placed card; it plans around
 * what is already there. That is done by only ever offering EMPTY slots as
 * candidates — the proposer is told what is free, so proposing over something
 * is not a thing it can decide to do. A card the owner adds after a proposal
 * is made is caught again at apply time, below.
 */
function openSlots(store, weekStart, dates) {
  const plan = store.getPlan(weekStart);
  const out = [];
  for (const date of weekDates(weekStart)) {
    if (dates && !dates.includes(date)) continue;
    const day = plan?.days?.[date] || {};
    for (const slot of SLOTS) {
      if (!(day[slot] || []).length) out.push({ date, slot });
    }
  }
  return out;
}

/**
 * Commit a proposal, or some of its days, into the real plan (v5 F3).
 *
 * This is the ONLY function in the app that moves a proposed card into the
 * grid, and it is reached only from an explicit owner action. Two rules it
 * enforces rather than assumes:
 *
 *   - A slot the owner has filled since the proposal was made is left alone
 *     and reported as skipped. The grid the owner is looking at wins over the
 *     grid the coach was looking at.
 *   - Sunday can never be applied. It cannot be proposed either, but a
 *     proposal is data and data can be edited, so the refusal is repeated at
 *     the point of the write.
 */
function applyProposal(store, proposal, { dates = null } = {}) {
  const weekStart = proposal.weekStart;
  const wanted = dates && dates.length ? dates : proposal.dates;
  const placed = [];
  const skipped = [];

  for (const date of wanted) {
    if (isSunday(date) || !weekDates(weekStart).includes(date)) {
      skipped.push({ date, why: 'not a planned day' });
      continue;
    }
    const day = proposal.days[date] || {};
    for (const slot of SLOTS) {
      for (const card of day[slot] || []) {
        const plan = store.ensurePlan(weekStart, weekDates(weekStart));
        if ((plan.days[date][slot] || []).length) {
          skipped.push({ date, slot, name: card.name, why: 'you had already put something there' });
          continue;
        }
        const out = assign(store, weekStart, {
          date, slot, foodId: card.foodId, servings: card.servings,
        });
        if (out.error) skipped.push({ date, slot, name: card.name, why: out.error });
        else placed.push({ date, slot, name: out.entry.name, servings: out.entry.servings });
      }
    }
  }
  return { placed, skipped, weekStart, dates: wanted };
}

/**
 * The week's shopping list, with planned recipes expanded (v4 Decision 5).
 *
 * Computed here rather than left to the coach's prose, so that the scaling and
 * the merging are deterministic and testable. What comes back is a list of
 * lines; the coach groups and words them, and the Kroger handoff receives the
 * result unchanged — a recipe needs no new external behaviour.
 *
 * THE SCALING. A recipe planned for 2 servings when it is written for 4 needs
 * half of each ingredient. The numeric `amount` scales exactly, because that is
 * what it is for. The free-text quantity is rescaled only when it honestly can
 * be — "400 g" halves, "a pinch" does not — and anything that cannot is passed
 * through as written and marked, so the list never invents a measurement.
 *
 * THE MERGING is by library item, not by name: two recipes calling the same
 * item merge even if one says "onion" and the other "yellow onion", because
 * both rows point at the same library row. Unlinked rows fall back to matching
 * on name, which is the best that can be done for something the library has
 * never seen.
 */
function joinQuantities(parts) {
  // Deliberately NOT de-duplicated: the same dish planned on two nights
  // contributes the same quantity twice, and that is two lots to buy. An
  // earlier version used a Set here and quietly halved the week's shopping —
  // the multiplier stayed right while the number the owner actually reads
  // did not.
  const list = parts.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];

  // Same unit throughout? Then the numbers add.
  const parsed = list.map((t) => /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(String(t)));
  if (parsed.every(Boolean)) {
    const units = new Set(parsed.map((m) => m[2].trim().toLowerCase().replace(/s$/, '')));
    if (units.size === 1) {
      const total = Math.round(parsed.reduce((a, m) => a + Number(m[1]), 0) * 100) / 100;
      const unit = parsed[0][2].trim();
      return `${total}${unit ? ` ${recipesLib.scaleQuantity(`1 ${unit}`, total).text.replace(/^[\d.]+\s*/, '')}` : ''}`;
    }
  }
  // Units that do not match are listed side by side. Identical un-summable
  // strings collapse, because "a pinch + a pinch" helps nobody.
  return [...new Set(list)].join(' + ');
}

function shoppingList(store, cfg, weekStart) {
  const plan = store.getPlan(weekStart);
  const merged = new Map();

  const add = (key, line) => {
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...line, fromRecipes: line.fromRecipes ? [...line.fromRecipes] : [] });
      return;
    }
    existing.amount = Math.round((existing.amount + line.amount) * 100) / 100;
    existing.quantities.push(...line.quantities);
    for (const r of line.fromRecipes || []) if (!existing.fromRecipes.includes(r)) existing.fromRecipes.push(r);
  };

  for (const date of weekDates(weekStart)) {
    const day = plan?.days?.[date];
    if (!day) continue;
    for (const slot of SLOTS) {
      for (const entry of day[slot] || []) {
        const item = store.libraryItem(entry.foodId);
        if (!item) continue;

        if (item.kind !== 'recipe') {
          add(entry.foodId, {
            foodId: entry.foodId, name: item.name, amount: 1,
            quantities: item.quantity ? [item.quantity] : [], fromRecipes: [],
          });
          continue;
        }

        // A recipe becomes its ingredients, scaled by planned servings.
        const recipe = store.getRecipe(entry.foodId);
        const planned = servingsOf(entry);
        const factor = planned / Math.max(parseInt(recipe.servings, 10) || 1, 1);
        for (const row of recipe.ingredients || []) {
          const q = recipesLib.scaleQuantity(row.quantity, factor);
          // "(as written)" means scaling was NEEDED and could not be done
          // honestly — not that the factor happened to be one, in which case
          // the quantity is already exactly right.
          const couldNotScale = factor !== 1 && !q.scaled && Boolean(q.text);
          add(row.foodId || `name:${recipesLib.normaliseIngredients([row])[0].name.toLowerCase()}`, {
            foodId: row.foodId || null,
            name: row.name,
            amount: Math.round((row.amount || 1) * factor * 100) / 100,
            quantities: q.text ? [q.text + (couldNotScale ? ' (as written)' : '')] : [],
            fromRecipes: [recipe.name],
          });
        }
      }
    }
  }

  const lines = [...merged.values()].map((l) => ({
    ...l,
    // One readable quantity. Parts that share a unit are added up — "1 onion"
    // and "0.5 onion" is 1.5 onions on a shopping list, not a sum to do in the
    // aisle. Parts that do not share a unit are listed side by side rather
    // than guessed at: "200 g + a pinch" is honest, "200.1 g" would not be.
    quantity: joinQuantities(l.quantities),
  }));

  return {
    weekStart,
    lines: lines.sort((a, b) => a.name.localeCompare(b.name)),
    // Stated so the coach can say the list came from the plan rather than from
    // a fortnight of history — and so a test can tell the difference.
    fromPlan: lines.length > 0,
    recipesExpanded: [...new Set(lines.flatMap((l) => l.fromRecipes))],
  };
}

/**
 * Change how many servings of a slotted recipe are planned (v4 Decision 4).
 * Refused on a plain food, which has no servings dimension to set.
 */
function setServings(store, weekStart, entryId, servings) {
  const plan = store.getPlan(weekStart);
  const found = plan && locate(plan, entryId);
  if (!found) return { error: 'That card is not in this week.' };
  const item = store.libraryItem(found.entry.foodId);
  if (!item || item.kind !== 'recipe') return { error: 'Only a recipe has servings to set.' };
  found.entry.servings = servingsOf({ servings });
  store.touchPlan(weekStart);
  return { entry: resolveEntry(store, found.entry), date: found.date, slot: found.slot };
}

/** A one-line, verdict-free reading of a day's plan, for the briefing (F4). */
function plannedLine(store, cfg, dateStr) {
  if (isSunday(dateStr)) return null; // never, per Decision 3
  const weekStart = addDays(dateStr, -(new Date(`${dateStr}T12:00:00Z`).getUTCDay() || 7) + 1);
  const plan = store.getPlan(weekStart);
  const day = plan?.days?.[dateStr];
  if (!day) return null;

  const parts = SLOTS.map((slot) => {
    const cards = (day[slot] || []).map((e) => resolveEntry(store, e).name);
    return cards.length ? `${SLOT_LABELS[slot]}: ${cards.join(', ')}` : null;
  }).filter(Boolean);

  return parts.length ? parts.join(' · ') : null;
}

module.exports = {
  SLOTS,
  SLOT_LABELS,
  TOTAL_FIELDS,
  isoDayOfWeek,
  addDays,
  weekStartOf,
  weekDates,
  weekDays,
  isSunday,
  plannableWeeks,
  view,
  dayTotals,
  resolveEntry,
  assign,
  remove,
  move,
  locate,
  openSlots,
  applyProposal,
  shoppingList,
  setServings,
  servingsOf,
  pinFromSlot,
  plannedLine,
};
