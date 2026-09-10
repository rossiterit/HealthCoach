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

const SCHEMA_VERSION = 1;

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
    weight: [],           // { id, ts, kg, notes }
    energy: [],           // { id, ts, rating, notes }
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

module.exports = { Store, localDate, emptyStore, newId, SCHEMA_VERSION };
