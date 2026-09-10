'use strict';
/**
 * telegram.js — outbound Telegram, via the wiring that already exists.
 *
 * The build package is explicit that the daily check-in goes out over "the
 * existing Telegram bot wiring (discover and reuse — no hardcoded tokens)". That
 * wiring is GOTK's telegram_notify.js: same bot, same verified owner chat, same
 * root-only credential files. We delegate to it rather than writing a second
 * sender, so there is one implementation of the Bot API in the estate and one
 * place where the token-redaction rule lives.
 *
 * Why that redaction matters here specifically: the Telegram Bot API puts the
 * token in the URL *path*, not a header, which makes the request path itself a
 * secret. telegram_notify.js already never logs the path and scrubs the token
 * out of every error string. Reimplementing that correctly for a second time is
 * a way to get it wrong once.
 *
 * The credential paths come from our config, pushed into the environment
 * variables that module reads, so nothing is hardcoded on this side either.
 * If the module or its credentials are missing we fail closed and say so
 * plainly, without naming a path or a value.
 */
const path = require('path');

const NOTIFY_MODULE = process.env.HEALTHCOACH_TELEGRAM_MODULE || '/root/gotk/scripts/telegram_notify.js';

let cached = null;

function loadNotifier(cfg) {
  if (cached) return cached;
  // telegram_notify.js resolves its credential paths at require time from these
  // env vars, so they must be set before the require.
  process.env.GOTK_TELEGRAM_TOKEN_PATH = cfg.secrets.telegramTokenPath;
  process.env.GOTK_TELEGRAM_CHAT_ID_PATH = cfg.secrets.telegramChatIdPath;
  try {
    cached = require(path.resolve(NOTIFY_MODULE));
  } catch (e) {
    const err = new Error('Telegram delivery is not available on this host.');
    err.cause = e;
    throw err;
  }
  return cached;
}

/**
 * Send a message to the owner's verified chat.
 *
 * Resolves with Telegram's own message_id — which is the only honest proof the
 * send took. A caller that wants to claim "notified" should check for it rather
 * than assume the absence of a thrown error means delivery.
 *
 * @param {object} cfg
 * @param {string} text plain text; no Markdown/HTML parse mode is used
 * @param {'notable'|'digest'|'log'} severity 'digest'/'log' send silently
 * @returns {Promise<number>} message_id
 */
async function send(cfg, text, severity = 'notable') {
  const notifier = loadNotifier(cfg);
  const messageId = await notifier.sendAlert(text, severity);
  if (!messageId) throw new Error('Telegram accepted the request but returned no message id.');
  return messageId;
}

/** True if both the bot token and the owner chat id are readable. */
function configured(cfg) {
  try {
    const notifier = loadNotifier(cfg);
    return Boolean(notifier.loadToken() && notifier.getChatId());
  } catch {
    return false;
  }
}

module.exports = { send, configured };
