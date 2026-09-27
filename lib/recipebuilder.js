'use strict';
/**
 * recipebuilder.js — "build me a recipe for X" (v5 F1, GOTK-176).
 *
 * Name a dish, pick one of seven modes, add an optional note, get a draft
 * recipe in the editor. Generation is from the coach's own knowledge: no
 * lookup, no database, no external call. This module requires nothing that can
 * reach the network — the v4 URL fetcher is a separate, owner-pasted path and
 * has no business here, which a test asserts.
 *
 * THE SEVEN MODES ARE LOCKED (Decision 2) and live in one table below. Each
 * carries the instruction that defines it, so the difference between "low carb"
 * and "treat" is a line of text an owner can read and argue with rather than
 * something diffused through a prompt.
 *
 * TREAT MODE IS THE ONE TO GET RIGHT. Decision 2 says zero nutrition
 * commentary: no lightening, no swaps, no "you could use...", no calorie
 * remark. It is the no-guilt rule made explicit — the owner asked for the real
 * thing and the app's job is to hand it over without an opinion. Macros still
 * appear on the card afterwards, because that is information the panel always
 * shows; what must not appear is a view about them. A test sweeps generated
 * treat recipes for that language, because a locked decision deserves more
 * than a well-worded prompt.
 *
 * The output is an ordinary draft: same shape as a pasted or chat-drafted
 * recipe, saved through the same pipeline, editable and deletable like any
 * other. Nothing here is privileged for having been generated.
 */
const claude = require('./claude');

/**
 * The seven modes, exactly as Decision 2 words them. `guidance` is what the
 * generator is told; `label` is what the chips show.
 */
const MODES = [
  {
    id: 'low-calorie',
    label: 'Low calorie',
    blurb: 'Lighter, without gutting the dish',
    guidance:
      'Build a lighter version: leaner cuts, less added fat, more vegetables, lighter cooking methods. ' +
      'Keep it a dish someone would actually want to eat — do not strip it to the point where it is a sad ' +
      'imitation of the thing they asked for.',
  },
  {
    id: 'high-protein',
    label: 'High protein',
    blurb: 'Protein-forward build of the dish',
    guidance:
      'Build the dish protein-forward: a generous protein element, and swaps that add protein where they fit ' +
      'naturally. Keep it recognisably the dish they named.',
  },
  {
    id: 'low-carb',
    label: 'Low carb',
    blurb: 'Carb swaps, still the same dish',
    guidance:
      'Swap the starch: cauliflower rice for rice, courgette or aubergine for pasta sheets, lettuce for a wrap, ' +
      'and so on. The dish must stay recognisably itself — if a swap would turn it into a different dish, say so ' +
      'in the notes and leave that part alone.',
  },
  {
    id: 'portion-controlled',
    label: 'Portion controlled',
    blurb: 'The normal dish, portions stated',
    guidance:
      'The ordinary dish, made exactly as it should be — nothing swapped or lightened. What is different is that ' +
      'the portions are explicit: state the per-serving amount in the steps, so serving up is unambiguous.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    blurb: 'A sensible middle, no agenda',
    guidance:
      'A sensible everyday version of the dish. No agenda in either direction: not lightened, not indulgent, ' +
      'just well made with a reasonable spread of vegetables, protein and starch.',
  },
  {
    id: 'quick',
    label: 'Quick',
    blurb: '30 minutes or less, weeknight-real',
    guidance:
      'Thirty minutes or less, start to plate, on a weeknight. Shortcuts are allowed and encouraged — jarred, ' +
      'tinned, pre-chopped, one pan. Be honest about the timing: if the dish genuinely cannot be done in thirty ' +
      'minutes, make the closest thing that can and say what you changed in the notes.',
  },
  {
    id: 'treat',
    label: 'Treat',
    blurb: 'The real thing, exactly as it should be',
    guidance:
      'The real thing, made properly, full fidelity. Butter, cream, sugar, frying — whatever the dish actually ' +
      'calls for.\n' +
      'ABSOLUTELY NO NUTRITION COMMENTARY OF ANY KIND. Do not lighten anything. Do not offer a swap, a ' +
      '"you could use", a lighter option, or a smaller portion. Do not mention calories, fat, sugar, ' +
      '"indulgent", "rich", "decadent", "treat yourself", "in moderation", "every now and then", or anything ' +
      'that hints at a view about whether they should be eating it. They asked for the real thing. Give them the ' +
      'real thing and say nothing about it. The notes field, if you use it at all, is for cooking craft only.',
  },
];

