'use strict';
/**
 * checkin.js — the one daily check-in (F5).
 *
 * "One daily check-in. Never more, per the no-nagging rule." That sentence is
 * the whole design brief, and it drives the one non-obvious decision here:
 *
 *   The day's slot is claimed BEFORE the message is sent, not after.
 *
 * If we recorded the send afterwards, a crash or a timeout between "Telegram
 * accepted it" and "we wrote it down" would leave no record, and the next run
 * would send a second check-in. Claiming first makes the failure mode a missed
 * check-in instead of a duplicate one — which is the right way round when the
 * standing rule is never to nag. A failed send is reported, and left for
 * tomorrow rather than retried today.
 *
 * The store is the cap, not the scheduler. That means the cap holds however the
 * run is triggered — timer, manual API call, or a second scheduler someone adds
 * later — and it survives a restart.
 */
const { localDate } = require('./store');
const dietcoach = require('./dietcoach');
const telegram = require('./telegram');

/**
 * Run today's check-in if it has not gone out yet.
 *
 * @param {Store} store
 * @param {object} cfg
 * @param {{force?: boolean, dryRun?: boolean}} opts
 *   force  — bypass the once-a-day cap (operator escape hatch; still recorded)
 *   dryRun — compose and return the text, send nothing, claim no slot
 * @returns {Promise<object>} {status, date, text?, messageId?, error?}
 */
async function run(store, cfg, opts = {}) {
  const date = localDate(new Date(), cfg.timezone);

  if (!cfg.checkin.enabled && !opts.force) {
    return { status: 'disabled', date };
  }

  const existing = store.checkinOnDate(date);
  if (existing && !opts.force) {
    return { status: 'already-sent', date, sentAt: existing.sentAt };
  }

  const text = await dietcoach.composeCheckin(store, cfg);
  if (!text || !text.trim()) {
    return { status: 'error', date, error: 'The coach returned an empty check-in; nothing sent.' };
  }

  const body = `${text.trim()}\n\n${cfg.publicUrl}`;

  if (opts.dryRun) {
    return { status: 'dry-run', date, text: body };
  }

  // Claim the day first — see the note at the top of this file.
  const row = store.addCheckin(date, body, false);

  try {
    const messageId = await telegram.send(cfg, body, 'notable');
    row.ok = true;
    row.messageId = messageId;
    await store.save();
    return { status: 'sent', date, text: body, messageId };
  } catch (e) {
    row.ok = false;
    row.error = e.message;
    await store.save();
    return { status: 'error', date, text: body, error: e.message };
  }
}

/**
 * True if the configured local check-in hour has arrived and today's has not
 * gone out. The timer calls this every hour; the store is still the real cap.
 */
function isDue(store, cfg, now = new Date()) {
  if (!cfg.checkin.enabled) return false;
  const date = localDate(now, cfg.timezone);
  if (store.checkinOnDate(date)) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: cfg.timezone,
      hour: '2-digit',
      hour12: false,
    }).format(now)
  );
  return hour >= cfg.checkin.hourLocal;
}

module.exports = { run, isDue };
