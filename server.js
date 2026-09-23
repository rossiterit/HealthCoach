'use strict';
/**
 * server.js — HealthCoach HTTP service.
 *
 * GOTK-152 lands the skeleton: the shared store behind a clean internal API.
 * The coach module, the chat page, and the daily check-in arrive on top of this
 * in GOTK-154, -153 and -155 respectively.
 *
 * F7's point is that Glorian should later talk to HealthCoach rather than to its
 * UI. That only stays true if the UI has no private back door — so the API is
 * built first and the page, when it arrives, is a plain client of it.
 *
 * Trust boundary: this process listens on 127.0.0.1 only. Public access arrives
 * through nginx, which terminates TLS and enforces the single-user Basic auth
 * gate; the app itself does no authentication, because anything that can reach
 * the loopback interface is already inside the box. That is also what makes the
 * internal API reachable for Glorian later without punching a hole in the gate.
 *
 * The route table tolerates the /healthcoach/ prefix as well as bare paths, so
 * the service behaves identically whether it is reached through the nginx
 * location block or hit directly on its port during testing.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const { load } = require('./lib/config');
const { Store, localDate } = require('./lib/store');
const coach = require('./lib/coach');
const stretch = require('./lib/stretch');
const workouts = require('./lib/workouts');
const weight = require('./lib/weight');
const briefing = require('./lib/briefing');
const nutrition = require('./lib/nutrition');
const foods = require('./lib/foods');
const planner = require('./lib/planner');
const telegram = require('./lib/telegram');

const cfg = load();
const store = new Store(cfg.dataDir).load();

// The page is a single self-contained document, so it is read once at boot and
// served from memory. A deploy is a restart, which is when it should change.
const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const MAX_BODY = 64 * 1024;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function send(res, status, payload, type = 'application/json') {
  const body = type === 'application/json' ? JSON.stringify(payload) : payload;
  res.writeHead(status, {
    'Content-Type': type === 'application/json' ? 'application/json; charset=utf-8' : type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Body was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** Strip the nginx location prefix so routes match either way. */
function normalisePath(pathname) {
  const p = pathname.replace(/^\/healthcoach(?=\/|$)/, '') || '/';
  return p === '' ? '/' : p;
}

/** A meal as the API sees it — no internal fields leak. */
function publicMeal(m) {
  return {
    id: m.id,
    ts: m.ts,
    date: localDate(m.ts, cfg.timezone),
    mealType: m.mealType,
    description: m.description,
    items: m.items,
    nutrition: m.nutrition,
    source: m.source,
    estimate: m.estimate,
    provenance: nutrition.provenanceLabel(m.source),
    notes: m.notes,
    corrected: Boolean(m.correctedAt),
  };
}

/**
 * A logged row as the API and the page see it. Dispatches on `kind` so a module
 * can add a row type without every caller learning about it.
 */
function publicEntry(row) {
  if (row.kind === 'meal' || row.mealType) return { ...publicMeal(row), kind: 'meal' };
  return { ...row, date: localDate(row.ts, cfg.timezone) };
}

