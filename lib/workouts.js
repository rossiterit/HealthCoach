'use strict';
/**
 * workouts.js — the workout MENU and the movement ledger's reading side (F3/F4).
 *
 * A menu, never a calendar. Nothing here schedules anything onto a date; the
 * briefing offers one suggestion and the owner takes it, trades it down, or
 * ignores it. That is the whole contract, and it is why this file has a
 * `suggest()` and no `plan()`.
 *
 * THE FLOOR. Walking the dogs counts, every time. Not as a fallback, not as
 * "at least", not as a lesser thing that keeps a number alive — as movement,
 * recorded the same way as an hour at the gym. It is the only outlet marked
 * `isFloor`, and the suggestion logic can never rank it out of reach.
 *
 * WHY THE SUGGESTION IS DETERMINISTIC. Picking the outlet in code rather than
 * letting the model choose keeps it testable and keeps it honest: the model
 * phrases the suggestion, but it cannot invent an outlet the owner does not
 * have, and it cannot drift into scheduling. The reason attached to each
 * suggestion is about FIT — what suits today — never about elapsed time since
 * the owner last did something. Recency is used internally for variety; it is
 * never surfaced as a count, because "you haven't been on the bike in nine
 * days" is a guilt engine wearing a helpful voice.
 */
const { localDate } = require('./store');

/** Fallback outlets if config.json omits them. Kept in sync with the spec. */
const DEFAULT_OUTLETS = [
  { id: 'koko', label: 'Koko Fitness', kind: 'strength', typicalMinutes: 45, needs: 'a trip out' },
  { id: 'weights', label: 'Home free weights', kind: 'strength', typicalMinutes: 30, needs: 'nothing' },
  { id: 'stationary-bike', label: 'Stationary bike', kind: 'cardio', typicalMinutes: 30, needs: 'nothing' },
  { id: 'commuter-bike', label: 'Commuter bike', kind: 'cardio', typicalMinutes: 40, needs: 'daylight and dry-ish weather' },
  { id: 'dog-walk', label: 'Walking the dogs', kind: 'walk', typicalMinutes: 30, needs: 'nothing', isFloor: true },
];

function outlets(cfg) {
  const list = (cfg && cfg.fitness && cfg.fitness.outlets) || DEFAULT_OUTLETS;
  return list.map((o) => ({ ...o }));
}

function floorOutlet(cfg) {
  return outlets(cfg).find((o) => o.isFloor) || outlets(cfg)[outlets(cfg).length - 1];
}

function findOutlet(cfg, idOrLabel) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(idOrLabel);
  if (!t) return null;
  const list = outlets(cfg);
  return (
    list.find((o) => norm(o.id) === t) ||
    list.find((o) => norm(o.label) === t) ||
    list.find((o) => norm(o.label).includes(t) || t.includes(norm(o.id))) ||
    null
  );
}

/**
 * Suggest ONE outlet for today.
 *
 * Weighting, in order of influence:
 *   - what the owner actually uses (an outlet they have logged is favoured over
 *     one they never touch — the menu should reflect their life, not our idea
 *     of a balanced week),
 *   - variety (an outlet used in the last couple of days is deprioritised, so
 *     the suggestion does not become a broken record),
 *   - the day itself (a longer outlet at the weekend, an easy one midweek).
 *
 * Returns { outlet, reason, tradeDown } — `reason` is fit-based and safe to
 * surface; `tradeDown` is always the floor unless the suggestion IS the floor.
 */
