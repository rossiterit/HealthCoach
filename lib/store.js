'use strict';
/**
 * store.js — the shared health store (F6).
 *
 * One store, many coaches. v1 only writes `meals`, `goals`, `messages` and
 * `checkins`, but `workouts`, `weight` and `energy` are part of the schema from
 * day one so FitnessCoach can be added later without a migration — that is the
 * explicit requirement in GOTK-152, and empty arrays cost nothing.
 *
 * Persistence is a single JSON document written atomically (tmp file + rename),
 * which is the right shape for one user and a few thousand rows: the whole store
 * fits in memory, every read is free, and a crash mid-write can never leave a
 * half-written file behind. Writes are serialized through one promise chain so
 * two concurrent requests can't clobber each other's snapshot.
 *
 * Nutrition entries record their own provenance (`source` / `estimate`). v1 has
 * only one source — Claude's estimate — but the field exists so a real nutrition
 * engine can be introduced later and old rows stay honest about where they came from.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Leaf dependency: recipes.js takes the store as an argument and requires
// nothing back, so there is no cycle here.
const recipes = require('./recipes');

// Bumped to 2 by v3: `foods`, `favorites` and `plans` are genuinely new tables
// rather than reserved ones being activated (which is what v2's workouts/weight
// were). load() merges onto a fresh skeleton, so an existing v2 store gains them
// on first read with no migration step and no data touched.
// Bumped to 3 by v4: `recipes` is a genuinely new table. Same merge-on-load
// story as before — an existing v3 store gains it empty on first read.
// Bumped to 4 by v5: `proposals` is a new table. Same merge-on-load story.
const SCHEMA_VERSION = 4;

// Eight tiles, per build-package Decision 5. A fixed-length board rather than a
// growable list, because the mockup's favourites row is a fixed row of tiles and
// "drop onto an occupied tile overwrites it" only means anything if slots are
// addressable positions.
const FAVORITE_SLOTS = 8;

function emptyStore() {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    // --- DietCoach (v1) ---
    goals: null,          // the goals doc from the onboarding interview (F2)
    meals: [],            // logged meals with full nutrition payload (F3)
    messages: [],         // conversation history (F4)
    checkins: [],         // one row per daily check-in sent (F5)
    // --- FitnessCoach (deferred; schema present, unused in v1) ---
    workouts: [],         // { id, ts, type, durationMin, intensity, notes }
    weight: [],           // { id, ts, lb, notes } — pounds; owner's choice 2026-09-12
    energy: [],           // { id, ts, rating, notes }
    // --- Meal planner (v3) ---
    foods: [],            // the owner's own library: { id, name, kind, nutrition, ... }
    favorites: new Array(FAVORITE_SLOTS).fill(null), // slot index -> foodId | null
    plans: {},            // weekStart (Monday YYYY-MM-DD) -> plan doc
    // --- Recipes (v4) ---
    recipes: [],          // { id, name, servings, ingredients[], steps[], ... }
    // --- Coach plan proposals (v5) ---
    //
    // DELIBERATELY NOT INSIDE `plans`. A proposal is something the coach has
    // suggested and the owner has not accepted, and keeping it in its own
    // table is what makes "nothing enters the grid without Apply" a property
    // of where the data lives rather than something the UI has to remember.
    // Reading a week's plan cannot accidentally read a proposal, because the
    // proposal is not there.
    proposals: [],        // { id, weekStart, days{}, createdAt, mode, ... }
    // The reviewed shopping list, per week (v5 F4). Kept so closing the
    // review and coming back shows the same ticks — a cull the owner made is
    // a decision, not a transient bit of UI state.
    shoppingLists: {},    // weekStart -> { items[], generatedAt, ... }
  };
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'store.json');
    this.data = emptyStore();
    this._writeChain = Promise.resolve();
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file)) {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Merge onto a fresh skeleton so a store written by an older build gains
      // any array added since without a migration step.
      this.data = Object.assign(emptyStore(), parsed);
      this.data.schemaVersion = SCHEMA_VERSION;
      // Object.assign replaces the favourites board wholesale, so a store
      // written by a build with a different tile count (or a hand-edited one)
      // would come back the wrong length and silently lose or invent slots.
      // Normalise to exactly FAVORITE_SLOTS, keeping whatever was pinned.
      const board = Array.isArray(this.data.favorites) ? this.data.favorites : [];
      this.data.favorites = Array.from({ length: FAVORITE_SLOTS }, (_, i) => board[i] ?? null);
      if (!this.data.plans || typeof this.data.plans !== 'object' || Array.isArray(this.data.plans)) {
        this.data.plans = {};
      }
      if (!this.data.shoppingLists || typeof this.data.shoppingLists !== 'object' || Array.isArray(this.data.shoppingLists)) {
        this.data.shoppingLists = {};
      }
    } else {
      this._writeSync();
    }
    return this;
  }

  _writeSync() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file); // atomic on the same filesystem
  }

  /** Queue a durable write. Serialized so concurrent callers can't interleave. */
  save() {
    this._writeChain = this._writeChain.then(() => this._writeSync()).catch((e) => {
      console.error('[store] write failed:', e.message);
    });
    return this._writeChain;
  }

  // ---- goals (F2) -------------------------------------------------------

  getGoals() {
    return this.data.goals;
  }

  /**
   * Replace the goals doc. Revisions are expected — the coach can rewrite it on
   * request — so we keep a `revision` counter and the previous doc for context.
   */
  setGoals(doc) {
    const prev = this.data.goals;
    this.data.goals = {
      ...doc,
      revision: prev ? (prev.revision || 1) + 1 : 1,
      createdAt: prev ? prev.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.save();
    return this.data.goals;
  }

  // ---- meals (F3) -------------------------------------------------------

  addMeal(meal) {
    const row = {
      id: newId('meal'),
      loggedAt: new Date().toISOString(),
      ts: meal.ts || new Date().toISOString(),
      description: meal.description || '',
      mealType: meal.mealType || 'unspecified',
      items: meal.items || [],
      nutrition: meal.nutrition || {},
      source: meal.source || 'estimate',
      estimate: meal.estimate !== false,
      notes: meal.notes || '',
      correctedFrom: meal.correctedFrom || null,
    };
    this.data.meals.push(row);
    this.save();
    return row;
  }

  getMeal(id) {
    return this.data.meals.find((m) => m.id === id) || null;
  }

  /**
   * Apply a correction to a logged meal (F3: "correctable by reply"). The row is
   * updated in place and stamped so the history shows it was revised rather than
   * silently rewritten.
   */
  updateMeal(id, patch) {
    const row = this.getMeal(id);
    if (!row) return null;
    Object.assign(row, patch, { id: row.id, correctedAt: new Date().toISOString() });
    this.save();
    return row;
  }

  /** Most recent meals first, newest N. */
  recentMeals(limit = 20) {
    return [...this.data.meals].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
  }

  /** Meals whose local date matches `dateStr` (YYYY-MM-DD in the configured zone). */
  mealsOnDate(dateStr, timezone) {
    return this.data.meals.filter((m) => localDate(m.ts, timezone) === dateStr);
  }

  // ---- movement ledger (v2 F4) -------------------------------------------
  //
  // The reserved `workouts` table, activated. Note what is NOT stored: no
  // streak counter, no "days active", no target, no comparison to anything.
  // A row records that something happened. Nothing here can be counted into a
  // chain, because the app never asks the question.

  addWorkout(w) {
    const row = {
      id: newId('wk'),
      loggedAt: new Date().toISOString(),
      ts: w.ts || new Date().toISOString(),
      outletId: w.outletId || 'other',
      outletLabel: w.outletLabel || 'Movement',
      description: w.description || '',
      durationMinutes: Number(w.durationMinutes) || null,
      intensity: w.intensity || null,
      notes: w.notes || '',
    };
    this.data.workouts.push(row);
    this.save();
    return row;
  }

  getWorkout(id) {
    return this.data.workouts.find((w) => w.id === id) || null;
  }

  recentWorkouts(limit = 20) {
    return [...this.data.workouts].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
  }

  workoutsOnDate(dateStr, timezone) {
    return this.data.workouts.filter((w) => localDate(w.ts, timezone) === dateStr);
  }

  // ---- weight (v2 F5) -----------------------------------------------------
  //
  // Pounds. The reserved v1 field was `kg` and was never written to, so the
  // rename cost no data. Note what a row does NOT carry: no target, no delta,
  // no verdict, no flag. A row is a reading and a time. Everything else is
  // derived at read time by weight.js, which means there is no stored judgement
  // to leak into a view later.

  addWeight(w) {
    const row = {
      id: newId('wt'),
      loggedAt: new Date().toISOString(),
      ts: w.ts || new Date().toISOString(),
      lb: Math.round(Number(w.lb) * 10) / 10,
      notes: w.notes || '',
    };
    this.data.weight.push(row);
    this.save();
    return row;
  }

  recentWeights(limit = 60) {
    return [...this.data.weight].sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
  }

  // ---- the food library (v3 F1) ------------------------------------------
  //
  // The owner's own library, not a database of all food. It starts empty and
  // grows only from what they actually search for, which is why there is no
  // seeding step and no external source: every row in here got there because
  // they typed it once. `estimate` is true on every row and there is no code
  // path that sets it false — v3 added no measured source, so a row that
  // claimed to be measured would be lying.

  addFood(f) {
    const row = {
      id: newId('food'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: String(f.name || '').trim().slice(0, 200),
      // 'food' is a single ingredient or product; 'meal' is a composed dish.
      // Both live in one table because the planner treats them identically —
      // the distinction is only ever shown to the owner.
      kind: f.kind === 'meal' ? 'meal' : 'food',
      quantity: f.quantity ? String(f.quantity).slice(0, 80) : null,
      nutrition: f.nutrition || {},
      source: f.source || 'claude-estimate',
      estimate: true,
      notes: f.notes || '',
    };
    this.data.foods.push(row);
    this.save();
    return row;
  }

  getFood(id) {
    return this.data.foods.find((f) => f.id === id) || null;
  }

  /** Correct a library item (F1: "editable/correctable by chat"). */
  updateFood(id, patch) {
    const row = this.getFood(id);
    if (!row) return null;
    Object.assign(row, patch, { id: row.id, estimate: true, updatedAt: new Date().toISOString() });
    this.save();
    return row;
  }

  allFoods() {
    return [...this.data.foods];
  }

  // ---- recipes (v4 F1) ----------------------------------------------------
  //
  // A recipe is a composed library item: named, portioned, made of other
  // library rows, with ordered steps. It is stored in its own table rather than
  // squeezed into `foods` because it has structure a food does not — servings,
  // ingredient rows, steps, and a link to whatever it was healthified from —
  // but it is resolved THROUGH the same library lookup (see libraryItem), so
  // search, favourites and the planner treat it exactly like a meal.
  //
  // Versioning is by linkage, not by mutation history: healthifying writes a
  // NEW recipe carrying `healthifiedFrom`, and the original is never touched.
  // That is Decision 3 — the healthifier never overwrites — held in the store
  // rather than trusted to each caller.

  addRecipe(r) {
    const row = {
      id: newId('rcp'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      name: String(r.name || '').trim().slice(0, 200),
      // Servings is the canonical unit (Decision 2): everything else is
      // derived from it, so it can never be zero or absent.
      servings: Math.min(Math.max(parseInt(r.servings, 10) || 1, 1), 99),
      ingredients: recipes.normaliseIngredients(r.ingredients),
      steps: recipes.normaliseSteps(r.steps),
      prepMinutes: recipes.posIntOrNull(r.prepMinutes),
      cookMinutes: recipes.posIntOrNull(r.cookMinutes),
      notes: r.notes ? String(r.notes).slice(0, 2000) : '',
      // Set when this recipe is a healthified copy of another. The original
      // keeps no pointer forward, so deleting a copy can never orphan it.
      healthifiedFrom: r.healthifiedFrom || null,
      healthifyNote: r.healthifyNote ? String(r.healthifyNote).slice(0, 2000) : '',
      source: r.source || 'owner',
    };
    this.data.recipes.push(row);
    this.save();
    return row;
  }

  getRecipe(id) {
    return this.data.recipes.find((r) => r.id === id) || null;
  }

  allRecipes() {
    return [...this.data.recipes];
  }

  /**
   * Revise a recipe in place. Used by the editor and by chat edits — NOT by
   * the healthifier, which writes a new row instead (Decision 3).
   */
  updateRecipe(id, patch) {
    const row = this.getRecipe(id);
    if (!row) return null;
    const next = { ...patch };
    if (next.servings !== undefined) next.servings = Math.min(Math.max(parseInt(next.servings, 10) || 1, 1), 99);
    if (next.ingredients !== undefined) next.ingredients = recipes.normaliseIngredients(next.ingredients);
    if (next.steps !== undefined) next.steps = recipes.normaliseSteps(next.steps);
    if (next.name !== undefined) next.name = String(next.name).trim().slice(0, 200);
    Object.assign(row, next, { id: row.id, createdAt: row.createdAt, updatedAt: new Date().toISOString() });
    this.save();
    return row;
  }

  /**
   * Remove a recipe. Anything pinned to it or planned with it is cleaned up
   * here, because a dangling reference would render as a blank card with no
   * way for the owner to work out what it used to be.
   */
  deleteRecipe(id) {
    const i = this.data.recipes.findIndex((r) => r.id === id);
    if (i === -1) return false;
    this.data.recipes.splice(i, 1);
    this.data.favorites = this.data.favorites.map((f) => (f === id ? null : f));
    for (const plan of Object.values(this.data.plans)) {
      for (const day of Object.values(plan.days || {})) {
        for (const slot of Object.keys(day)) {
          day[slot] = (day[slot] || []).filter((e) => e.foodId !== id);
        }
      }
    }
    this.save();
    return true;
  }

  // ---- the reviewed shopping list (v5 F4) ---------------------------------

  getShoppingList(weekStart) {
    return this.data.shoppingLists[weekStart] || null;
  }

  setShoppingList(weekStart, list) {
    this.data.shoppingLists[weekStart] = list;
    this.save();
    return list;
  }

  clearShoppingList(weekStart) {
    delete this.data.shoppingLists[weekStart];
    this.save();
  }

  // ---- plan proposals (v5 F3) ---------------------------------------------
  //
  // Propose-then-apply, held in the store rather than in a request. A proposal
  // survives a restart — the owner can be halfway through deciding when the
  // service bounces and lose nothing — and applying is a separate, explicit
  // act that copies cards across into the real plan.

  addProposal(p) {
    const row = {
      id: newId('prop'),
      createdAt: new Date().toISOString(),
      weekStart: p.weekStart,
      // Which dates this proposal covers. A day proposal has one, a week has six.
      dates: [...(p.dates || [])],
      mode: p.mode || null,
      // date -> slot -> [ { foodId, name, servings } ]
      days: p.days || {},
      note: p.note || '',
      // Set when the owner applies or discards; a resolved proposal is kept
      // briefly rather than deleted so an echo can still name it.
      resolvedAt: null,
      resolution: null,    // 'applied' | 'discarded' | 'partly-applied'
      appliedDates: [],
    };
    // One live proposal at a time: a second would leave the owner deciding
    // between two previews in the same grid, which is not a decision anyone
    // wants. Superseding is explicit rather than silent — the old one is
    // marked, not dropped.
    for (const old of this.data.proposals) {
      if (!old.resolvedAt) {
        old.resolvedAt = new Date().toISOString();
        old.resolution = 'superseded';
      }
    }
    this.data.proposals.push(row);
    this.save();
    return row;
  }

  /** The proposal awaiting a decision, if any. There is at most one. */
  liveProposal() {
    return this.data.proposals.find((p) => !p.resolvedAt) || null;
  }

  getProposal(id) {
    return this.data.proposals.find((p) => p.id === id) || null;
  }

  /** Mark a proposal decided. Does not itself write to the plan. */
  resolveProposal(id, resolution, appliedDates = []) {
    const row = this.getProposal(id);
    if (!row) return null;
    row.resolvedAt = new Date().toISOString();
    row.resolution = resolution;
    row.appliedDates = [...appliedDates];
    this.save();
    return row;
  }

  /**
   * Record that some days of a proposal have been committed (v5 F2).
   *
   * Apply-per-day means the owner can take Monday now and decide about the
   * rest later, so applying part of a proposal must NOT resolve the whole
   * thing — the first version did, and the remaining days became unreachable
   * the moment one was accepted. Applied days are removed from the pending
   * preview; the proposal resolves itself only once nothing is left.
   */
  markProposalDaysApplied(id, dates) {
    const row = this.getProposal(id);
    if (!row) return null;
    const done = new Set(dates || []);
    row.appliedDates = [...new Set([...(row.appliedDates || []), ...done])];
    row.dates = row.dates.filter((d) => !done.has(d));
    for (const d of done) delete row.days[d];
    if (!row.dates.length) {
      row.resolvedAt = new Date().toISOString();
      row.resolution = 'applied';
    }
    this.save();
    return row;
  }

  /** Housekeeping: resolved proposals are history, not state. */
  pruneProposals(keep = 5) {
    const resolved = this.data.proposals.filter((p) => p.resolvedAt);
    if (resolved.length <= keep) return 0;
    const drop = new Set(resolved.slice(0, resolved.length - keep).map((p) => p.id));
    this.data.proposals = this.data.proposals.filter((p) => !drop.has(p.id));
    this.save();
    return drop.size;
  }

  // ---- the library: foods AND recipes (v4) --------------------------------
  //
  // Decision: recipes are first-class library citizens. Rather than duplicating
  // a food row per recipe — which would drift the moment either changed — the
  // library is a VIEW over both tables. Everything that used to look up a food
  // by id (the planner, the favourites board, the search field) looks up a
  // library item instead, and neither knows or cares which table answered.

  /** One library item by id: a food, or a recipe presented as one. */
  libraryItem(id) {
    const food = this.getFood(id);
    if (food) return food;
    const recipe = this.getRecipe(id);
    // Computed at read time, not stored: correcting an ingredient's macros by
    // chat must reflow every recipe that uses it, the same way v3 made a
    // library correction reflow every plan.
    return recipe ? recipes.asLibraryItem(this, recipe) : null;
  }

  /** Every library item, foods and recipes alike. */
  libraryItems() {
    return [...this.data.foods, ...this.data.recipes.map((r) => recipes.asLibraryItem(this, r))];
  }

  // ---- favourites (v3 F1/Decision 5) -------------------------------------
  //
  // A fixed board of FAVORITE_SLOTS positions. Nothing here deletes a food:
  // unpinning and overwriting both only clear a slot, and the row stays in the
  // library and findable by search. That is Decision 5's "nothing is deleted by
  // a drop", enforced in the store rather than trusted to every caller.

  favorites() {
    return [...this.data.favorites];
  }

  /**
   * Pin a food to a slot. Returns { slot, foodId, replaced } where `replaced` is
   * the foodId that previously held the slot, or null. An explicit slot
   * overwrites; omitting the slot takes the first free one and refuses when the
   * board is full rather than evicting a pin the owner never chose to lose.
   */
  pinFavorite(foodId, slot = null) {
    // A tile may hold a food or a recipe — both are library items (v4 F1).
    if (!this.libraryItem(foodId)) return { error: 'no such food' };
    const board = this.data.favorites;

    // Already pinned? Moving it is a move, not a second copy — a food occupies
    // at most one tile, or the board could show the same meal twice.
    const existingSlot = board.indexOf(foodId);

    let target = slot;
    if (target === null || target === undefined) {
      if (existingSlot !== -1) return { slot: existingSlot, foodId, replaced: null, alreadyPinned: true };
      target = board.indexOf(null);
      if (target === -1) return { error: 'board full' };
    }
    target = Number(target);
    if (!Number.isInteger(target) || target < 0 || target >= FAVORITE_SLOTS) return { error: 'bad slot' };

    const replaced = board[target] && board[target] !== foodId ? board[target] : null;
    if (existingSlot !== -1 && existingSlot !== target) board[existingSlot] = null;
    board[target] = foodId;
    this.save();
    return { slot: target, foodId, replaced };
  }

  /** Clear a slot (or wherever this food is pinned). The food itself survives. */
  unpinFavorite({ slot = null, foodId = null } = {}) {
    const board = this.data.favorites;
    const target = slot !== null && slot !== undefined ? Number(slot) : board.indexOf(foodId);
    if (!Number.isInteger(target) || target < 0 || target >= FAVORITE_SLOTS) return null;
    const was = board[target];
    board[target] = null;
    this.save();
    return was;
  }

  // ---- plans (v3 F2) -----------------------------------------------------
  //
  // Keyed by the Monday that starts the week. A plan holds INTENTIONS: no row
  // in here is a log entry, and nothing reads it into `meals` without the
  // owner's explicit confirmation (Decision 1). `confirmed` records which dates
  // have been bridged across, which is what stops a day confirming twice.

  getPlan(weekStart) {
    return this.data.plans[weekStart] || null;
  }

  /** The plan for a week, created empty on first touch. */
  ensurePlan(weekStart, dates) {
    let plan = this.data.plans[weekStart];
    if (!plan) {
      plan = {
        weekStart,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        days: {},
        confirmed: {},
      };
      this.data.plans[weekStart] = plan;
    }
    for (const d of dates || []) {
      if (!plan.days[d]) plan.days[d] = { breakfast: [], lunch: [], dinner: [], snacks: [] };
    }
    return plan;
  }

  touchPlan(weekStart) {
    const plan = this.data.plans[weekStart];
    if (plan) plan.updatedAt = new Date().toISOString();
    this.save();
    return plan;
  }

  // ---- conversation (F4) -------------------------------------------------

  addMessage(role, text, extra = {}) {
    const row = {
      id: newId('msg'),
      ts: new Date().toISOString(),
      role,
      text,
      ...extra,
    };
    this.data.messages.push(row);
    this.save();
    return row;
  }

  recentMessages(limit = 30) {
    return this.data.messages.slice(-limit);
  }

  // ---- check-ins (F5) ----------------------------------------------------

  /** The check-in row for a local date, if one was already sent. */
  checkinOnDate(dateStr) {
    return this.data.checkins.find((c) => c.date === dateStr) || null;
  }

  addCheckin(dateStr, text, ok) {
    const row = { id: newId('chk'), date: dateStr, sentAt: new Date().toISOString(), text, ok };
    this.data.checkins.push(row);
    this.save();
    return row;
  }
}

/**
 * The local calendar date for an instant, in a named zone. Used for the
 * once-per-day check-in cap and for "what did I eat today" — both of which must
 * follow the owner's wall clock, not UTC.
 */
function localDate(iso, timezone) {
  const d = iso instanceof Date ? iso : new Date(iso);
  // en-CA renders as YYYY-MM-DD, which is exactly the key format we want.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

module.exports = { Store, localDate, emptyStore, newId, SCHEMA_VERSION, FAVORITE_SLOTS };
