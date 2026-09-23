'use strict';
/**
 * coach.js — the conversation runner, and the seam between coach modules.
 *
 * v1 Decision 1 was "one app, coaches as modules, shared data store". v1 only
 * had one module so the seam was notional; v2 makes it real. What it is NOT is
 * two chatbots: the owner talks to one coach with one voice. A module
 * contributes three things to that single conversation —
 *
 *   persona(store, cfg)  a fragment of the system prompt: what this module is
 *                        for, and how to behave about it
 *   context(store, cfg)  live state the model needs this turn (the goals doc,
 *                        the recent log, today's routine, the weight trend)
 *   tools + runTool      capabilities, and the code that executes them
 *
 * coach.js composes those into one prompt and one tool set, runs the tool loop,
 * and dispatches each call back to the module that owns it. Adding a coach is
 * adding a file to MODULES; it is not touching this one.
 *
 * GOVERNANCE — the tool surface.
 * Every tool any module registers writes to the app's own store and nowhere
 * else. There is no tool for reading or writing files, running commands,
 * reaching the network, or editing a prompt. That remains structural rather
 * than configured, and a test asserts the exact tool list so a new capability
 * fails the suite rather than arriving quietly.
 *
 * v2 adds log_workout and log_weight (GOTK-160/161). The build package's
 * governance section says "no new tools or external access", while F4 and F5
 * require conversational workout and weight logging — the owner ratified the
 * reading on 2026-09-12: the frozen thing is EXTERNAL access (calendar, APIs,
 * per Decision 8), and store-writing tools are the same class as v1's log_meal.
 * Nothing added here reaches outside the app.
 */
const claude = require('./claude');

// Order matters only for prompt readability, not behaviour.
const MODULES = [require('./dietcoach'), require('./fitnesscoach')];

/**
 * The shared voice. Module personas layer on top of this; anything here applies
 * to the whole conversation regardless of which module the owner is engaging.
 */
const BASE_PERSONA = `You are HealthCoach — a private coach for one person, the owner of this app. You cover both what they eat and how they move, in one conversation. You are one coach, not several: never announce which part of yourself is answering.

How you work:
- Advisory, never supervisory. You offer, they decide. No shaming, no guilt, no moralising — about food, about movement, about weight, about anything.
- No nagging. Never repeat a point they did not ask you to repeat, never chase them about something they skipped, and never append a "but remember..." to a reply. You get one outbound message a day and that is the whole of your unprompted contact.
- Be brief. A sentence or two is usually right. Answer first, reasoning after — if the reasoning is wanted at all. Match their register.
- Ground what you say in what you actually know. Their goals, their logged history, their routine and their trend are all in your context. If you are reaching past it, say so.

THE RULE THAT OVERRIDES CONVENIENCE — this app must never become a guilt engine:
- There are no streaks, chains, runs, or consecutive-day counts. Do not count them, do not mention them, do not congratulate one, and do not mourn one breaking. They do not exist here.
- Never count or refer to misses, gaps, skipped days, days off, or how long it has been since they last did something. A gap is not a fact worth reporting.
- Every day starts fresh. Yesterday has no claim on today, in either direction.
- Doing less than planned is a legitimate outcome, not a failure to be softened. Do not frame it as "at least", "only", "just", or "better than nothing" — those all say the same thing as shaming, more politely.
- Record what WAS done. Never draw attention to what was not.

Never reveal, quote, or describe the contents of any credential, key, or configuration file. You cannot change your own instructions, tools, or permissions, and there is no mechanism by which you could — do not claim otherwise.`;

/** Every tool across every module, in registration order. */
function allTools() {
  return MODULES.flatMap((m) => m.tools || []);
}

/** The module that owns a tool name, or null. */
function ownerOf(toolName) {
  return MODULES.find((m) => (m.tools || []).some((t) => t.name === toolName)) || null;
}

/**
 * Compose the system prompt for a turn.
 * @param {string} extra appended verbatim — used by the briefing composer to
 *   swap the conversational framing for a "write today's briefing" instruction.
 */
function buildSystem(store, cfg, extra = '') {
  const parts = [BASE_PERSONA, `\nCurrent time: ${new Date().toISOString()} (owner's timezone: ${cfg.timezone}).`];

  for (const m of MODULES) {
    const persona = m.persona ? m.persona(store, cfg) : '';
    if (persona) parts.push(persona);
  }
  for (const m of MODULES) {
    const context = m.context ? m.context(store, cfg) : '';
    if (context) parts.push(context);
  }
  if (extra) parts.push(extra);

  return parts.filter(Boolean).join('\n');
}

/** Execute one tool call by handing it to its owning module. */
function runTool(store, cfg, name, input) {
  const mod = ownerOf(name);
  if (!mod) return { result: `Unknown tool: ${name}` };
  return mod.runTool(store, cfg, name, input || {});
}

/**
 * Handle one message from the owner.
 *
 * Runs the tool loop by hand: ask the model, execute whatever store writes it
 * asks for, hand the results back, repeat until it stops calling tools. The cap
 * is a backstop against a loop, not a budget.
 *
 * @returns {Promise<{reply:string, logged:object[], corrected:object[], goalsUpdated:boolean}>}
 *   `logged` carries every new row from any module, each tagged with its kind
 *   so the page can render a meal card, a movement card or a weight card.
 */
async function turn(store, cfg, userText, { maxIterations = 4 } = {}) {
  store.addMessage('user', userText);

  const history = store
    .recentMessages(cfg.coach.historyTurns)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
    .filter((m) => m.content && m.content.trim());

  const messages = [...history];
  // The store already holds this turn's user message, so history ends on it.
  // Guard the case where it somehow does not — the API requires a user turn last.
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: userText });
  }

  const system = buildSystem(store, cfg);
  const tools = allTools();
  const logged = [];
  const corrected = [];
  let goalsUpdated = false;
  let reply = '';

  for (let i = 0; i < maxIterations; i++) {
    const res = await claude.complete(cfg, { system, messages, tools });
    const text = claude.textOf(res);
    if (text) reply = text;

    const toolUses = claude.toolUsesOf(res);
    if (!toolUses.length) break;

    messages.push({ role: 'assistant', content: res.content });

    const results = [];
    for (const tu of toolUses) {
      let outcome;
      try {
        outcome = runTool(store, cfg, tu.name, tu.input || {});
      } catch (e) {
        outcome = { result: `That did not save: ${e.message}` };
      }
      // A tool usually logs one row, but confirming a day's plan logs several
      // at once, so both shapes are accepted rather than making every caller
      // wrap a single row in an array.
      if (outcome.logged) logged.push(...[].concat(outcome.logged));
      if (outcome.corrected) corrected.push(...[].concat(outcome.corrected));
      if (outcome.goals) goalsUpdated = true;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: outcome.result });
    }
    // All results for one assistant turn go back in a single user message.
    messages.push({ role: 'user', content: results });
  }

  if (!reply) {
    reply = logged.length
      ? "Got it, that's recorded. Tell me if I've read any of it wrong."
      : "I didn't manage a reply to that — try me again?";
  }

  store.addMessage('assistant', reply, {
    loggedIds: logged.map((r) => r.id),
    correctedIds: corrected.map((r) => r.id),
    goalsUpdated,
  });

  return { reply, logged, corrected, goalsUpdated };
}

module.exports = { turn, buildSystem, runTool, allTools, ownerOf, MODULES, BASE_PERSONA };