const MODE_IDS = MODES.map((m) => m.id);
const byId = (id) => MODES.find((m) => m.id === id) || null;

/** The chips the page renders. No mode is privileged or pre-selected here. */
function modeList() {
  return MODES.map((m) => ({ id: m.id, label: m.label, blurb: m.blurb }));
}

// ---------------------------------------------------------------------------
// generation
// ---------------------------------------------------------------------------

const BUILD_TOOL = {
  name: 'record_recipe',
  description: 'Write out the recipe you have composed.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'What to call it. Plain and recognisable.' },
      servings: { type: 'number', description: 'How many it serves.' },
      prep_minutes: { type: 'number' },
      cook_minutes: { type: 'number' },
      ingredients: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The ingredient as it would appear on a shopping list.' },
            quantity: { type: 'string', description: 'As a cook writes it: "200 g", "2 cans", "a pinch".' },
          },
          required: ['name'],
        },
      },
      steps: { type: 'array', items: { type: 'string' }, description: 'The method, one step per entry, in order.' },
      notes: {
        type: 'string',
        description: 'Optional, and only when there is something worth saying about COOKING it. Leave it out otherwise.',
      },
    },
    required: ['name', 'ingredients', 'steps'],
  },
};

/**
 * The system prompt. Built per call so the mode's own words are the operative
 * instruction rather than one branch among seven the model has to pick between.
 */
function buildSystem(mode, note) {
  return `You are writing one recipe, from your own knowledge of cooking. You have no lookup, no database and no way to search — write the dish you know.

THE BRIEF: ${mode.guidance}

- Write a recipe someone can actually cook: real quantities, steps in order, nothing vague.
- Quantities as a cook writes them ("200 g", "2 cloves", "1 tbsp"), not as a nutritionist would.
- Do not invent a tradition, a provenance, or a claim about the dish. Just cook it.
- Never grade the recipe or the person. No health score, no "this is a heavy one", no suggestion to eat something else.${
    note
      ? `\n\nTHE OWNER ALSO ASKED: "${note}"\nHonour that. If it is a dietary exclusion, exclude it completely — not "reduced", not "optional". If it conflicts with the brief above, the owner's words win and you note the tension in the notes field.`
      : ''
  }

