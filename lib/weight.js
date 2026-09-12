'use strict';
/**
 * weight.js — weight as a trend, never a verdict (F5, GOTK-161).
 *
 * Units: POUNDS. The owner chose lb on 2026-09-12; the reserved v1 field was
 * `kg` and was never written to, so the rename cost no data. Everything here is
 * lb end to end — no conversion layer, because a silent unit conversion is a
 * good way to eventually show someone the wrong number.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT COMPUTE.
 * No target. No distance-from-goal. No "on track" / "off track". No per-day
 * verdict, no comparison to yesterday, no projection, and no valence attached
 * to a direction. A rise is not bad news and a fall is not a win — both are
 * just the line. The scale moment belongs to the owner, and the app's whole job
 * is to hold the numbers steady enough to see a shape in them.
 *
 * `direction` is returned as up / down / level with no adjective, and the page
 * renders the line in plain ink with no red or green, because colour-coding a
 * direction is a verdict delivered without words.
 *
 * Day-to-day weight is mostly water and timing. That is why the window
 * comparison averages each half rather than diffing two single readings — a
 * two-point diff turns noise into a story.
 */
const { localDate } = require('./store');

/** Round to one decimal — more precision than that is noise pretending to be signal. */
function r1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * The trend over a window.
 *
 * @returns {{days:number, points:Array, count:number, latest:object|null,
 *            changeLb:number|null, direction:'up'|'down'|'level'|null,
 *            enough:boolean, min:number|null, max:number|null}}
 *   `enough` is false when there are too few readings to say anything at all —
 *   the caller should show the readings and no shape, rather than inventing one.
 */
function trend(store, cfg, days = 7, now = new Date()) {
  const cutoff = new Date(now.getTime() - days * 86400000);
  const rows = store.data.weight
    .filter((w) => new Date(w.ts) >= cutoff)
    .sort((a, b) => (a.ts < b.ts ? -1 : 1));

  const points = rows.map((w) => ({ id: w.id, ts: w.ts, date: localDate(w.ts, cfg.timezone), lb: w.lb, notes: w.notes || '' }));
  const values = points.map((p) => p.lb).filter((v) => typeof v === 'number');

  const base = {
    days,
    points,
    count: points.length,
    latest: points.length ? points[points.length - 1] : null,
    min: values.length ? r1(Math.min(...values)) : null,
    max: values.length ? r1(Math.max(...values)) : null,
  };

  // One reading is a reading, not a trend. Say so rather than drawing a line
  // through a single point.
  if (values.length < 2) {
    return { ...base, changeLb: null, direction: null, enough: false };
  }

  // Compare the average of each half of the window. Averaging absorbs the
  // water-weight noise that makes a two-point diff read as a story.
  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid || 1);
  const secondHalf = values.slice(mid);
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const change = r1(avg(secondHalf) - avg(firstHalf));

  // A quarter-pound is not a direction. Below that it is level, and level is a
  // perfectly good answer.
  let direction = 'level';
  if (change <= -0.25) direction = 'down';
  else if (change >= 0.25) direction = 'up';

  return { ...base, changeLb: change, direction, enough: true };
}

/**
 * A neutral sentence describing the trend, safe to show or to give the coach.
 * States the shape. Attaches no judgement, no target and no encouragement —
 * encouragement about a direction is a verdict with a smile on it.
 */
function line(store, cfg, days = 7, now = new Date()) {
  const t = trend(store, cfg, days, now);
  if (!t.count) return 'No weight logged yet.';
  if (!t.enough) return `One reading so far: ${t.latest.lb} lb.`;
  const mag = Math.abs(t.changeLb);
  if (t.direction === 'level') return `Last ${days} days: holding around ${t.latest.lb} lb.`;
  return `Last ${days} days: ${t.direction} about ${mag} lb, currently ${t.latest.lb} lb.`;
}

/** Both windows, for the page and the API. */
function both(store, cfg, now = new Date()) {
  return { week: trend(store, cfg, 7, now), month: trend(store, cfg, 30, now) };
}

/** Compact block for the coach's prompt. */
function promptSummary(store, cfg, now = new Date()) {
  const { week, month } = both(store, cfg, now);
  if (!week.count && !month.count) return 'No weight logged yet.';
  return [`7-day: ${line(store, cfg, 7, now)}`, `30-day: ${line(store, cfg, 30, now)}`].join(' ');
}

module.exports = { trend, line, both, promptSummary };
