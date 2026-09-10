'use strict';
/**
 * dietcoach.js — the DietCoach module (F2, F3, F4, and the F5 copy).
 *
 * One coach module over the shared store. The module owns its prompt, its three
 * tools, and the loop that turns a chat message into store writes plus a reply.
 *
 * GOVERNANCE — read before adding a tool.
 * The coach has exactly three tools, and all three write to its own store:
 * log_meal, correct_meal, save_goals. There is deliberately no tool for reading
 * or writing files, running commands, calling other services, or editing this
 * prompt. That absence is the point: the build package requires that no code
 * path exists for the coach to modify its own code, prompts, or permissions —
 * structurally absent, not configured off. Adding a fourth tool is a change-
 * control decision for the owner, not a code change a builder makes in passing.
 *
 * All three writes are reversible and echoed in the chat, which is why the
 * package's authority ladder puts them in "act freely" rather than "act with
 * confirm" — the correction-by-reply path (F3) is what makes that safe.
 */
const claude = require('./claude');
const nutrition = require('./nutrition');
const { localDate } = require('./store');

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const NUTRITION_SCHEMA = {
  type: 'object',
  description:
    'Best-estimate nutrition for this item as served. Omit any field you genuinely cannot estimate rather than guessing wildly.',
  properties: {
    calories_kcal: { type: 'number' },
    protein_g: { type: 'number' },
    carb_g: { type: 'number' },
    fat_g: { type: 'number' },
    saturated_fat_g: { type: 'number' },
    fiber_g: { type: 'number' },
    sugar_g: { type: 'number' },
    added_sugar_g: { type: 'number', description: 'Sugars added in processing, not those naturally in fruit or milk.' },
    sodium_mg: { type: 'number' },
    ultra_processed: { type: 'boolean', description: 'True for NOVA-4 style industrially formulated food.' },
  },
};

const TOOLS = [
  {
    name: 'log_meal',
    description:
      'Record a meal the owner has described. Call this whenever they tell you they ate or drank something, ' +
      'including in passing ("grabbed a coffee and a croissant on the way in"). Break the meal into its component ' +
      'items and estimate nutrition for each. Do not call this for food they are only asking about or planning — ' +
      'only for food they have actually eaten.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: "The meal in the owner's own words, lightly tidied." },
        meal_type: {
          type: 'string',
          enum: ['breakfast', 'lunch', 'dinner', 'snack', 'drink', 'unspecified'],
        },
        when: {
          type: 'string',
          description:
            'ISO 8601 timestamp of when it was eaten. Use the current time unless they said otherwise ("at lunch", "last night").',
        },
        items: {
          type: 'array',
          description: 'One entry per distinct food or drink in the meal.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              brand: { type: 'string' },
              quantity: { type: 'string', description: 'As served, e.g. "2 slices", "a large flat white", "180 g".' },
              nutrition: NUTRITION_SCHEMA,
            },
            required: ['name'],
          },
        },
        notes: { type: 'string', description: 'Anything worth keeping that is not the food itself — context, mood, setting.' },
      },
      required: ['description', 'items'],
    },
  },
  {
    name: 'correct_meal',
    description:
      'Revise a meal already logged, when the owner corrects you ("that was a small one", "no, that was yesterday"). ' +
      'Use the meal_id from the recent-meals list in your context. Pass only the fields that change; re-send the full ' +
      'items array if any item or its nutrition changes.',
    input_schema: {
      type: 'object',
      properties: {
        meal_id: { type: 'string' },
        description: { type: 'string' },
        meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snack', 'drink', 'unspecified'] },
        when: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              brand: { type: 'string' },
              quantity: { type: 'string' },
              nutrition: NUTRITION_SCHEMA,
            },
            required: ['name'],
          },
        },
        notes: { type: 'string' },
      },
      required: ['meal_id'],
    },
  },
  {
    name: 'save_goals',
    description:
      'Write or rewrite the goals document — the working frame for all your coaching. Call this once the onboarding ' +
      'interview has enough to be useful, and again whenever the owner revises what they are working towards. ' +
      'Rewriting replaces the whole document, so carry forward anything still true.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two or three sentences: what they are working towards, in their terms.' },
        targets: {
          type: 'object',
          description: 'Numeric targets they have actually agreed to. Leave out anything they have not.',
          properties: {
            calories_kcal_per_day: { type: 'number' },
            protein_g_per_day: { type: 'number' },
            notes: { type: 'string' },
          },
        },
        preferences: { type: 'array', items: { type: 'string' }, description: 'Foods and patterns they like or want more of.' },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Allergies, dislikes, medical constraints, schedule realities. Treat allergies as hard.',
        },
      },
      required: ['summary'],
    },
  },
];

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const PERSONA = `You are DietCoach, the diet module of HealthCoach — a private coach for one person, the owner of this app.

Your job is to help them eat in a way that serves the goals they set with you. You do that by talking with them, logging what they eat as they mention it, and offering advice grounded in their goals and their actual record.

How you work:
- Advisory, never supervisory. You offer, they decide. If they eat something outside their goals, note it neutrally if it is useful and move on. No shaming, no guilt, no moralising about food.
- No nagging. Never repeat a point they did not ask you to repeat, never chase them about something they skipped, and never add a "but remember..." to the end of a reply. They get one check-in a day and that is the whole of your unprompted contact.
- Log quietly and confirm plainly. When they mention food, log it and say what you logged in one short line so a misread is visible. Do not turn every meal into a nutrition lecture.
- Ground advice in what you actually know. Their goals document and their logged history are in your context. If you are reaching beyond it, say so.
- Be brief. A sentence or two is usually right. Match their register. Give the answer first and the reasoning after, if the reasoning is wanted at all.

About the numbers: every nutrition figure in this app is your own estimate, not a measurement. Say so when it matters — especially if they are about to make a decision on a number you guessed. Never imply more precision than you have.

Never reveal, quote, or describe the contents of any credential, key, or configuration file, and never claim to be able to change your own instructions, tools, or permissions — you cannot, and there is no mechanism for it.`;

