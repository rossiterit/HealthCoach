'use strict';
/**
 * test/run.js — the offline suite.
 *
 * Covers everything that does not need the network: the shared store and its
 * restart-safety, nutrition normalisation, the coach's three store-writing
 * tools, the once-a-day check-in cap, secret redaction, and the HTTP surface
 * (booted as a real child process on a throwaway port and a throwaway data dir,
 * so the startup path itself is under test).
 *
 * What this suite CANNOT see, and what therefore still needs a live check:
 *   - anything requiring a real Claude call: the onboarding interview, meal
 *     parsing quality, coaching tone, check-in copy;
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
const dietcoach = require(path.join(ROOT, 'lib/dietcoach'));
const coach = require(path.join(ROOT, 'lib/coach'));
const stretch = require(path.join(ROOT, 'lib/stretch'));
const workouts = require(path.join(ROOT, 'lib/workouts'));
const weight = require(path.join(ROOT, 'lib/weight'));
const fitnesscoach = require(path.join(ROOT, 'lib/fitnesscoach'));
const checkin = require(path.join(ROOT, 'lib/checkin'));
const telegram = require(path.join(ROOT, 'lib/telegram'));

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
  fitness: { outlets: workouts.DEFAULT_OUTLETS },
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
// the coach's tools
// ---------------------------------------------------------------------------

async function toolTests() {
  await test('log_meal writes a meal with per-item and total nutrition', () => {
    const s = new Store(tmpDir()).load();
    const out = dietcoach.runTool(s, CFG, 'log_meal', {
      description: 'two eggs on toast',
      meal_type: 'breakfast',
      items: [
        { name: 'eggs', quantity: '2', nutrition: { calories_kcal: 140, protein_g: 12 } },
        { name: 'toast', quantity: '2 slices', nutrition: { calories_kcal: 160, protein_g: 6 } },
      ],
    });
    assert.ok(out.logged, 'the tool should report the row it wrote');
    assert.strictEqual(s.data.meals.length, 1);
    assert.strictEqual(out.logged.nutrition.calories_kcal, 300);
    assert.strictEqual(out.logged.nutrition.protein_g, 18);
    assert.strictEqual(out.logged.items.length, 2);
    assert.strictEqual(out.logged.estimate, true);
    assert.ok(out.result.includes('estimate'), 'the model must be told the figures are estimates');
  });

  await test('correct_meal revises in place and stamps the correction (F3)', () => {
    const s = new Store(tmpDir()).load();
    const first = dietcoach.runTool(s, CFG, 'log_meal', {
      description: 'large flat white',
      items: [{ name: 'flat white', nutrition: { calories_kcal: 220 } }],
    }).logged;

    const out = dietcoach.runTool(s, CFG, 'correct_meal', {
      meal_id: first.id,
      description: 'small flat white',
      items: [{ name: 'flat white', quantity: 'small', nutrition: { calories_kcal: 110 } }],
    });

    assert.strictEqual(s.data.meals.length, 1, 'a correction revises, it does not duplicate');
    assert.strictEqual(out.corrected.id, first.id);
    assert.strictEqual(out.corrected.description, 'small flat white');
    assert.strictEqual(out.corrected.nutrition.calories_kcal, 110);
    assert.ok(out.corrected.correctedAt, 'a revised row must show it was revised');
  });

  await test('correct_meal on an unknown id reports back instead of writing', () => {
    const s = new Store(tmpDir()).load();
    const out = dietcoach.runTool(s, CFG, 'correct_meal', { meal_id: 'meal_nope' });
    assert.strictEqual(s.data.meals.length, 0);
    assert.ok(/No meal with id/.test(out.result));
  });

  await test('save_goals persists the working frame', () => {
    const s = new Store(tmpDir()).load();
    const out = dietcoach.runTool(s, CFG, 'save_goals', {
      summary: 'Lose a stone by spring without giving up bread.',
      targets: { calories_kcal_per_day: 2100 },
      constraints: ['shellfish allergy'],
    });
    assert.ok(out.goals);
    assert.strictEqual(s.getGoals().targets.calories_kcal_per_day, 2100);
    assert.deepStrictEqual(s.getGoals().constraints, ['shellfish allergy']);
  });

  await test('the whole tool surface is the ratified list, and every tool writes only to the store', () => {
    // Governance. If this fails, someone added a capability that needs owner
    // change control, not a code review. v2's log_workout/log_weight were
    // ratified by the owner on 2026-09-12 as same-class store writes; the
    // frozen thing is external access (calendar, APIs) per Decision 8.
    const names = coach.allTools().map((t) => t.name).sort();
    assert.deepStrictEqual(names, ['correct_meal', 'log_meal', 'log_weight', 'log_workout', 'save_goals']);
    for (const t of coach.allTools()) {
      assert.ok(coach.ownerOf(t.name), `${t.name} must belong to a module`);
    }
  });

  await test('no tool reaches outside the app', () => {
    const forbidden = /\b(file|path|read_file|write_file|exec|shell|bash|command|http|fetch|url|calendar|email)\b/i;
    for (const t of coach.allTools()) {
      assert.ok(!forbidden.test(t.name), `tool name ${t.name} looks like external access`);
    }
  });

  await test('the system prompt carries the goals doc and the day so far', () => {
    const s = new Store(tmpDir()).load();
    s.setGoals({ summary: 'More protein, less faff.', targets: { protein_g_per_day: 130 } });
    s.addMeal({ description: 'porridge', mealType: 'breakfast', nutrition: { calories_kcal: 300 } });
    const sys = coach.buildSystem(s, CFG);
    assert.ok(sys.includes('More protein, less faff.'), 'goals must be in the frame');
    assert.ok(sys.includes('protein_g_per_day: 130'));
    assert.ok(sys.includes('porridge'), 'recent meals must be in the frame');
    assert.ok(!sys.includes('ONBOARDING INTERVIEW'), 'onboarding must not re-trigger once goals exist');
  });

  await test('with no goals doc, the prompt runs the onboarding interview (F2)', () => {
    const s = new Store(tmpDir()).load();
    const sys = coach.buildSystem(s, CFG);
    assert.ok(sys.includes('ONBOARDING INTERVIEW'), 'the first conversation must interview');
  });
}

// ---------------------------------------------------------------------------
// the stretch routine (GOTK-159)
// ---------------------------------------------------------------------------

async function stretchTests() {
  await test('the daily routine is a real ~10-minute sequence with named movements', () => {
    const r = stretch.daily();
    assert.ok(r.steps.length >= 6, 'a ten-minute routine needs more than a couple of movements');
    assert.strictEqual(r.totalMinutes, 10);
    for (const st of r.steps) {
      assert.ok(st.name && st.name.length > 2, 'every movement is named');
      assert.ok(/second|minute/.test(st.duration), `${st.name} needs a duration`);
      assert.ok(st.cue && st.cue.length > 20, `${st.name} needs a usable cue`);
    }
  });

  await test('variants are subsets of the same movements, never invented ones', () => {
    const dailyNames = new Set(stretch.daily().steps.map((s) => s.name));
    for (const name of stretch.variantNames()) {
      const v = stretch.variant(name);
      assert.ok(v, `variant ${name} should resolve`);
      assert.ok(v.steps.length, `variant ${name} should have steps`);
      for (const st of v.steps) {
        assert.ok(dailyNames.has(st.name), `variant ${name} invented a movement: ${st.name}`);
      }
      assert.ok(v.totalMinutes <= stretch.daily().totalMinutes, 'a variant should not be longer');
    }
  });

  await test('an unknown variant resolves to null rather than something made up', () => {
    assert.strictEqual(stretch.variant('nonsense'), null);
    assert.strictEqual(stretch.variant(''), null);
  });

  await test('stretches can be looked up by loose name, for "explain the figure four"', () => {
    assert.ok(stretch.findStep('figure four'));
    assert.ok(stretch.findStep('Figure-Four'));
    assert.ok(stretch.findStep('glute bridge'));
    assert.strictEqual(stretch.findStep('bench press'), null);
  });

  await test('the safety note names pain and points at a professional', () => {
    const note = stretch.SAFETY_NOTE.toLowerCase();
    assert.ok(/not physical therapy/.test(note), 'must disclaim physical therapy');
    assert.ok(/physio|professional|doctor/.test(note), 'must point somewhere real');
    assert.ok(/hurt|pain/.test(note), 'must distinguish pain from tightness');
  });

  await test('the fitness persona forbids working around pain', () => {
    const fit = require(path.join(ROOT, 'lib/fitnesscoach'));
    const persona = fit.persona().toLowerCase();
    assert.ok(/pain/.test(persona));
    assert.ok(/physio|doctor/.test(persona), 'the coach must refer pain onward');
    assert.ok(/not physical therapy/.test(persona));
  });

  await test('the briefing line is one line, not the whole routine', () => {
    const line = stretch.briefingLine();
    assert.ok(!line.includes('\n'), 'the briefing gets a line, not a list');
    assert.ok(line.length < 120);
  });
}

// ---------------------------------------------------------------------------
// the workout menu and the movement ledger (GOTK-160)
// ---------------------------------------------------------------------------

async function movementTests() {
  const mon = new Date('2026-09-14T09:00:00Z'); // a Monday
  const sat = new Date('2026-09-19T09:00:00Z'); // a Saturday

  await test('the menu is the owner\'s real outlets, and the dog walk is the floor', () => {
    const list = workouts.outlets(CFG);
    const ids = list.map((o) => o.id).sort();
    assert.deepStrictEqual(ids, ['commuter-bike', 'dog-walk', 'koko', 'stationary-bike', 'weights']);
    const floor = workouts.floorOutlet(CFG);
    assert.strictEqual(floor.id, 'dog-walk');
    assert.strictEqual(list.filter((o) => o.isFloor).length, 1, 'exactly one floor');
  });

  await test('a suggestion is always one real outlet, never invented', () => {
    const s = new Store(tmpDir()).load();
    const valid = new Set(workouts.outlets(CFG).map((o) => o.id));
    for (const now of [mon, sat]) {
      const pick = workouts.suggest(s, CFG, now);
      assert.ok(valid.has(pick.outlet.id), `suggested ${pick.outlet.id}, which is not on the menu`);
      assert.ok(pick.reason && pick.reason.length > 3);
    }
  });

  await test('the trade-down is always the floor, and the floor never trades down to itself', () => {
    const s = new Store(tmpDir()).load();
    const pick = workouts.suggest(s, CFG, mon);
    if (pick.outlet.isFloor) assert.strictEqual(pick.tradeDown, null);
    else assert.strictEqual(pick.tradeDown.id, 'dog-walk');
  });

  await test('the suggestion favours what actually gets done', () => {
    const s = new Store(tmpDir()).load();
    // Six stationary-bike sessions, none recent enough to be deprioritised.
    for (let i = 4; i < 10; i++) {
      s.addWorkout({ ts: new Date(mon.getTime() - i * 86400000).toISOString(), outletId: 'stationary-bike', outletLabel: 'Stationary bike' });
    }
    const pick = workouts.suggest(s, CFG, mon);
    assert.strictEqual(pick.outlet.id, 'stationary-bike', 'the outlet they actually use should surface');
  });

  await test('variety: something done yesterday is not suggested again today', () => {
    const s = new Store(tmpDir()).load();
    for (let i = 3; i < 9; i++) {
      s.addWorkout({ ts: new Date(mon.getTime() - i * 86400000).toISOString(), outletId: 'weights', outletLabel: 'Home free weights' });
    }
    s.addWorkout({ ts: new Date(mon.getTime() - 86400000).toISOString(), outletId: 'weights', outletLabel: 'Home free weights' });
    const pick = workouts.suggest(s, CFG, mon);
    assert.notStrictEqual(pick.outlet.id, 'weights', 'yesterday\'s outlet should step aside');
  });

  await test('no suggestion reason ever references elapsed time or a gap', () => {
    const s = new Store(tmpDir()).load();
    const banned = /\b(since|been a|haven'?t|last time|days? ago|a while|overdue|due for)\b/i;
    for (const outlet of workouts.outlets(CFG)) {
      for (const now of [mon, sat]) {
        s.addWorkout({ ts: new Date(now.getTime() - 3 * 86400000).toISOString(), outletId: outlet.id, outletLabel: outlet.label });
        const pick = workouts.suggest(s, CFG, now);
        assert.ok(!banned.test(pick.reason), `reason narrates a gap: "${pick.reason}"`);
      }
    }
  });

  await test('log_workout records the dog walk exactly like anything else', () => {
    const s = new Store(tmpDir()).load();
    const walk = fitnesscoach.runTool(s, CFG, 'log_workout', { outlet: 'dog-walk', description: 'walked the dogs round the block' });
    const gym = fitnesscoach.runTool(s, CFG, 'log_workout', { outlet: 'koko', description: 'full session', duration_minutes: 45 });
    assert.ok(walk.logged, 'the walk must produce a row');
    assert.strictEqual(walk.logged.outletId, 'dog-walk');
    assert.strictEqual(walk.logged.kind, 'workout');
    // Same shape, same table, no marker making one lesser than the other.
    assert.deepStrictEqual(Object.keys(walk.logged).sort(), Object.keys(gym.logged).sort());
    const lesser = /at least|better than nothing|only a|just a|instead of/i;
    assert.ok(!lesser.test(walk.result), `the tool result diminishes the walk: "${walk.result}"`);
  });

  await test('the ledger reports what was done and stores no streak of any kind', () => {
    const s = new Store(tmpDir()).load();
    s.addWorkout({ ts: mon.toISOString(), outletId: 'dog-walk', outletLabel: 'Walking the dogs', durationMinutes: 30 });
    s.addWorkout({ ts: mon.toISOString(), outletId: 'koko', outletLabel: 'Koko Fitness', durationMinutes: 45 });
    const sum = workouts.summary(s, CFG, 7, new Date(mon.getTime() + 3600000));
    assert.strictEqual(sum.count, 2);
    assert.strictEqual(sum.totalMinutes, 75);
    const keys = Object.keys(sum).concat(Object.keys(s.data.workouts[0]));
    for (const k of keys) {
      assert.ok(!/streak|chain|consecutive|miss/i.test(k), `the ledger must not carry a "${k}" field`);
    }
  });

  await test('an empty week says so plainly, with no reproach', () => {
    const s = new Store(tmpDir()).load();
    const line = workouts.summaryLine(s, CFG, 7, mon);
    assert.ok(/nothing recorded/i.test(line));
    assert.ok(!/should|need to|missed|behind|only/i.test(line), `reproachful empty-week line: "${line}"`);
  });

  await test('the fitness persona bans gap narration and protects the floor', () => {
    const p = fitnesscoach.persona();
    assert.ok(/walking the dogs counts/i.test(p), 'the floor must be stated');
    assert.ok(/at least you walked the dogs/i.test(p), 'the persona should name the phrasing it bans');
    assert.ok(/menu, not a calendar|MENU, NOT A CALENDAR/i.test(p));
    assert.ok(/never explain a suggestion by how long/i.test(p), 'gap narration must be banned');
  });
}

// ---------------------------------------------------------------------------
// weight — trend, never verdict (GOTK-161)
// ---------------------------------------------------------------------------

async function weightTests() {
  const now = new Date('2026-09-20T14:00:00Z');
  const seed = (vals) => {
    const s = new Store(tmpDir()).load();
    vals.forEach((lb, i) => s.addWeight({ ts: new Date(now.getTime() - (vals.length - 1 - i) * 86400000).toISOString(), lb }));
    return s;
  };

  await test('weight is stored in pounds, rounded to one decimal', () => {
    const s = new Store(tmpDir()).load();
    const row = s.addWeight({ lb: 212.44 });
    assert.strictEqual(row.lb, 212.4);
    assert.ok(!('kg' in row), 'the kg field is gone; pounds end to end');
  });

  await test('a stored reading carries no verdict, target or delta', () => {
    const s = new Store(tmpDir()).load();
    const row = s.addWeight({ lb: 212 });
    for (const k of Object.keys(row)) {
      assert.ok(!/target|goal|delta|change|verdict|status|onTrack/i.test(k), `a reading must not carry "${k}"`);
    }
  });

  await test('one reading is a reading, not a trend', () => {
    const t = weight.trend(seed([212]), CFG, 7, now);
    assert.strictEqual(t.enough, false);
    assert.strictEqual(t.direction, null);
    assert.strictEqual(t.changeLb, null);
    assert.ok(/one reading/i.test(weight.line(seed([212]), CFG, 7, now)));
  });

  await test('a falling window reads down, a rising one up — with no adjective attached', () => {
    const down = weight.trend(seed([214, 213.4, 213.8, 212.9, 212.2, 212.6, 211.8]), CFG, 7, now);
    assert.strictEqual(down.direction, 'down');
    assert.ok(down.changeLb < 0);
    const up = weight.trend(seed([208, 208.6, 209.1, 209, 209.8, 210.2, 210.6]), CFG, 7, now);
    assert.strictEqual(up.direction, 'up');
    // Neither direction may carry a valence word anywhere in the sentence.
    const valence = /good|bad|great|well done|nice|unfortunately|worry|slipping|progress|behind|on track/i;
    for (const days of [7, 30]) {
      assert.ok(!valence.test(weight.line(seed([214, 213, 212, 211]), CFG, days, now)), 'a fall must not be praised');
      assert.ok(!valence.test(weight.line(seed([208, 209, 210, 211]), CFG, days, now)), 'a rise must not be judged');
    }
  });

  await test('noise inside a quarter pound reads level, not as a direction', () => {
    const t = weight.trend(seed([212.0, 212.1, 211.9, 212.05]), CFG, 7, now);
    assert.strictEqual(t.direction, 'level');
    assert.ok(/holding around/i.test(weight.line(seed([212.0, 212.1, 211.9, 212.05]), CFG, 7, now)));
  });

  await test('the window comparison averages halves rather than diffing two points', () => {
    // A single spiky reading at the start must not be read as a big fall.
    const spiky = weight.trend(seed([218, 212, 212, 212, 212, 212]), CFG, 7, now);
    const clean = weight.trend(seed([212, 212, 212, 212, 212, 206]), CFG, 7, now);
    assert.ok(Math.abs(spiky.changeLb) < 6, 'one high reading must not become a 6 lb story');
    assert.ok(Math.abs(clean.changeLb) > 0, 'a real move should still register');
  });

  await test('the weight persona forbids congratulating, reassuring or comparing', () => {
    const p = fitnesscoach.persona().toLowerCase();
    assert.ok(/scale moment belongs to them/i.test(fitnesscoach.persona()));
    assert.ok(/do not congratulate/.test(p));
    assert.ok(/never volunteer the trend/.test(p));
    assert.ok(/approval and consolation are both verdicts/.test(p));
    assert.ok(/never suggest they weigh themselves/.test(p));
  });

  await test('logging a weight returns a flat acknowledgement with no direction in it', () => {
    const s = seed([214, 213, 212]);
    const out = fitnesscoach.runTool(s, CFG, 'log_weight', { lb: 211 });
    assert.strictEqual(out.logged.kind, 'weight');
    assert.strictEqual(out.logged.lb, 211);
    assert.ok(!/down|up|less|more|lower|higher|good|nice|progress/i.test(out.result),
      `the tool result editorialises: "${out.result}"`);
  });
}

// ---------------------------------------------------------------------------
// the no-guilt guard — the binding design principle of v2
// ---------------------------------------------------------------------------

async function noGuiltTests() {
  // Concept words only. Generic English ("only", "just") is excluded on purpose:
  // banning it would produce false failures and teach people to skip this test.
  const BANNED = [
    /\bstreaks?\b/i,
    /\bconsecutive\b/i,
    /\bin a row\b/i,
    /\bdays since\b/i,
    /\bmissed?\s+(a\s+)?(day|days|workout|session)\b/i,
    /\bkeep it going\b/i,
    /\bdon'?t break\b/i,
  ];

  await test('the coach prompt bans streaks, misses and consecutive-day counts outright', () => {
    const base = coach.BASE_PERSONA;
    assert.ok(/no streaks/i.test(base) || /there are no streaks/i.test(base), 'the ban must be explicit');
    assert.ok(/consecutive-day counts/i.test(base));
    assert.ok(/never count or refer to misses/i.test(base), 'misses must be banned, not just streaks');
    assert.ok(/every day starts fresh/i.test(base));
    assert.ok(/at least/i.test(base), 'the prompt should name the softened-shaming phrasings it bans');
  });

  await test('the page contains no streak, miss or consecutive-day language', () => {
    // Strip comments first. A JS comment saying "no streak here by design" is
    // not user-visible, and failing on it would teach us to stop explaining
    // ourselves rather than to stop shipping streaks.
    const raw = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const page = raw
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
    for (const re of BANNED) {
      assert.ok(!re.test(page), `the page must not contain ${re}`);
    }
  });

  await test('the movement prompt block narrates no gaps', () => {
    const s = new Store(tmpDir()).load();
    s.addWorkout({ ts: new Date(Date.now() - 6 * 86400000).toISOString(), outletId: 'koko', outletLabel: 'Koko Fitness' });
    const blob = workouts.promptSummary(s, CFG);
    for (const re of BANNED) assert.ok(!re.test(blob), `movement prompt contains ${re}`);
    assert.ok(!/\bsince\b|\bdays ago\b/i.test(blob), 'no elapsed-time narration');
  });

  await test('the stretch content contains none of it either', () => {
    const blob = JSON.stringify(stretch.daily()) + stretch.promptSummary() + stretch.SAFETY_NOTE;
    for (const re of BANNED) {
      assert.ok(!re.test(blob), `stretch content must not contain ${re}`);
    }
  });
}

// ---------------------------------------------------------------------------
// the daily check-in cap
// ---------------------------------------------------------------------------

async function checkinTests() {
  const realCompose = checkin.compose;
  const realSend = telegram.send;

  await test('the check-in sends once, then reports already-sent (F5 hard cap)', async () => {
    const s = new Store(tmpDir()).load();
    let sends = 0;
    checkin.compose = async () => 'You logged porridge and not much else yesterday. What does a good lunch look like this week?';
    telegram.send = async () => { sends += 1; return 4242; };

    const first = await checkin.run(s, CFG, {});
    const second = await checkin.run(s, CFG, {});
    const third = await checkin.run(s, CFG, {});

    assert.strictEqual(first.status, 'sent');
    assert.strictEqual(first.messageId, 4242);
    assert.strictEqual(second.status, 'already-sent');
    assert.strictEqual(third.status, 'already-sent');
    assert.strictEqual(sends, 1, 'never more than one check-in a day');
    assert.strictEqual(s.data.checkins.length, 1);
  });

  await test('the check-in links to the chat page', async () => {
    const s = new Store(tmpDir()).load();
    checkin.compose = async () => 'Short line.';
    telegram.send = async () => 1;
    const out = await checkin.run(s, CFG, {});
    assert.ok(out.text.includes(CFG.publicUrl), 'the ping must link back to the page');
  });

  await test('a failed send still consumes the day — a miss, never a duplicate', async () => {
    const s = new Store(tmpDir()).load();
    let sends = 0;
    checkin.compose = async () => 'Short line.';
    telegram.send = async () => { sends += 1; throw new Error('Telegram unreachable'); };

    const first = await checkin.run(s, CFG, {});
    const second = await checkin.run(s, CFG, {});

    assert.strictEqual(first.status, 'error');
    assert.strictEqual(second.status, 'already-sent', 'a failure must not licence a retry that day');
    assert.strictEqual(sends, 1);
    assert.strictEqual(s.data.checkins[0].ok, false);
  });

  await test('a dry run composes without sending or claiming the day', async () => {
    const s = new Store(tmpDir()).load();
    let sends = 0;
    checkin.compose = async () => 'Short line.';
    telegram.send = async () => { sends += 1; return 1; };

    const out = await checkin.run(s, CFG, { dryRun: true });
    assert.strictEqual(out.status, 'dry-run');
    assert.strictEqual(sends, 0);
    assert.strictEqual(s.data.checkins.length, 0, 'a rehearsal must not burn the day');
  });

  await test('an empty composition sends nothing', async () => {
    const s = new Store(tmpDir()).load();
    let sends = 0;
    checkin.compose = async () => '   ';
    telegram.send = async () => { sends += 1; return 1; };
    const out = await checkin.run(s, CFG, {});
    assert.strictEqual(out.status, 'error');
    assert.strictEqual(sends, 0);
    assert.strictEqual(s.data.checkins.length, 0);
  });

  await test('isDue respects the configured hour and the once-a-day cap', () => {
    const s = new Store(tmpDir()).load();
    const at = (h) => new Date(`2026-07-01T${String(h).padStart(2, '0')}:05:00+01:00`);
    assert.strictEqual(checkin.isDue(s, CFG, at(19)), false, 'not yet 20:00 local');
    assert.strictEqual(checkin.isDue(s, CFG, at(20)), true);
    assert.strictEqual(checkin.isDue(s, CFG, at(23)), true, 'a missed hour still fires later the same day');
    s.addCheckin(localDate(at(20), CFG.timezone), 'sent', true);
    assert.strictEqual(checkin.isDue(s, CFG, at(21)), false, 'already sent today');
  });

  checkin.compose = realCompose;
  telegram.send = realSend;
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

function post(port, p, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.end(body);
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

  // Fail loudly if something already holds the port. A leftover instance from a
  // manual run will happily answer these requests with STALE code, and the suite
  // would pass against a build that no longer exists — which has now bitten
  // twice. Better a hard stop than a green run that means nothing.
  const held = require('child_process').execSync(`ss -tlnH 2>/dev/null | grep ":${port} " || true`).toString().trim();
  if (held) {
    failures.push('port precondition');
    console.log(`FAIL port ${port} is already in use — kill the stale instance before running the suite.\n      ${held}`);
    return;
  }
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
      assert.strictEqual(typeof d.telegramConfigured, 'boolean', 'presence, not the value');
      assert.ok(!/sk-ant|bot[0-9]{6,}:/.test(r.body), 'no credential shape may appear in the payload');
    });

    await test('the chat page is served, and it is the Paper & Ink document', async () => {
      const r = await get(port, '/');
      assert.strictEqual(r.status, 200);
      assert.ok(/text\/html/.test(r.headers['content-type']));
      assert.ok(r.body.includes('--paper: #f4ece0'), 'brand tokens must be present');
      assert.ok(r.body.includes('--ink: #33291f'));
      assert.ok(r.body.includes('class="crown"'), 'the dark crown header is part of the standard');
      assert.ok(r.body.includes('DietCoach'));
    });

    await test('the page never builds markup from model output', async () => {
      // Coach replies and meal descriptions are rendered as text nodes, never
      // as HTML. If innerHTML shows up here, a reply could inject markup.
      const r = await get(port, '/');
      // Look for the sinks themselves, not the word — a comment saying "never
      // innerHTML" should not fail this, but an assignment must.
      assert.ok(!/\.innerHTML\s*=/.test(r.body), 'nothing may be assigned to innerHTML');
      assert.ok(!/insertAdjacentHTML|document\.write|\.outerHTML\s*=/.test(r.body), 'no other markup sink');
      assert.ok(r.body.includes('createTextNode'), 'text is appended as text nodes');
    });

    await test('the nginx /healthcoach/ prefix and the bare path behave identically', async () => {
      const bare = await get(port, '/api/health');
      const prefixed = await get(port, '/healthcoach/api/health');
      assert.strictEqual(prefixed.status, 200);
      assert.strictEqual(JSON.parse(bare.body).service, JSON.parse(prefixed.body).service);
      const page = await get(port, '/healthcoach/');
      assert.strictEqual(page.status, 200, 'the page must also serve under the nginx prefix');
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

    await test('POST /api/chat rejects an empty message before spending a model call', async () => {
      const r = await post(port, '/api/chat', { message: '   ' });
      assert.strictEqual(r.status, 400);
      assert.ok(JSON.parse(r.body).error);
    });

    await test('GET /api/stretch serves the routine, its variants and the safety note', async () => {
      const r = await get(port, '/api/stretch');
      assert.strictEqual(r.status, 200);
      const d = JSON.parse(r.body);
      assert.ok(d.routine.steps.length >= 6);
      assert.ok(d.variants.length >= 1);
      assert.ok(/not physical therapy/i.test(d.safetyNote), 'the API must carry the caveat too');
    });

    await test('a stretch variant is served, and an unknown one 404s', async () => {
      const short = JSON.parse((await get(port, '/api/stretch?variant=short')).body);
      assert.ok(short.routine.steps.length < 8, 'the short variant should be shorter');
      const bad = await get(port, '/api/stretch?variant=nonsense');
      assert.strictEqual(bad.status, 404);
    });

    await test('the page carries Chat and Stretch tabs, with Chat selected', async () => {
      const page = (await get(port, '/')).body;
      assert.ok(page.includes('id="tab-chat"'));
      assert.ok(page.includes('id="tab-stretch"'));
      assert.ok(/id="tab-chat"[^>]*aria-selected="true"/.test(page), 'chat is the default view');
      assert.ok(page.includes('id="view-stretch"'));
    });

    await test('GET /api/movement reports what was done, and sends no streak fields', async () => {
      const r = await get(port, '/api/movement');
      assert.strictEqual(r.status, 200);
      const d = JSON.parse(r.body);
      assert.strictEqual(d.week.count, 0);
      assert.ok(d.suggestion.outlet.id, 'a suggestion is always offered');
      assert.ok(d.outlets.some((o) => o.isFloor), 'the floor is on the menu');
      assert.ok(!/streak|consecutive|"?miss|daysActive/i.test(r.body), 'the payload must carry no streak concept');
    });

    await test('the page carries the Trend tab', async () => {
      const page = (await get(port, '/')).body;
      assert.ok(page.includes('id="tab-trend"'));
      assert.ok(page.includes('id="view-trend"'));
    });

    await test('GET /api/weight is trend-only, with no target or verdict in the payload', async () => {
      const r = await get(port, '/api/weight');
      assert.strictEqual(r.status, 200);
      const d = JSON.parse(r.body);
      assert.strictEqual(d.unit, 'lb');
      assert.ok('week' in d && 'month' in d, 'both windows');
      assert.ok(!/target|goal|onTrack|verdict|ideal/i.test(r.body), 'no target concept may reach the page');
    });

    await test('the trend view renders in plain ink, never red-for-bad', async () => {
      const page = (await get(port, '/')).body;
      const sparkCss = (page.match(/\.spark[^{]*\{[^}]*\}/g) || []).join(' ');
      assert.ok(sparkCss.length, 'the sparkline should have styles');
      assert.ok(!/red|green|#[0-9a-f]*(00ff00|ff0000)/i.test(sparkCss), 'no valence colour on the trend line');
      assert.ok(/var\(--ink\)/.test(sparkCss), 'the line is drawn in plain ink');
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
  await toolTests();
  await stretchTests();
  await movementTests();
  await weightTests();
  await noGuiltTests();
  await checkinTests();
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
