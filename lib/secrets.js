'use strict';
/**
 * secrets.js — the only module that reads credential files.
 *
 * Confidentiality floor (build package, "Agent governance"): secrets are used,
 * never displayed, and the app fails closed without them. Three rules follow:
 *
 *   1. Read per call, never cache. A rotated key takes effect on the next call
 *      instead of on the next restart, and nothing sits in the heap between uses.
 *   2. Never log or return the value. Callers get the string to hand straight to
 *      an SDK or an HTTPS request; nothing here formats one into a message.
 *   3. redact() scrubs a secret out of any string before it can reach a log, an
 *      error body, or the chat page. Every outward-facing error path runs through
 *      it — see telegram.js, where the bot token lives in the request *path* and
 *      so would otherwise land in a logged URL.
 *
 * The files themselves are mode 0600 and owned by the service user, placed by the
 * owner out of band. They are never git-managed (see .gitignore).
 */
const fs = require('fs');

function readSecret(p) {
  try {
    const v = fs.readFileSync(p, 'utf8').trim();
    return v || null;
  } catch {
    return null; // fail closed: caller decides how to degrade, and says so plainly
  }
}

/** True if the secret is present and readable — without revealing it. */
function have(p) {
  return readSecret(p) !== null;
}

/**
 * Remove every occurrence of `secret` from `str`. Pure and exported so the guard
 * can be unit-tested without a real credential on disk.
 */
function redact(str, secret) {
  if (str === null || str === undefined) return str;
  const s = String(str);
  if (!secret) return s;
  return s.split(secret).join('<redacted>');
}

module.exports = { readSecret, have, redact };