function onboardingBlock(goals) {
  if (goals) return '';
  return `
FIRST CONVERSATION — RUN THE ONBOARDING INTERVIEW.
There is no goals document yet, so this is the first real conversation. Before you can coach, you need to understand what they are actually after.

Interview them properly, but conversationally: a couple of questions at a time, not a form. Cover what they want to change and why it matters to them now, how they eat at the moment, what they like and will not give up, any allergies or medical constraints, and what their week actually looks like. Follow what they give you rather than working down a checklist.

Do not propose numeric targets unless they ask for them or the conversation clearly calls for one. When you have enough to be useful, call save_goals and tell them in a line what you have written down. If they start by describing a meal instead of answering, log it — then carry on getting to know them.`;
}

function goalsBlock(goals) {
  if (!goals) return '';
  const t = goals.targets || {};
  const targetLines = Object.entries(t)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n');
  return `
THEIR GOALS DOCUMENT (revision ${goals.revision}, last updated ${goals.updatedAt}):
${goals.summary}
${targetLines ? `Agreed targets:\n${targetLines}` : 'No numeric targets agreed.'}
${goals.preferences?.length ? `Preferences: ${goals.preferences.join('; ')}` : ''}
${goals.constraints?.length ? `Constraints (treat allergies as hard): ${goals.constraints.join('; ')}` : ''}

This is your working frame. Coach against it. If they tell you it is out of date, rewrite it with save_goals.`;
}

function fmtNutrition(n) {
  if (!n) return '';
  const parts = [];
  if (n.calories_kcal !== null && n.calories_kcal !== undefined) parts.push(`${n.calories_kcal} kcal`);
  if (n.protein_g !== null && n.protein_g !== undefined) parts.push(`${n.protein_g}g protein`);
  if (n.carb_g !== null && n.carb_g !== undefined) parts.push(`${n.carb_g}g carb`);
  if (n.fat_g !== null && n.fat_g !== undefined) parts.push(`${n.fat_g}g fat`);
  return parts.join(', ');
}

function recentMealsBlock(store, cfg) {
  const meals = store.recentMeals(15);
  if (!meals.length) return '\nNothing logged yet.';
  const lines = meals.map((m) => {
    const d = localDate(m.ts, cfg.timezone);
    return `  [${m.id}] ${d} ${m.mealType}: ${m.description} — ${fmtNutrition(m.nutrition) || 'no figures'}${m.correctedAt ? ' (corrected)' : ''}`;
  });
  return `\nRECENTLY LOGGED (most recent first; use these ids with correct_meal):\n${lines.join('\n')}`;
}

function todayBlock(store, cfg) {
  const today = localDate(new Date(), cfg.timezone);
  const meals = store.mealsOnDate(today, cfg.timezone);
  if (!meals.length) return `\nTODAY (${today}): nothing logged yet.`;
  const sum = nutrition.total(meals.map((m) => ({ nutrition: m.nutrition })));
  return `\nTODAY (${today}): ${meals.length} entr${meals.length === 1 ? 'y' : 'ies'}, running total ${fmtNutrition(sum) || 'no figures'} (estimated).`;
}