/** The favourites board as the page renders it: eight positions, holes and all. */
function favoritesPayload() {
  return store.favorites().map((id, slot) => (id ? foods.publicFood(store.getFood(id), slot) : null));
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function route(req, res, url) {
  const p = normalisePath(url.pathname);
  const method = req.method;

  // --- the chat page (F1) ---
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    return send(res, 200, INDEX, 'text/html; charset=utf-8');
  }

  // --- liveness / config sanity, safe to expose: names no secret values ---
  if (method === 'GET' && p === '/api/health') {
    return send(res, 200, {
      ok: true,
      service: 'healthcoach',
      version: require('./package.json').version,
      schemaVersion: store.data.schemaVersion,
      timezone: cfg.timezone,
      onboarded: Boolean(store.getGoals()),
      counts: {
        meals: store.data.meals.length,
        messages: store.data.messages.length,
        checkins: store.data.checkins.length,
        workouts: store.data.workouts.length,
        weight: store.data.weight.length,
        energy: store.data.energy.length,
        foods: store.data.foods.length,
        favorites: store.favorites().filter(Boolean).length,
        plans: Object.keys(store.data.plans).length,
      },
      nutritionEngine: cfg.nutrition.engine,
      briefing: { enabled: cfg.briefing.enabled, time: cfg.briefing.time, timezone: cfg.briefing.timezone },
      // Presence, never the value — the confidentiality floor applies to a
      // health endpoint as much as to a log.
      telegramConfigured: telegram.configured(cfg),
      // Sunday's meal-plan prompt is a card ON THE PAGE, never an extra push —
      // the one-touch-per-day rule stands (F6).
      mealPlanPrompt:
        new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timezone, weekday: 'long' }).format(new Date()) === 'Sunday',
    });
  }

  // --- a conversational turn (F3/F4) ---
  if (method === 'POST' && p === '/api/chat') {
    const body = await readJson(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return send(res, 400, { error: 'Send a non-empty "message".' });

    try {
      const out = await coach.turn(store, cfg, message);
      return send(res, 200, {
        reply: out.reply,
        logged: out.logged.map(publicEntry),
        corrected: out.corrected.map(publicEntry),
        goalsUpdated: out.goalsUpdated,
      });
    } catch (e) {
      // The message is already redacted by lib/claude.js before it gets here.
      console.error('[chat]', e.message);
      return send(res, 502, { error: e.message });
    }
  }

  // --- the stretch routine (F2, GOTK-159) ---
  if (method === 'GET' && p === '/api/stretch') {
    const which = url.searchParams.get('variant');
    const routine = which ? stretch.variant(which) : stretch.daily();
    if (!routine) return send(res, 404, { error: `No stretch variant called "${which}".` });
    return send(res, 200, {
      routine,
      variants: stretch.variantNames(),
      safetyNote: stretch.SAFETY_NOTE,
    });
  }

  // --- movement: the week's ledger and today's suggestion (F3/F4) ---
  if (method === 'GET' && p === '/api/movement') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days') || 7), 1), 90);
    const s = workouts.summary(store, cfg, days);
    const pick = workouts.suggest(store, cfg);
    return send(res, 200, {
      // What WAS done. There is deliberately no streak, no active-day count and
      // no gap anywhere in this payload — the page cannot render what it is
      // never sent.
      week: { days: s.days, count: s.count, totalMinutes: s.totalMinutes, byOutlet: s.byOutlet, entries: s.entries },
      line: workouts.summaryLine(store, cfg, days),
      suggestion: { outlet: pick.outlet, reason: pick.reason, tradeDown: pick.tradeDown },
      outlets: workouts.outlets(cfg),
    });
  }

  // --- weight: trend, never verdict (F5) ---
  if (method === 'GET' && p === '/api/weight') {
    const t = weight.both(store, cfg);
    return send(res, 200, {
      unit: 'lb',
      week: t.week,
      month: t.month,
      // Neutral sentences. No target, no valence, nothing for a view to colour
      // green or red — see lib/weight.js for why.
      lines: { week: weight.line(store, cfg, 7), month: weight.line(store, cfg, 30) },
    });
  }

  // --- goals doc (F2) ---
  if (method === 'GET' && p === '/api/goals') {
    return send(res, 200, { goals: store.getGoals() });
  }

  // --- logged meals (F3/F6) ---
  if (method === 'GET' && p === '/api/meals') {
    const date = url.searchParams.get('date');
    if (date) {
      return send(res, 200, { date, meals: store.mealsOnDate(date, cfg.timezone).map(publicMeal) });
    }
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500);
    return send(res, 200, { meals: store.recentMeals(limit).map(publicMeal) });
  }

  // --- day summary, the shape a coaching reply or check-in leans on ---
  if (method === 'GET' && p === '/api/summary') {
    const date = url.searchParams.get('date') || localDate(new Date(), cfg.timezone);
    const meals = store.mealsOnDate(date, cfg.timezone);
    return send(res, 200, {
      date,
      count: meals.length,
      nutrition: nutrition.total(meals.map((m) => ({ nutrition: m.nutrition }))),
      estimate: true,
      meals: meals.map(publicMeal),
    });
  }

  // --- the food library: search, create-on-miss, favourites (v3 F1) --------
  //
  // Search is a GET and never writes: typing in the search field must not
  // silently fill the library with half-typed words. Creating is a separate,
  // explicit POST — which is also the only place in v3 that calls the model
  // outside a conversational turn, and still writes only to this app's store.

  if (method === 'GET' && p === '/api/foods') {
    const q = url.searchParams.get('q');
    const board = store.favorites();
    const slotOf = (id) => {
      const i = board.indexOf(id);
      return i === -1 ? null : i;
    };
    if (q === null) {
      return send(res, 200, {
        foods: store.allFoods().map((f) => foods.publicFood(f, slotOf(f.id))),
        favorites: favoritesPayload(),
      });
    }
    const hit = foods.search(store, q);
    return send(res, 200, {
      query: hit.query,
      results: hit.results.map((f) => foods.publicFood(f, slotOf(f.id))),
      // `miss` is what the page uses to offer "add this to the library".
      miss: hit.miss,
      estimate: true,
    });
  }

  if (method === 'POST' && p === '/api/foods') {
    const body = await readJson(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return send(res, 400, { error: 'Send a non-empty "name".' });
    try {
      const out = await foods.findOrCreate(store, cfg, name);
      const board = store.favorites();
      return send(res, out.created ? 201 : 200, {
        food: foods.publicFood(out.food, board.indexOf(out.food.id) === -1 ? null : board.indexOf(out.food.id)),
        created: out.created,
        estimate: true,
      });
    } catch (e) {
      console.error('[foods]', e.message);
      return send(res, 502, { error: e.message });
    }
  }

  if (method === 'POST' && p === '/api/favorites') {
    const body = await readJson(req);
    const action = body.action === 'unpin' ? 'unpin' : 'pin';

    if (action === 'unpin') {
      const was = store.unpinFavorite({
        slot: body.slot === undefined ? null : body.slot,
        foodId: body.foodId || null,
      });
      // Nothing is deleted by an unpin — the row stays in the library. The
      // response says so explicitly so a client cannot render it as a removal.
      return send(res, 200, { favorites: favoritesPayload(), unpinned: was, deleted: false });
    }

    const out = store.pinFavorite(body.foodId, body.slot === undefined ? null : body.slot);
    if (out.error === 'board full') {
      return send(res, 409, { error: 'All eight tiles are taken. Drop the meal on the tile you want to replace.' });
    }
    if (out.error) return send(res, 400, { error: out.error });
    return send(res, 200, {
      favorites: favoritesPayload(),
      slot: out.slot,
      // The replaced pin is unpinned, never deleted (Decision 5).
      replaced: out.replaced ? foods.publicFood(store.getFood(out.replaced), null) : null,
      deleted: false,
    });
  }

  // --- the week grid (v3 F2) ----------------------------------------------
  //
  // Every mutation here writes to `plans` and nowhere else. There is no route
  // in this block that can reach `meals`: the plan-to-log bridge is F3's
  // explicit confirmation, and Decision 1 is worth enforcing by layout as well
  // as by intent.

  if (method === 'GET' && p === '/api/plan') {
    const weeks = planner.plannableWeeks(new Date(), cfg.timezone);
    const asked = url.searchParams.get('week');
    // Only the current and next week are addressable, per Decision 3. An
    // unknown week falls back to the default rather than 404ing, so a stale
    // bookmark opens the planner instead of an error.
    const weekStart = weeks.includes(asked) ? asked : weeks[0];
    return send(res, 200, {
      ...planner.view(store, cfg, weekStart),
      weeks,
      today: localDate(new Date(), cfg.timezone),
      favorites: favoritesPayload(),
      // Said once, here, so the page never has to decide how to label a figure.
      estimateNote: 'Totals are estimates.',
    });
  }

  if (method === 'POST' && p.startsWith('/api/plan/')) {
    const body = await readJson(req);
    const weeks = planner.plannableWeeks(new Date(), cfg.timezone);
    const weekStart = weeks.includes(body.week) ? body.week : weeks[0];
    const action = p.slice('/api/plan/'.length);

    let out;
    if (action === 'assign') out = planner.assign(store, weekStart, body);
    else if (action === 'move') out = planner.move(store, weekStart, body.entryId, body);
    else if (action === 'remove') out = planner.remove(store, weekStart, body.entryId);
    else if (action === 'pin') out = planner.pinFromSlot(store, weekStart, body.entryId, body.slot ?? null);
    else return send(res, 404, { error: 'No such endpoint.' });

    if (out.error === 'board full') {
      return send(res, 409, { error: 'All eight tiles are taken. Drop it on the tile you want to replace.' });
    }
    if (out.error) return send(res, 400, { error: out.error });
    // The whole week goes back on every change: the grid is small, and a client
    // that re-renders from one authoritative payload cannot drift out of step
    // with the store the way an optimistic patch eventually does.
    return send(res, 200, {
      ok: true,
      ...out,
      plan: planner.view(store, cfg, weekStart),
      favorites: favoritesPayload(),
    });
  }

  // --- conversation history, for rehydrating the page after a reload ---
  if (method === 'GET' && p === '/api/history') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 50), 500);
    return send(res, 200, {
      messages: store.recentMessages(limit).map((m) => ({
        id: m.id,
        ts: m.ts,
        role: m.role,
        text: m.text,
        loggedIds: m.loggedIds || [],
      })),
      meals: store.recentMeals(60).map(publicMeal),
    });
  }

  // --- the one daily touch (F1). The store enforces the once-a-day cap. ---
  if (method === 'POST' && (p === '/api/briefing/run' || p === '/api/checkin/run')) {
    // The v1 path still answers: it is what any existing cron entry calls, and
    // silently breaking the owner's scheduler to rename a route would be a poor
    // trade. Both routes hit the same store-enforced cap.
    const body = await readJson(req);
    try {
      const out = await briefing.run(store, cfg, { force: Boolean(body.force), dryRun: Boolean(body.dryRun) });
      return send(res, out.status === 'error' ? 502 : 200, out);
    } catch (e) {
      console.error('[briefing]', e.message);
      return send(res, 502, { status: 'error', error: e.message });
    }
  }

  return send(res, 404, { error: 'No such endpoint.' });
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  route(req, res, url).catch((e) => {
    console.error('[route]', e.message);
    if (!res.headersSent) send(res, 500, { error: e.message });
  });
});

