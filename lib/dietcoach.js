'use strict';
/**
 * dietcoach.js — the DietCoach module (v1 F2/F3/F4).
 *
 * Since v2 this is a *module* rather than the whole coach: it contributes a
 * persona fragment, live context, and its tools to the single conversation that
 * coach.js runs. The conversational loop, the shared voice, and the no-guilt
 * rules now live in coach.js; what stays here is everything specific to food.
 *
 * Its three tools all write to the app's own store, are reversible, and are
 * echoed back in the chat — which is what makes correction-by-reply the safety
 * mechanism rather than a confirmation prompt. See coach.js for the governance
 * note covering the whole tool surface.
 */
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

const ITEMS_SCHEMA = {
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
};

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'drink', 'unspecified'];

const tools = [
  {
    name: 'log_meal',
    description:
      'Record a meal the owner has eaten. Call this whenever they mention eating or drinking something, ' +
      'including in passing. Break it into component items and estimate nutrition for each. Do not call this ' +
      'for food they are only asking about or planning.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: "The meal in the owner's own words, lightly tidied." },
        meal_type: { type: 'string', enum: MEAL_TYPES },
        when: {
          type: 'string',
          description: 'ISO 8601 timestamp of when it was eaten. Use now unless they said otherwise.',
        },
        items: ITEMS_SCHEMA,
        notes: { type: 'string', description: 'Context worth keeping that is not the food itself.' },
      },
      required: ['description', 'items'],
    },
  },
  {
    name: 'correct_meal',
    description:
      'Revise a meal already logged, when the owner corrects you. Use the meal_id from the recent-meals list ' +
      'in your context. Pass only the fields that change; re-send the full items array if any item changes.',
    input_schema: {
      type: 'object',
      properties: {
        meal_id: { type: 'string' },
        description: { type: 'string' },
        meal_type: { type: 'string', enum: MEAL_TYPES },
        when: { type: 'string' },
        items: ITEMS_SCHEMA,
        notes: { type: 'string' },
      },
      required: ['meal_id'],
    },
  },
  {
    name: 'save_goals',
    description:
      'Write or rewrite the goals document — the working frame for all your coaching, food and movement alike. ' +
      'Call it once the onboarding interview has enough to be useful, and again whenever the owner revises what ' +
      'they are working towards. Rewriting replaces the whole document, so carry forward anything still true.',
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
        preferences: { type: 'array', items: { type: 'string' } },
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
// Persona + context
// ---------------------------------------------------------------------------

function persona(store) {
  const onboarding = store.getGoals()
    ? ''
    : `
FIRST CONVERSATION — RUN THE ONBOARDING INTERVIEW.
There is no goals document yet. Before you can coach, understand what they are actually after.

Interview them conversationally — a couple of questions at a time, not a form. Cover what they want to change and why it matters now, how they eat and move at the moment, what they like and will not give up, any allergies or medical constraints, and what their week actually looks like. Follow what they give you rather than working down a checklist. Do not propose numeric targets unless they ask. When you have enough to be useful, call save_goals and say in a line what you wrote down. If they open by describing a meal or a walk, log it first, then carry on.`;

  return `
ABOUT FOOD:
- Log quietly and confirm plainly. When they mention food, log it and say what you logged in one short line so a misread is visible. Do not turn a sandwich into a nutrition lecture.
- Every nutrition figure in this app is your own estimate, not a measurement. Say so when a decision is riding on a number you guessed. Never imply more precision than you have.${onboarding}`;
}

function fmtNutrition(n) {
  if (!n) return '';
  const parts = [];
  if (n.calories_kcal != null) parts.push(`${n.calories_kcal} kcal`);
  if (n.protein_g != null) parts.push(`${n.protein_g}g protein`);
  if (n.carb_g != null) parts.push(`${n.carb_g}g carb`);
  if (n.fat_g != null) parts.push(`${n.fat_g}g fat`);
  return parts.join(', ');
}

function goalsBlock(goals) {
  if (!goals) return '';
  const t = goals.targets || {};
  const targetLines = Object.entries(t)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n');
  return `
THEIR GOALS DOCUMENT (revision ${goals.revision}, updated ${goals.updatedAt}):
${goals.summary}
${targetLines ? `Agreed targets:\n${targetLines}` : 'No numeric targets agreed.'}
${goals.preferences?.length ? `Preferences: ${goals.preferences.join('; ')}` : ''}
${goals.constraints?.length ? `Constraints (treat allergies as hard): ${goals.constraints.join('; ')}` : ''}

This is your working frame for food and movement both. If they say it is out of date, rewrite it with save_goals.`;
}

function context(store, cfg) {
  const meals = store.recentMeals(15);
  const today = localDate(new Date(), cfg.timezone);
  const todays = store.mealsOnDate(today, cfg.timezone);

  const recent = meals.length
    ? meals
        .map((m) => {
          const d = localDate(m.ts, cfg.timezone);
          return `  [${m.id}] ${d} ${m.mealType}: ${m.description} — ${fmtNutrition(m.nutrition) || 'no figures'}${m.correctedAt ? ' (corrected)' : ''}`;
        })
        .join('\n')
    : '  Nothing logged yet.';

  const todayLine = todays.length
    ? `${todays.length} entr${todays.length === 1 ? 'y' : 'ies'}, running total ${fmtNutrition(nutrition.total(todays.map((m) => ({ nutrition: m.nutrition })))) || 'no figures'} (estimated).`
    : 'nothing logged yet.';

  return [
    goalsBlock(store.getGoals()),
    `\nRECENTLY EATEN (most recent first; use these ids with correct_meal):\n${recent}`,
    `\nFOOD TODAY (${today}): ${todayLine}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

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
      logged: { ...row, kind: 'meal' },
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
      corrected: { ...row, kind: 'meal' },
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

module.exports = { name: 'dietcoach', persona, context, tools, runTool, fmtNutrition };
