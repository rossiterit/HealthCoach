'use strict';
/**
 * claude.js — the app's single door to the Claude API.
 *
 * Everything model-facing goes through here so there is exactly one place that
 * touches the API key, one place that pins the model and effort, and one place
 * to change if either moves.
 *
 * Notes on the request shape, since a few of these are easy to get wrong:
 *   - Model is claude-opus-5. Thinking is ON by default on this model, and
 *     `max_tokens` caps thinking *plus* reply text — hence the generous ceiling
 *     in config rather than one sized to the visible answer.
 *   - Effort is `medium` by default. Opus 5 is unusually strong at the lower
 *     effort levels, and a chat coach wants a fast turn more than it wants the
 *     deepest possible reasoning about a sandwich.
 *   - `budget_tokens`, `temperature`, `top_p` and `top_k` are all rejected by
 *     this model. Do not reintroduce them; steer with the prompt instead.
 *   - We stay on the non-beta `messages.create` and drive the tool loop by hand
 *     in dietcoach.js. The loop is two iterations deep at most, and doing it
 *     here keeps the app off a beta surface and gives us the exact list of
 *     store writes to echo back into the chat page.
 *
 * The key is read per call and never cached, logged, or returned (see secrets.js).
 */
const Anthropic = require('@anthropic-ai/sdk');
const secrets = require('./secrets');

class ClaudeUnavailable extends Error {}

function clientFor(cfg) {
  const apiKey = secrets.readSecret(cfg.secrets.anthropicKeyPath);
  if (!apiKey) {
    // Fail closed, and say what's wrong without naming the path or the value.
    throw new ClaudeUnavailable('The coach is not configured with API access right now.');
  }
  return { client: new Anthropic({ apiKey }), apiKey };
}

/**
 * One turn against the model.
 * @returns {Promise<object>} the raw Message (content blocks, stop_reason, usage)
 */
async function complete(cfg, { system, messages, tools }) {
  const { client, apiKey } = clientFor(cfg);
  const req = {
    model: cfg.coach.model,
    max_tokens: cfg.coach.maxTokens,
    output_config: { effort: cfg.coach.effort },
    system,
    messages,
  };
  if (tools && tools.length) req.tools = tools;

  try {
    return await client.messages.create(req);
  } catch (err) {
    // Never let a transport error carry the credential outward, in any form.
    const msg = secrets.redact(err && err.message ? err.message : String(err), apiKey);
    const e = new Error(msg);
    e.status = err && err.status;
    throw e;
  }
}

/** Concatenated visible text of a response, ignoring thinking and tool blocks. */
function textOf(message) {
  return (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/** The tool_use blocks of a response, in order. */
function toolUsesOf(message) {
  return (message.content || []).filter((b) => b.type === 'tool_use');
}

module.exports = { complete, textOf, toolUsesOf, ClaudeUnavailable };