Call record_recipe exactly once. Do not reply with prose.`;
}

/**
 * Generate a recipe draft. Returns { draft } or { error } — never throws.
 *
 * The call carries no conversation, no goals doc and no store: it is a writing
 * task, not a coaching turn, and giving it the owner's history would invite
 * exactly the unprompted commentary Decision 5 rules out.
 */
async function generate(cfg, { dish, mode, note }) {
  const m = byId(mode);
  if (!m) return { error: `I do not know a "${mode}" mode.` };
  const name = String(dish || '').trim().slice(0, 120);
  if (!name) return { error: 'Tell me what dish to build.' };
  const extra = String(note || '').trim().slice(0, 300);

  try {
    const res = await claude.complete(cfg, {
      system: buildSystem(m, extra),
      messages: [{ role: 'user', content: `Write me a recipe for: ${name}` }],
      tools: [BUILD_TOOL],
    });
    const call = claude.toolUsesOf(res).find((t) => t.name === BUILD_TOOL.name);
    if (!call || !call.input) return { error: 'I could not put that recipe together. Try again, or ask me in chat.' };

    const i = call.input;
    const ingredients = (i.ingredients || [])
      .map((r) => ({ name: String(r.name || '').trim().slice(0, 200), quantity: String(r.quantity || '').trim().slice(0, 80) }))
      .filter((r) => r.name)
      .slice(0, 60);
    if (!ingredients.length) return { error: 'That came back without any ingredients. Try again.' };

    return {
      draft: {
        name: String(i.name || name).slice(0, 200),
        servings: Math.min(Math.max(parseInt(i.servings, 10) || 4, 1), 99),
        prepMinutes: i.prep_minutes ? Math.round(i.prep_minutes) : null,
        cookMinutes: i.cook_minutes ? Math.round(i.cook_minutes) : null,
        ingredients,
        steps: (i.steps || []).map((s) => String(s).trim().slice(0, 1000)).filter(Boolean).slice(0, 60),
        notes: String(i.notes || '').trim().slice(0, 2000),
        mode: m.id,
      },
    };
  } catch {
    return { error: 'I could not reach my own thinking for that one. Try again in a moment.' };
  }
}

// ---------------------------------------------------------------------------
// the treat-mode guard
// ---------------------------------------------------------------------------

/**
 * Language that must never appear in a Treat recipe (Decision 2).
 *
 * Two families, and both matter: the obvious nutrition remark ("400 calories a
 * slice"), and the softer permission-granting register that is the same
 * judgement wearing a friendly face — "indulgent", "in moderation", "worth it
 * once in a while". The owner asked for the real thing; being told it is a
 * treat is the app having a view.
 *
 * Exported so it can be asserted against real generated output, not just
 * trusted to the prompt.
 */
const TREAT_FORBIDDEN = [
  // Nutrition talk, anchored to a nutrient. Bare "low", "reduce" and "lighter"
  // are NOT here and must not be added: "low heat", "reduce the sauce" and "a
  // lighter batter" are ordinary cooking craft, and the first version of this
  // list flagged four perfectly good treat recipes for exactly that. A guard
  // that fires on correct output is worse than no guard, because the next
  // person to hit it deletes it.
  /\bcalor(ie|ies)\b/i,
  /\blow[-\s](calorie|fat|carb|sugar|salt|sodium)\b/i,
  /\breduced[-\s](calorie|fat|carb|sugar|salt|sodium)\b/i,
  /\bless (fat|sugar|salt|butter|cream|oil)\b/i,
  /\bhealthier\b/i,
  /\bhealthy (option|choice|alternative|swap|version)\b/i,
  /\blighter (version|option|alternative|take|choice)\b/i,
  /\blighten (it|the|this|things)\b/i,
  /\bto (cut|save|reduce) (the )?(calories|fat|carbs|sugar|salt)\b/i,
  /\bif you want(ed)? to (cut|save|lighten|reduce the (fat|sugar|calories))\b/i,
  /\bswap .{0,40}\bfor a (lighter|leaner|healthier)\b/i,
  // The softer register: the same judgement wearing a friendly face.
  /\bindulgen\w*/i,
  /\bdecadent\b/i,
  /\btreat yourself\b/i,
  /\bin moderation\b/i,
  /\bevery (now and then|once in a while)\b/i,
  /\bguilt\w*/i,
  /\bsplurge\b/i,
  /\bnaught(y|ier)\b/i,
  /\bsinful\b/i,
  /\bwon'?t break the bank nutritionally\b/i,
];

/** Which forbidden phrases a treat recipe contains. Empty is the pass. */
function treatViolations(draft) {
  const text = [draft.name, draft.notes, ...(draft.steps || [])].filter(Boolean).join('\n');
  return TREAT_FORBIDDEN.filter((re) => re.test(text)).map((re) => re.source);
}

module.exports = { MODES, MODE_IDS, modeList, byId, generate, buildSystem, BUILD_TOOL, TREAT_FORBIDDEN, treatViolations };
