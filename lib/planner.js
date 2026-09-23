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
  const food = store.getFood(entry.foodId);
  return {
    entryId: entry.id,
    foodId: entry.foodId,
    // The library row is the source of truth for name and figures: correcting a
    // food by chat must change every plan that uses it. `name` is kept on the
    // entry only as a fallback for a row that somehow went missing.
    name: food ? food.name : entry.name,
    quantity: food ? food.quantity : null,
    nutrition: food ? food.nutrition : {},
    missing: !food,
  };
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
function assign(store, weekStart, { date, slot, foodId }) {
  const bad = guard(weekStart, date, slot);
  if (bad) return { error: bad };
  const food = store.getFood(foodId);
  if (!food) return { error: 'That is not in the library.' };

  const plan = store.ensurePlan(weekStart, weekDates(weekStart));
  const entry = { id: newId('slot'), foodId: food.id, name: food.name, addedAt: new Date().toISOString() };
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
  pinFromSlot,
  plannedLine,
};