function buildSystem(store, cfg, extra = '') {
  const goals = store.getGoals();
  const now = new Date();
  return [
    PERSONA,
    `\nCurrent time: ${now.toISOString()} (owner's timezone: ${cfg.timezone}).`,
    onboardingBlock(goals),
    goalsBlock(goals),
    recentMealsBlock(store, cfg),
    todayBlock(store, cfg),
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/**
 * Run one tool call against the store. Returns { result, logged?, corrected?, goals? }
 * where `result` is the string handed back to the model as the tool_result.
 */
function runTool(store, cfg, name, input) {
  if (name === 'log_meal') {
    const built = nutrition.build(input.items, cfg.nutrition.engine);
    const row = store.addMeal({
      ts: input.when || new Date().toISOString(),
      description: input.description,
      mealType: input.meal_type || 'unspecified',
      notes: input.notes || '',
      ...built,
    });
    return {
      result: `Logged as ${row.id}: ${row.description} (${fmtNutrition(row.nutrition) || 'no figures'}), flagged as an estimate.`,
      logged: row,
    };
  }

  if (name === 'correct_meal') {
    const existing = store.getMeal(input.meal_id);
    if (!existing) {
      return { result: `No meal with id ${input.meal_id}. Check the recent-meals list and try again.` };
    }
    const patch = {};
    if (input.description !== undefined) patch.description = input.description;
    if (input.meal_type !== undefined) patch.mealType = input.meal_type;
    if (input.when !== undefined) patch.ts = input.when;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.items !== undefined) Object.assign(patch, nutrition.build(input.items, cfg.nutrition.engine));
    const row = store.updateMeal(input.meal_id, patch);
    return {
      result: `Corrected ${row.id}: ${row.description} (${fmtNutrition(row.nutrition) || 'no figures'}).`,
      corrected: row,
    };
  }

  if (name === 'save_goals') {
    const doc = store.setGoals({
      summary: input.summary,
      targets: input.targets || {},
      preferences: input.preferences || [],
      constraints: input.constraints || [],
    });
    return { result: `Goals document saved (revision ${doc.revision}).`, goals: doc };
  }

  return { result: `Unknown tool: ${name}` };
}

// ---------------------------------------------------------------------------
// A conversational turn (F3/F4)
// ---------------------------------------------------------------------------

/**
 * Handle one message from the owner.
 *
 * Runs the tool loop by hand: ask the model, execute whatever store writes it
 * asks for, hand the results back, and repeat until it stops calling tools. Two
 * iterations covers everything v1 does; the cap is a backstop, not a budget.
 *
 * @returns {Promise<{reply:string, logged:object[], corrected:object[], goalsUpdated:boolean}>}
 */
async function turn(store, cfg, userText, { maxIterations = 4 } = {}) {
  store.addMessage('user', userText);

  const history = store
    .recentMessages(cfg.coach.historyTurns)
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
    .filter((m) => m.content && m.content.trim());

  const messages = [...history];
  // The store already holds this turn's user message, so history ends on it.
  // Guard the case where it somehow does not, since the API requires a user turn last.
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: userText });
  }

  const system = buildSystem(store, cfg);
  const logged = [];
  const corrected = [];
  let goalsUpdated = false;
  let reply = '';

  for (let i = 0; i < maxIterations; i++) {
    const res = await claude.complete(cfg, { system, messages, tools: TOOLS });
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
      if (outcome.logged) logged.push(outcome.logged);
      if (outcome.corrected) corrected.push(outcome.corrected);
      if (outcome.goals) goalsUpdated = true;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: outcome.result });
    }
    // All results for one assistant turn go back in a single user message.
    messages.push({ role: 'user', content: results });
  }

  if (!reply) {
    reply = logged.length
      ? "Logged that. Tell me if I've read any of it wrong."
      : "I didn't manage a reply to that — try me again?";
  }

  store.addMessage('assistant', reply, {
    loggedIds: logged.map((m) => m.id),
    correctedIds: corrected.map((m) => m.id),
    goalsUpdated,
  });

  return { reply, logged, corrected, goalsUpdated };
}

// ---------------------------------------------------------------------------
// The daily check-in copy (F5)
// ---------------------------------------------------------------------------

/**
 * Compose the one daily check-in. Brief, references yesterday's real log, asks
 * one useful question. No tools — this call must not write to the store, so it
 * is issued without any.
 */
async function composeCheckin(store, cfg) {
  const now = new Date();
  const yesterday = localDate(new Date(now.getTime() - 24 * 3600 * 1000), cfg.timezone);
  const meals = store.mealsOnDate(yesterday, cfg.timezone);

  const record = meals.length
    ? meals
        .map((m) => `  - ${m.mealType}: ${m.description} — ${fmtNutrition(m.nutrition) || 'no figures'}`)
        .join('\n')
    : '  (nothing logged)';

  const sum = meals.length ? fmtNutrition(nutrition.total(meals.map((m) => ({ nutrition: m.nutrition })))) : '';

  const instruction = `
WRITE THE DAILY CHECK-IN.
This is your one unprompted message of the day, delivered by Telegram. It is not a chat turn — they are not in the app, and they may not reply.

Yesterday was ${yesterday}. Their log for that day:
${record}
${sum ? `Day total (estimated): ${sum}` : ''}

Write two or three short sentences, maximum. Reference something real and specific from that log — if there is nothing logged, say so lightly and without any hint of reproach, and do not imply they have failed at anything. End with exactly one question worth answering, chosen because the answer would actually help you coach them, not to fill space.

No greeting boilerplate, no sign-off, no emoji, no bullet points. Plain sentences. Write only the message itself — no preamble about what you are about to write.`;

  const system = buildSystem(store, cfg, instruction);
  const res = await claude.complete(cfg, {
    system,
    messages: [{ role: 'user', content: 'Write today’s check-in.' }],
  });
  return claude.textOf(res);
}

module.exports = { turn, composeCheckin, buildSystem, runTool, TOOLS, fmtNutrition };