function suggest(store, cfg, now = new Date()) {
  const list = outlets(cfg);
  const recent = store.recentWorkouts(30);
  const today = localDate(now, cfg.timezone);

  // How often each outlet actually gets used, and how recently. Recency here is
  // an internal ordering signal only — it never reaches the owner as a number.
  const usage = new Map(list.map((o) => [o.id, { count: 0, lastDate: null }]));
  for (const w of recent) {
    const u = usage.get(w.outletId);
    if (!u) continue;
    u.count += 1;
    const d = localDate(w.ts, cfg.timezone);
    if (!u.lastDate || d > u.lastDate) u.lastDate = d;
  }

  const dow = new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timezone, weekday: 'short' }).format(now);
  const isWeekend = dow === 'Sat' || dow === 'Sun';

  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  const scored = list.map((o) => {
    const u = usage.get(o.id);
    let score = 0;

    // Favour what they actually do. Unused outlets stay on the menu but are not
    // pushed — a suggestion for something they never choose is noise.
    score += Math.min(u.count, 6) * 2;

    // Variety: something done in the last two days drops down the list.
    if (u.lastDate) {
      const gap = daysBetween(u.lastDate, today);
      // Strong enough to outrank a heavily-used outlet: suggesting the same
      // thing two days running is how a menu turns into a broken record.
      if (gap <= 1) score -= 14;
      else if (gap === 2) score -= 4;
    }

    // Fit for the day.
    if (isWeekend && o.typicalMinutes >= 40) score += 3;
    if (!isWeekend && o.typicalMinutes <= 30) score += 2;

    // The floor is always viable, never the default pick when they have options.
    if (o.isFloor) score -= 1;

    return { outlet: o, score };
  });

  scored.sort((a, b) => b.score - a.score || a.outlet.label.localeCompare(b.outlet.label));
  const pick = scored[0].outlet;

  const reason = reasonFor(pick, { isWeekend });
  const floor = floorOutlet(cfg);
  return {
    outlet: pick,
    reason,
    tradeDown: pick.isFloor ? null : floor,
  };
}

/** A fit-based reason. Never references elapsed time, gaps, or what was skipped. */
function reasonFor(outlet, { isWeekend }) {
  if (outlet.isFloor) return 'Always a good one, and it counts.';
  if (isWeekend && outlet.typicalMinutes >= 40) return 'There is time for a longer one today.';
  if (outlet.needs === 'nothing') return 'Nothing to organise for this one.';
  if (outlet.kind === 'strength') return 'Good day for something with weight in it.';
  if (outlet.kind === 'cardio') return 'Good day to get the legs going.';
  return 'Fits today.';
}

/**
 * What was done in a window, most recent first. Reports what HAPPENED — there is
 * deliberately no "days active", no gap count and no comparison to a target.
 */
function summary(store, cfg, days = 7, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 86400000);
  const rows = store.data.workouts
    .filter((w) => new Date(w.ts) >= cutoff)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));

  const byOutlet = new Map();
  let totalMinutes = 0;
  for (const w of rows) {
    const key = w.outletLabel || w.outletId || 'movement';
    const e = byOutlet.get(key) || { label: key, count: 0, minutes: 0 };
    e.count += 1;
    e.minutes += Number(w.durationMinutes) || 0;
    byOutlet.set(key, e);
    totalMinutes += Number(w.durationMinutes) || 0;
  }

  return {
    days,
    count: rows.length,
    totalMinutes,
    byOutlet: [...byOutlet.values()].sort((a, b) => b.count - a.count),
    entries: rows.map((w) => ({ ...w, date: localDate(w.ts, cfg.timezone) })),
  };
}

/** One line for the briefing or the page. States what was done, nothing else. */
function summaryLine(store, cfg, days = 7, now = new Date()) {
  const s = summary(store, cfg, days, now);
  if (!s.count) return 'Nothing recorded this week yet.';
  const parts = s.byOutlet.map((o) => `${o.label}${o.count > 1 ? ` x${o.count}` : ''}`);
  const mins = s.totalMinutes ? `, about ${s.totalMinutes} minutes all in` : '';
  return `This week: ${parts.join(', ')}${mins}.`;
}

/** Compact block for the coach's prompt. */
function promptSummary(store, cfg, now = new Date()) {
  const list = outlets(cfg);
  const menu = list.map((o) => `${o.label} (${o.kind}, ~${o.typicalMinutes} min${o.isFloor ? ', THE FLOOR — always counts' : ''})`).join('; ');
  const s = suggest(store, cfg, now);
  const week = summaryLine(store, cfg, 7, now);

  return [
    `Their outlets: ${menu}.`,
    `Today's suggestion, already chosen for you: ${s.outlet.label} — ${s.reason}` +
      (s.tradeDown ? ` Trade-down if it is not happening: ${s.tradeDown.label}.` : ''),
    week,
  ].join('\n');
}

module.exports = {
  outlets,
  floorOutlet,
  findOutlet,
  suggest,
  summary,
  summaryLine,
  promptSummary,
  DEFAULT_OUTLETS,
};