/**
 * In-process hourly tick for the daily check-in.
 *
 * Cheap, restart-safe, and needs no root to install — and because checkin.run()
 * consults the store rather than the clock, an extra tick can never produce an
 * extra message. The store is the cap; this is only what wakes it up.
 */
// Ticks every five minutes rather than hourly, because the send time now has a
// minute in it and an hourly tick would drift 07:30 to as late as 08:29.
// Frequency is harmless: briefing.run() consults the store, so an extra tick can
// never produce an extra message.
const TICK_MS = 5 * 60 * 1000;
function startBriefingTimer() {
  if (!cfg.briefing.enabled) return;
  const tick = async () => {
    try {
      if (briefing.isDue(store, cfg)) {
        const out = await briefing.run(store, cfg);
        console.log(`[briefing] ${out.status} for ${out.date}`);
      }
    } catch (e) {
      console.error('[briefing] tick failed:', e.message);
    }
  };
  setTimeout(tick, 30 * 1000).unref?.();
  setInterval(tick, TICK_MS);
}

server.listen(cfg.port, cfg.host, () => {
  console.log(`healthcoach listening on http://${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`);
  console.log(`public: ${cfg.publicUrl}  briefing: ${cfg.briefing.time} ${cfg.briefing.timezone}`);
  startBriefingTimer();
});

module.exports = { server, store, cfg, readJson, publicMeal, normalisePath };
