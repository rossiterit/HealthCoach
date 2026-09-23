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
const foods = require('./foods');
const atetoplan = require('./atetoplan');
const planner = require('./planner');
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
  {
    name: 'favorite_food',
    description:
      'Pin a food or meal to the owner\'s favourites board, or unpin one — for when they say "favourite that", ' +
      '"pin the curry", "take the porridge off my favourites". The board has eight tiles. If the item is not in ' +
      'their library yet, pass your nutrition estimate and it will be added to the library first. If the board is ' +
      'full, this refuses rather than evicting a tile: say so and ask which one they want to replace.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pin', 'unpin'] },
        name: { type: 'string', description: 'The food or meal, as they refer to it.' },
        food_id: { type: 'string', description: 'Preferred when you have it from the library list in your context.' },
        slot: {
          type: 'number',
          description:
            'Tile 0-7. Only pass this if they named a specific tile, or agreed to replace one. Otherwise leave it out and the first free tile is used.',
        },
        kind: { type: 'string', enum: ['food', 'meal'] },
        quantity: { type: 'string', description: 'The serving your figures describe. Needed only when creating.' },
        nutrition: NUTRITION_SCHEMA,
      },
      required: ['action'],
    },
  },
  {
    name: 'confirm_ate_to_plan',
    description:
      'Log a day\'s PLANNED meals to the food log, because the owner has said they ate to plan. ' +
      'Call this ONLY when they say so explicitly — "ate to plan", "had everything I planned", "stuck to the plan ' +
      'today". Never call it because a day has a plan, never to tidy up, and never on your own initiative: the plan ' +
      'is an intention until they say otherwise. If they ate to plan APART from something ("ate to plan except ' +
      'lunch was leftovers"), pass that slot in `except` and then log what they actually had with log_meal. ' +
      'A day can only be confirmed once; if they correct something afterwards, use correct_meal on the logged row.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD. Leave out for today. Never a Sunday — there are no Sunday plans.' },
        except: {
          type: 'array',
          items: { type: 'string', enum: ['breakfast', 'lunch', 'dinner', 'snacks'] },
          description: 'Slots that were NOT as planned. These are left out of the log entirely.',
        },
      },
    },
  },
  {
    name: 'correct_food',
    description:
      'Revise an item in the owner\'s food library when they tell you a figure or a serving is wrong — ' +
      '"the curry is more like 600 calories", "that porridge is a smaller bowl than that". This corrects the ' +
      'library entry itself, so every plan that uses it updates. It does NOT touch anything already logged; ' +
      'use correct_meal for that.',
    input_schema: {
      type: 'object',
      properties: {
        food_id: { type: 'string' },
        name: { type: 'string', description: 'Only if the name itself was wrong.' },
        quantity: { type: 'string' },
        nutrition: NUTRITION_SCHEMA,
      },
      required: ['food_id'],
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
- Every nutrition figure in this app is your own estimate, not a measurement. Say so when a decision is riding on a number you guessed. Never imply more precision than you have.

WEEKLY MEAL PLANNING — when they ask for a plan, or take the Sunday prompt on the page:
- Draft it from what they ACTUALLY eat. Their logged history is in your context: build the week around meals and ingredients that already appear there, not around an idealised diet they have never shown any sign of wanting. A plan full of food they do not eat is a plan they will not follow, and you will both know it by Wednesday.
- Cover the week loosely — a rough shape, not seven days of three prescribed meals. Leave room for eating out, for repeats, and for a night where nothing gets cooked. Say which nights are deliberately left open.
- Always finish with a SHOPPING LIST, grouped the way a shop is laid out (produce, meat and fish, dairy, dry goods, freezer). Only what they actually need to buy for the plan.
- Respect their constraints absolutely — allergies are hard limits, not preferences.
- The plan is a suggestion. Nothing in it is owed, and if they cook none of it that is not a failure of theirs or yours.

THE PLAN, AND THE ONE BRIDGE TO THE LOG:
- The Plan tab holds INTENTIONS. A planned meal is not an eaten meal, and it never becomes one on its own. Do not log anything because it was planned, do not "catch up" a day, and never ask whether they stuck to the plan — that question is the whole thing this app refuses to be.
- The single exception is when they say it themselves: "ate to plan", "had everything I planned", "stuck to the plan". Then call confirm_ate_to_plan and say plainly what went into the log.
- Partial is normal: "ate to plan except lunch was leftovers" means confirm_ate_to_plan with except: ["lunch"], then log the leftovers with log_meal. Do not make them repeat the rest of the day.
- A day confirms once. If they confirm and then correct something, that is correct_meal on the row, not a second confirmation.
- Never mention a plan they did not follow. A plan that did not happen is not a fact worth reporting, and saying so would be scolding in a helpful voice.

THEIR FOOD LIBRARY — the planner's vocabulary:
- The library is theirs, not a food database. It holds only what they have actually searched for or asked you to add, and every figure in it is your estimate. Say so if a decision is riding on one.
- They can pin things to a board of eight favourite tiles ("favourite that", "pin the curry"). Use favorite_food. If all eight are taken, do not pick one to drop — say it is full and ask which they would like to give up.
- When they tell you a library figure or serving is wrong, fix the library entry with correct_food. That is different from correcting something they already ate, which is correct_meal. If it is genuinely ambiguous which they mean, ask in a short line rather than guessing.
- Nothing about the library is a judgement. It is a list of food they eat. Do not rank items, do not call anything a good or bad choice, and do not suggest removing something because of what is in it.

HEALTHIFYING A RECIPE — when they paste one in:
- Return the whole recipe rewritten, not a list of notes about it. They should be able to cook straight from your reply.
- Then, briefly, say WHAT you changed and WHY — a few lines, not an essay. The reasoning is what lets them disagree with you.
- Keep the dish recognisably itself. If it cannot be made meaningfully better without becoming a different dish, say so and leave it alone; a carbonara with courgette in it is not a healthier carbonara, it is a worse courgette dish.
- Give estimated nutrition for the rewrite if it is useful, flagged as an estimate like everything else.${onboarding}`;
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
    `\nWHAT THEY ACTUALLY EAT (draft any meal plan from this, not from an ideal diet):\n${patternBlock(store, cfg)}`,
    `\n${libraryBlock(store)}`,
    `\n${planBlock(store, cfg)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Today's plan, and whether it has been confirmed (v3 F3).
 *
 * Present so that "ate to plan" has something to refer to, and so the coach can
 * see a day is already confirmed rather than trying and being refused. Note what
 * this block does NOT say: it never compares the plan to what was actually
 * logged, and it carries no prompt to follow the plan — the model cannot nag
 * about a gap it is never shown.
 */
function planBlock(store, cfg) {
  const today = localDate(new Date(), cfg.timezone);
  if (planner.isSunday(today)) {
    // Decision 3, at the prompt layer: Sunday is not referenced at all.
    return 'TODAY IS SUNDAY — the free day. There is no plan for today, none is expected, and you must not suggest planning it or comment on Sunday eating against any plan.';
  }

  const slots = atetoplan.preview(store, cfg, today);
  if (!slots.length) return `PLANNED FOR TODAY (${today}): nothing planned. That is not a gap and needs no comment.`;

  const lines = slots.map((s) => `  ${s.label}: ${s.cards.map((c) => c.name).join(', ')}`).join('\n');
  const done = atetoplan.isConfirmed(store, today);
  return [
    `PLANNED FOR TODAY (${today}) — intentions, not a log:`,
    lines,
    done
      ? '  Already confirmed as eaten today. A second confirmation will be refused; correct individual meals instead.'
      : '  Not confirmed. Only log these if they SAY they ate to plan.',
  ].join('\n');
}

/**
 * The food library and the favourites board (v3 F1).
 *
 * Ids are included because favorite_food and correct_food take them, and a
 * coach that has to guess an id will pick the wrong row. The list is capped:
 * the library is the owner's own vocabulary and stays small, but it grows on
 * every search miss, and an unbounded list would quietly eat the context window
 * a year from now. Favourites are always shown in full — there are only eight.
 */
function libraryBlock(store, limit = 60) {
  const board = store.favorites();
  const all = store.allFoods();

  const tiles = board
    .map((id, i) => {
      const f = id ? store.getFood(id) : null;
      return `  tile ${i + 1}: ${f ? `${f.name} [${f.id}]` : '(empty)'}`;
    })
    .join('\n');

  if (!all.length) {
    return `THEIR FOOD LIBRARY: empty so far. It fills up as they search for things on the Plan tab, or as you add items when they ask you to pin something.\nFAVOURITES BOARD (eight tiles):\n${tiles}`;
  }

  // Most recently touched first: what they are working with now is what a
  // "favourite that" or "fix the calories on that" most likely refers to.
  const rows = [...all]
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, limit)
    .map((f) => `  [${f.id}] ${f.name}${f.quantity ? ` (${f.quantity})` : ''} — ${fmtNutrition(f.nutrition) || 'no figures'}`)
    .join('\n');

  return [
    `THEIR FOOD LIBRARY (${all.length} item${all.length === 1 ? '' : 's'}; use these ids with favorite_food and correct_food):`,
    rows,
    all.length > limit ? `  ...and ${all.length - limit} older items not listed.` : '',
    `FAVOURITES BOARD (eight tiles):`,
    tiles,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * A fortnight of eating, condensed. This is the raw material for a meal plan:
 * what recurs, and roughly how the days are shaped. Deliberately descriptive —
 * it reports what happened and makes no comparison to a target, because a plan
 * built from a scolding is a plan nobody follows.
 */
function patternBlock(store, cfg) {
  const cutoff = new Date(Date.now() - 14 * 86400000);
  const rows = store.data.meals.filter((m) => new Date(m.ts) >= cutoff);
  if (!rows.length) return '  Nothing logged in the last fortnight — ask them what a normal week looks like before drafting anything.';

  const byType = new Map();
  for (const m of rows) {
    const k = m.mealType || 'unspecified';
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(m.description);
  }

  const lines = [...byType.entries()].map(([type, descs]) => {
    // Surface repeats first: the things they reach for are the plan's backbone.
    const counts = new Map();
    descs.forEach((d) => counts.set(d, (counts.get(d) || 0) + 1));
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    return `  ${type}: ${ranked.map(([d, n]) => (n > 1 ? `${d} (x${n})` : d)).join('; ')}`;
  });

  return `  ${rows.length} meals logged in the last 14 days.\n${lines.join('\n')}`;
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

  if (name === 'favorite_food') {
    // Resolve the item: an id from context wins, then an exact library name.
    let food = input.food_id ? store.getFood(input.food_id) : null;
    if (!food && input.name) food = foods.search(store, input.name, { limit: 1 }).exact;

    if (input.action === 'unpin') {
      if (!food) return { result: `Nothing in the library called "${input.name || input.food_id}", so nothing to unpin.` };
      const was = store.unpinFavorite({ foodId: food.id });
      return {
        result: was
          ? `Unpinned ${food.name}. It is still in the library and still searchable.`
          : `${food.name} was not pinned, so nothing changed.`,
        favoritesChanged: true,
      };
    }

    // Pinning something they have never searched for: create it from the
    // estimate the model already has, rather than refusing and making them
    // search first. Same create-on-miss rule as the search field (Decision 2).
    if (!food) {
      if (!input.name) return { result: 'Tell me which food to pin — I need a name or an id.' };
      food = store.addFood({
        name: input.name,
        kind: input.kind || 'meal',
        quantity: input.quantity || null,
        nutrition: nutrition.normalise(input.nutrition || {}),
      });
    }

    const out = store.pinFavorite(food.id, input.slot === undefined ? null : input.slot);
    if (out.error === 'board full') {
      return {
        result:
          `All eight favourite tiles are taken, so I have not pinned ${food.name} — I am not going to drop one of ` +
          'theirs without being asked. It is in the library either way. Ask which tile they want to give up.',
      };
    }
    if (out.error) return { result: `Could not pin that: ${out.error}.` };
    if (out.alreadyPinned) return { result: `${food.name} is already on tile ${out.slot + 1}.` };

    const replaced = out.replaced ? store.getFood(out.replaced) : null;
    return {
      result:
        `Pinned ${food.name} to tile ${out.slot + 1}.` +
        (replaced ? ` That replaced ${replaced.name}, which is unpinned but still in the library.` : ''),
      favoritesChanged: true,
    };
  }

  if (name === 'confirm_ate_to_plan') {
    const date = input.date || atetoplan.today(cfg);
    const out = atetoplan.confirm(store, cfg, date, { except: input.except || [] });
    if (out.error) return { result: out.error };
    return {
      result: atetoplan.echo(out),
      // Each row is tagged like any other logged meal, so the page renders
      // these with the same card as a conversationally logged one — they are
      // the same kind of thing.
      logged: out.logged.map((m) => ({ ...m, kind: 'meal' })),
    };
  }

  if (name === 'correct_food') {
    const existing = store.getFood(input.food_id);
    if (!existing) return { result: `No library item with id ${input.food_id}. Check the library list in your context.` };
    const patch = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.quantity !== undefined) patch.quantity = input.quantity;
    if (input.nutrition !== undefined) patch.nutrition = nutrition.normalise(input.nutrition);
    const row = store.updateFood(input.food_id, patch);
    return {
      result: `Updated the library entry: ${foods.describe(row)}. Anything planned with it now uses the new figures.`,
      foodChanged: true,
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

module.exports = { name: 'dietcoach', persona, context, tools, runTool, fmtNutrition, patternBlock, libraryBlock, planBlock };
