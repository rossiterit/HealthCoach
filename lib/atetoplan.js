'use strict';
/**
 * atetoplan.js — the one bridge from plan to log (v3 F3, GOTK-166).
 *
 * Decision 1: "Planner plans; chat logs. Nothing ever auto-logs from the plan."
 * This module is the single exception, and it is an exception the owner has to
 * ask for out loud — by saying "ate to plan" in chat, or by pressing the
 * confirm control on a day. It lives in its own file rather than in planner.js
 * precisely so that planner.js can keep the property that nothing in it writes
 * a meal; a test enforces that, and folding this in would quietly end it.
 *
 * What it writes: ordinary rows in `meals`, exactly like conversational
 * logging, but stamped `source: 'planned_confirmed'` so the history stays
 * honest about how they got there. They remain estimates — they were estimates
 * as plans and confirming an intention does not measure anything — and they are
 * correctable by reply like any other row, because they are any other row.
 *
 * Two refusals are deliberate and load-bearing:
 *   - Sunday is never confirmable (Decision 3). It has no plan to confirm.
 *   - A day never confirms twice. Without that, "ate to plan" said twice in one
 *     evening silently doubles the day's food, and the owner would have no way
 *     of knowing except by reading the log.
 */
const planner = require('./planner');
const { localDate } = require('./store');

/**
 * Slot -> the meal_type the rest of the app uses, and a default time of day.
 *
 * JUDGEMENT CALL, flagged: a plan says what, never when. Something has to go in
 * the timestamp, and bucketing every confirmed meal at the moment of confirming
 * would put breakfast at 9pm and make the day's shape a lie. These are ordinary
 * hours in the owner's own timezone; they are a default, not a claim, and any
 * of them is correctable by reply.
 */
const SLOT_META = {
  breakfast: { mealType: 'breakfast', hour: 8, minute: 0 },
  lunch: { mealType: 'lunch', hour: 12, minute: 30 },
  dinner: { mealType: 'dinner', hour: 19, minute: 0 },
  snacks: { mealType: 'snack', hour: 15, minute: 30 },
};

/** An ISO instant for a wall-clock time on a date in a named zone. */
function instantAt(dateStr, hour, minute, timezone) {
  // Find the offset the zone is actually running at on that date (which is not
  // constant — it moves at a DST boundary) by comparing the same instant
  // rendered in the zone and in UTC.
  const probe = new Date(`${dateStr}T12:00:00Z`);
  const asZone = new Date(probe.toLocaleString('en-US', { timeZone: timezone }));
  const asUtc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetMs = asUtc.getTime() - asZone.getTime();
  return new Date(Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`) + offsetMs).toISOString();
}

/** The week a date belongs to, for reaching its plan. */
function weekOf(dateStr) {
  const dow = new Date(`${dateStr}T12:00:00Z`).getUTCDay() || 7; // 1=Mon..7=Sun
  return planner.addDays(dateStr, -(dow - 1));
}

/** What a day's plan holds, slot by slot — the thing a confirmation would write. */
function preview(store, cfg, dateStr) {
  const plan = store.getPlan(weekOf(dateStr));
  const day = plan?.days?.[dateStr] || {};
  return planner.SLOTS.map((slot) => ({
    slot,
    label: planner.SLOT_LABELS[slot],
    cards: (day[slot] || []).map((e) => planner.resolveEntry(store, e)),
  })).filter((s) => s.cards.length);
}

function isConfirmed(store, dateStr) {
  const plan = store.getPlan(weekOf(dateStr));
  return Boolean(plan?.confirmed?.[dateStr]);
}

/**
 * Write a day's planned meals to the food log.
 *
 * @param {string[]} except slot names the owner said were NOT as planned
 *   ("ate to plan except lunch was leftovers"). Those slots are skipped
 *   entirely, leaving the real lunch to be logged conversationally as usual —
 *   which is the existing, well-tested path, rather than a second one.
 * @returns {{logged?:object[], skipped?:string[], error?:string}}
 */
function confirm(store, cfg, dateStr, { except = [] } = {}) {
  if (planner.isSunday(dateStr)) {
    return { error: 'Sunday is a free day — there is no plan for it to have gone to.' };
  }
  if (isConfirmed(store, dateStr)) {
    return { error: `${dateStr} is already confirmed. Correct any of the logged meals by telling me what was different.` };
  }

  const skip = new Set((except || []).map((s) => String(s).toLowerCase().replace(/s$/, '')));
  const slots = preview(store, cfg, dateStr);
  if (!slots.length) return { error: `There is nothing planned for ${dateStr} to confirm.` };

  const logged = [];
  const skipped = [];
  for (const s of slots) {
    // 'snacks' and 'snack' both match, so the owner's wording does not matter.
    if (skip.has(s.slot.replace(/s$/, ''))) { skipped.push(s.slot); continue; }
    const meta = SLOT_META[s.slot];
    for (const card of s.cards) {
      logged.push(
        store.addMeal({
          ts: instantAt(dateStr, meta.hour, meta.minute, cfg.timezone),
          description: card.name,
          mealType: meta.mealType,
          items: [{ name: card.name, quantity: card.quantity || null, nutrition: card.nutrition || {} }],
          nutrition: card.nutrition || {},
          // The provenance that makes this honest: these rows came from a plan
          // the owner confirmed, not from them describing a meal.
          source: 'planned_confirmed',
          estimate: true,
          notes: 'Confirmed from the week plan.',
        }),
      );
    }
  }

  if (!logged.length) {
    return { error: `Everything planned for ${dateStr} was in the "except" list, so there was nothing to log.` };
  }

  const plan = store.getPlan(weekOf(dateStr));
  plan.confirmed[dateStr] = {
    at: new Date().toISOString(),
    mealIds: logged.map((m) => m.id),
    except: skipped,
  };
  store.touchPlan(weekOf(dateStr));

  return { logged, skipped, date: dateStr };
}

/** The plain sentence the coach and the page both echo back. */
function echo(out) {
  if (out.error) return out.error;
  const names = out.logged.map((m) => m.description).join(', ');
  const tail = out.skipped.length
    ? ` I left ${out.skipped.join(' and ')} out — tell me what you had instead and I will log it.`
    : '';
  return `Logged ${out.logged.length} meal${out.logged.length === 1 ? '' : 's'} from your plan: ${names}.${tail}`;
}

/** Today, in the owner's timezone. The default subject of "ate to plan". */
function today(cfg) {
  return localDate(new Date(), cfg.timezone);
}

module.exports = { confirm, preview, isConfirmed, echo, today, weekOf, instantAt, SLOT_META };
