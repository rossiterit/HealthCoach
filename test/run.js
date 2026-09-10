'use strict';
/**
 * test/run.js — the offline suite.
 *
 * Covers everything that does not need the network: the shared store and its
 * restart-safety, nutrition normalisation, secret redaction, and the HTTP surface
 * (booted as a real child process on a throwaway port and a throwaway data dir,
 * so the startup path itself is under test).
 *
 * What this suite CANNOT see, and what therefore still needs a live check:
 *   - anything requiring a real Claude call;
 *   - a real Telegram delivery;
 *   - how any of it looks. Visual placement is owner click-through only.
 * A green run here is a floor, not an acceptance.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { Store, localDate } = require(path.join(ROOT, 'lib/store'));
const nutrition = require(path.join(ROOT, 'lib/nutrition'));
const secrets = require(path.join(ROOT, 'lib/secrets'));

let passed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('PASS ' + name); })
    .catch((e) => { failures.push(name); console.log('FAIL ' + name + '\n      ' + (e && e.message)); });
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'healthcoach-test-'));
}

const CFG = {
  timezone: 'Europe/London',
  nutrition: { engine: 'estimate' },
  checkin: { enabled: true, hourLocal: 20 },
  publicUrl: 'https://example.invalid/healthcoach/',
  secrets: {},
};

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

async function storeTests() {
  await test('a fresh store carries the FitnessCoach arrays, empty (F6)', () => {
    const s = new Store(tmpDir()).load();
    for (const k of ['meals', 'workouts', 'weight', 'energy', 'messages', 'checkins']) {
      assert.ok(Array.isArray(s.data[k]), `${k} should be an array`);
    }
    assert.deepStrictEqual(s.data.workouts, []);
    assert.deepStrictEqual(s.data.weight, []);
    assert.deepStrictEqual(s.data.energy, []);
    assert.strictEqual(s.data.goals, null);
  });

  await test('goals, meals and history survive a restart (acceptance item)', async () => {
    const dir = tmpDir();
    const a = new Store(dir).load();
    a.setGoals({ summary: 'Eat more protein, keep it simple.', targets: { protein_g_per_day: 130 } });
    a.addMeal({ description: 'porridge', mealType: 'breakfast', nutrition: { calories_kcal: 300 } });
    a.addMessage('user', 'morning');
    await a.save();

    const b = new Store(dir).load(); // simulate systemctl restart
    assert.strictEqual(b.getGoals().summary, 'Eat more protein, keep it simple.');
    assert.strictEqual(b.getGoals().targets.protein_g_per_day, 130);
    assert.strictEqual(b.data.meals.length, 1);
    assert.strictEqual(b.data.meals[0].description, 'porridge');
    assert.strictEqual(b.data.messages.length, 1);
  });

  await test('rewriting the goals doc bumps the revision and keeps createdAt', () => {
    const s = new Store(tmpDir()).load();
    const v1 = s.setGoals({ summary: 'first' });
    const v2 = s.setGoals({ summary: 'second' });
    assert.strictEqual(v1.revision, 1);
    assert.strictEqual(v2.revision, 2);
    assert.strictEqual(v2.createdAt, v1.createdAt);
    assert.notStrictEqual(v2.summary, v1.summary);
  });

  await test('a store written by an older build gains new arrays without a migration', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ schemaVersion: 0, meals: [{ id: 'meal_x' }] }));
    const s = new Store(dir).load();
    assert.strictEqual(s.data.meals.length, 1);
    assert.deepStrictEqual(s.data.energy, []);
    assert.strictEqual(s.data.schemaVersion, 1);
  });

  await test('localDate follows the owner wall clock, not UTC', () => {
    // 00:30 UTC on 1 July is still 01:30 on 1 July in London (BST) — same date;
    // 23:30 UTC on 30 June is 00:30 on 1 July in London — the date rolls.
    assert.strictEqual(localDate('2026-07-01T00:30:00Z', 'Europe/London'), '2026-07-01');
    assert.strictEqual(localDate('2026-06-30T23:30:00Z', 'Europe/London'), '2026-07-01');
  });

  await test('mealsOnDate buckets by local date', () => {
    const s = new Store(tmpDir()).load();
    s.addMeal({ ts: '2026-06-30T23:30:00Z', description: 'late snack' });
    s.addMeal({ ts: '2026-07-01T12:00:00Z', description: 'lunch' });
    const day = s.mealsOnDate('2026-07-01', 'Europe/London');
    assert.strictEqual(day.length, 2, 'the 23:30 UTC entry falls on 1 July in London');
  });
}

// ---------------------------------------------------------------------------
// nutrition
// ---------------------------------------------------------------------------

async function nutritionTests() {
  await test('unknown nutrition fields normalise to null, not zero', () => {
    const n = nutrition.normalise({ calories_kcal: 250 });
    assert.strictEqual(n.calories_kcal, 250);
    assert.strictEqual(n.protein_g, null, 'an unstated macro must not read as zero');
    assert.strictEqual(n.ultra_processed, null);
  });

  await test('totals skip unknowns and stay null when nothing is known', () => {
    const items = [
      { nutrition: { calories_kcal: 200, protein_g: 10 } },
      { nutrition: { calories_kcal: 150 } },
    ];
    const t = nutrition.total(items);
    assert.strictEqual(t.calories_kcal, 350);
    assert.strictEqual(t.protein_g, 10);
    assert.strictEqual(t.fat_g, null);
  });

  await test('a meal is ultra-processed if any item is', () => {
    assert.strictEqual(nutrition.total([{ nutrition: { ultra_processed: false } }, { nutrition: { ultra_processed: true } }]).ultra_processed, true);
    assert.strictEqual(nutrition.total([{ nutrition: {} }]).ultra_processed, null);
  });

  await test('every v1 entry is stamped as an estimate, whatever the model claimed', () => {
    const built = nutrition.build([{ name: 'toast', nutrition: { calories_kcal: 120 } }], 'estimate');
    assert.strictEqual(built.estimate, true);
    assert.strictEqual(built.source, 'claude-estimate');
    assert.strictEqual(nutrition.provenanceLabel(built.source), 'estimated');
  });
}

// ---------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------

async function secretTests() {
  await test('redact removes every occurrence of a secret', () => {
    const out = secrets.redact('failed calling /bot123:ABC/send and /bot123:ABC/get', '123:ABC');
    assert.ok(!out.includes('123:ABC'), 'the secret must not survive redaction');
    assert.strictEqual(out, 'failed calling /bot<redacted>/send and /bot<redacted>/get');
  });

  await test('redact is a no-op without a secret, and safe on null', () => {
    assert.strictEqual(secrets.redact('plain text', null), 'plain text');
    assert.strictEqual(secrets.redact(null, 'x'), null);
  });

  await test('a missing credential file fails closed rather than throwing', () => {
    assert.strictEqual(secrets.readSecret('/nonexistent/definitely/not/here.txt'), null);
    assert.strictEqual(secrets.have('/nonexistent/definitely/not/here.txt'), false);
  });
}

// ---------------------------------------------------------------------------
// the HTTP surface (booted for real, on a throwaway port and data dir)
// ---------------------------------------------------------------------------

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    }).on('error', reject);
  });
}

async function waitForBoot(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await get(port, '/api/health');
      if (r.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the test instance never came up');
}

async function serverTests() {
  const port = 8899; // throwaway; never the live port
  const dir = tmpDir();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      HEALTHCOACH_PORT: String(port),
      HEALTHCOACH_DATA_DIR: dir,
      HEALTHCOACH_CHECKIN_ENABLED: '0', // a test run must never ping the owner
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));

  try {
    await waitForBoot(port);

    await test('GET /api/health reports the service and never a secret value', async () => {
      const r = await get(port, '/api/health');
      const d = JSON.parse(r.body);
      assert.strictEqual(d.ok, true);
      assert.strictEqual(d.service, 'healthcoach');
      assert.strictEqual(d.onboarded, false);
      assert.ok(!/sk-ant|bot[0-9]{6,}:/.test(r.body), 'no credential shape may appear in the payload');
    });

    await test('the nginx /healthcoach/ prefix and the bare path behave identically', async () => {
      const bare = await get(port, '/api/health');
      const prefixed = await get(port, '/healthcoach/api/health');
      assert.strictEqual(prefixed.status, 200);
      assert.strictEqual(JSON.parse(bare.body).service, JSON.parse(prefixed.body).service);
    });

    await test('the internal API exposes goals, meals, summary and history (F7)', async () => {
      for (const p of ['/api/goals', '/api/meals', '/api/summary', '/api/history']) {
        const r = await get(port, p);
        assert.strictEqual(r.status, 200, `${p} should answer`);
        JSON.parse(r.body); // must be valid JSON
      }
      const sum = JSON.parse((await get(port, '/api/summary')).body);
      assert.strictEqual(sum.count, 0);
      assert.strictEqual(sum.estimate, true, 'the API must state that figures are estimates');
    });

    await test('an unknown endpoint 404s as JSON', async () => {
      const r = await get(port, '/api/nope');
      assert.strictEqual(r.status, 404);
      assert.ok(JSON.parse(r.body).error);
    });

    await test('the service binds loopback only — nginx is the gate', async () => {
      // Read the Local Address column specifically. Every `ss` line ends with a
      // peer address of 0.0.0.0:* , so a whole-line match for that is meaningless.
      const raw = require('child_process').execSync(`ss -tlnH 2>/dev/null | grep ":${port} " || true`).toString();
      const locals = raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.trim().split(/\s+/)[3]); // State Recv-Q Send-Q Local:Port
      assert.ok(locals.length, 'the test instance should be listening');
      for (const addr of locals) {
        assert.ok(
          addr.startsWith('127.0.0.1:'),
          `must listen on loopback only; found ${addr}`
        );
      }
    });
  } finally {
    child.kill('SIGTERM');
    if (stderr.trim()) console.log('      [test instance stderr] ' + stderr.trim().split('\n')[0]);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  await storeTests();
  await nutritionTests();
  await secretTests();
  await serverTests();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('failed: ' + failures.join(', '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
