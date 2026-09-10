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
const dietcoach = require('./lib/dietcoach');
const checkin = require('./lib/checkin');
const nutrition = require('./lib/nutrition');
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
      },
      nutritionEngine: cfg.nutrition.engine,
      checkin: { enabled: cfg.checkin.enabled, hourLocal: cfg.checkin.hourLocal },
      // Presence, never the value — the confidentiality floor applies to a
      // health endpoint as much as to a log.
      telegramConfigured: telegram.configured(cfg),
    });
  }

  // --- a conversational turn (F3/F4) ---
  if (method === 'POST' && p === '/api/chat') {
    const body = await readJson(req);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) return send(res, 400, { error: 'Send a non-empty "message".' });

    try {
      const out = await dietcoach.turn(store, cfg, message);
      return send(res, 200, {
        reply: out.reply,
        logged: out.logged.map(publicMeal),
        corrected: out.corrected.map(publicMeal),
        goalsUpdated: out.goalsUpdated,
      });
    } catch (e) {
      // The message is already redacted by lib/claude.js before it gets here.
      console.error('[chat]', e.message);
      return send(res, 502, { error: e.message });
    }
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

  // --- the daily check-in (F5). The store enforces the once-a-day cap. ---
  if (method === 'POST' && p === '/api/checkin/run') {
    const body = await readJson(req);
    try {
      const out = await checkin.run(store, cfg, { force: Boolean(body.force), dryRun: Boolean(body.dryRun) });
      return send(res, out.status === 'error' ? 502 : 200, out);
    } catch (e) {
      console.error('[checkin]', e.message);
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
const HOUR = 60 * 60 * 1000;
function startCheckinTimer() {
  if (!cfg.checkin.enabled) return;
  const tick = async () => {
    try {
      if (checkin.isDue(store, cfg)) {
        const out = await checkin.run(store, cfg);
        console.log(`[checkin] ${out.status} for ${out.date}`);
      }
    } catch (e) {
      console.error('[checkin] tick failed:', e.message);
    }
  };
  setTimeout(tick, 30 * 1000).unref?.();
  setInterval(tick, HOUR);
}

server.listen(cfg.port, cfg.host, () => {
  console.log(`healthcoach listening on http://${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`);
  console.log(`public: ${cfg.publicUrl}  check-in: ${cfg.checkin.hourLocal}:00 ${cfg.timezone}`);
  startCheckinTimer();
});

module.exports = { server, store, cfg, readJson, publicMeal, normalisePath };
