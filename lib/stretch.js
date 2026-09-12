'use strict';
/**
 * stretch.js — the morning hip/pelvis mobility routine (F2, GOTK-159).
 *
 * A fixed, named routine rather than something the model invents each morning.
 * Two reasons. First, the owner should be able to learn it: the same sequence
 * every day becomes something you can do without reading, which is the whole
 * point of a ten-minute routine. Second, generated-fresh movement instructions
 * are exactly the kind of thing a language model can get subtly wrong, and this
 * is the one part of the app that touches someone's body.
 *
 * SCOPE — read this before adding anything.
 * This is general mobility content, of the kind found in any warm-up. It is NOT
 * physical therapy, it is not a rehabilitation protocol, and it is not tailored
 * to any diagnosis. The build package is explicit: if the owner reports pain, as
 * distinct from tightness, the coach points them at a professional rather than
 * working around it. That rule lives in the coach's prompt (fitnesscoach.js) and
 * is restated on the page, because a caveat only in the code is a caveat nobody
 * reads. Nothing here should ever grow into "here's how to fix your injury".
 *
 * Everything is low-load, floor-based, and stops well short of end range. The
 * cues say "to the point of gentle tension" rather than naming a stretch depth,
 * because the right depth is the owner's to find and not ours to prescribe.
 */

const SAFETY_NOTE =
  'General mobility, not physical therapy. Move to gentle tension and no further — ' +
  'none of this should hurt. If something is painful rather than tight, or a niggle ' +
  'keeps coming back, that is one for a physio rather than for me.';

/**
 * The daily routine. Durations are per side where a side is named, and the
 * total is the honest sum including the changeovers.
 */
const DAILY = {
  id: 'hip-pelvis-daily',
  title: 'Hips and pelvis — the daily ten',
  totalMinutes: 10,
  intent: 'Unstick the hips and pelvis after a night in bed, before the day sets them.',
  steps: [
    {
      name: '90/90 breathing',
      duration: '90 seconds',
      cue: 'On your back, feet on a chair or sofa, knees and hips both at right angles. Breathe out slowly and let your lower back settle towards the floor.',
      why: 'Settles the pelvis into a neutral position before you ask it to move, so the rest lands where it should.',
    },
    {
      name: 'Knee to chest',
      duration: '45 seconds each side',
      cue: 'Draw one knee towards your chest with both hands. Keep the other leg long and heavy on the floor.',
      why: 'Opens the back of the hip, and the straight leg gets a quiet hip-flexor stretch for free.',
    },
    {
      name: 'Figure four',
      duration: '45 seconds each side',
      cue: 'Ankle across the opposite thigh, then reach through and draw that thigh towards you. Keep your head and shoulders down.',
      why: 'The glute and the outside of the hip — usually the tightest thing after sitting.',
    },
    {
      name: 'Half-kneeling hip flexor',
      duration: '60 seconds each side',
      cue: 'One knee down on something soft, other foot forward. Tuck your tailbone under first, then shift forward only until you feel the front of the down-leg hip.',
      why: 'The tuck is the whole exercise. Without it you arch your back and stretch nothing.',
    },
    {
      name: 'Supine spinal twist',
      duration: '45 seconds each side',
      cue: 'Knees together, let them fall to one side, shoulders staying down. Turn your head the other way if it is comfortable.',
      why: 'Lets the lower back and the pelvis stop moving as one block.',
    },
    {
      name: 'Adductor rock',
      duration: '60 seconds',
      cue: 'On hands and knees, one leg out to the side with the foot flat. Rock your hips slowly back and forwards.',
      why: 'The inner thigh, which almost nothing else in a day reaches.',
    },
    {
      name: 'Glute bridge',
      duration: '45 seconds',
      cue: 'On your back, feet flat, push through your heels and lift your hips. Squeeze at the top, lower slowly. Ten or so, unhurried.',
      why: 'Wakes the glutes up so the hips have something driving them, not just length.',
    },
    {
      name: 'Cat-cow',
      duration: '60 seconds',
      cue: 'On hands and knees, alternate rounding and arching, slowly, following your breath.',
      why: 'Finishes by moving the whole chain together rather than leaving it in pieces.',
    },
  ],
};

/**
 * Variants the coach may offer when the owner asks for something different, or
 * says they are short of time. Each is a filter over the daily routine rather
 * than a separate invented sequence — same movements, fewer or gentler.
 */
const VARIANTS = {
  short: {
    id: 'hip-pelvis-short',
    title: 'The short one',
    totalMinutes: 5,
    intent: 'Half the time, most of the benefit, for a morning that got away from you.',
    stepNames: ['Knee to chest', 'Figure four', 'Half-kneeling hip flexor', 'Cat-cow'],
  },
  evening: {
    id: 'hip-pelvis-evening',
    title: 'Wind-down',
    totalMinutes: 8,
    intent: 'Slower and floor-based, for last thing at night rather than first thing.',
    stepNames: ['90/90 breathing', 'Knee to chest', 'Figure four', 'Supine spinal twist', 'Adductor rock'],
  },
  desk: {
    id: 'hip-pelvis-desk',
    title: 'Standing, no floor needed',
    totalMinutes: 5,
    intent: 'For a day where getting on the floor is not going to happen.',
    stepNames: ['Half-kneeling hip flexor', 'Figure four', 'Cat-cow'],
    substitutions: {
      'Half-kneeling hip flexor': 'Standing, one foot up on a chair behind you, tailbone tucked.',
      'Figure four': 'Standing, ankle across the opposite knee, sit back as if onto a stool. Hold something.',
      'Cat-cow': 'Hands on a desk, round and arch through the middle of your back.',
    },
  },
};

/** The full daily routine. */
function daily() {
  return DAILY;
}

/** A named variant, resolved into real steps. Returns null for an unknown name. */
function variant(name) {
  const v = VARIANTS[String(name || '').toLowerCase()];
  if (!v) return null;
  const steps = v.stepNames
    .map((n) => DAILY.steps.find((s) => s.name === n))
    .filter(Boolean)
    .map((s) => (v.substitutions && v.substitutions[s.name] ? { ...s, cue: v.substitutions[s.name] } : s));
  return { id: v.id, title: v.title, totalMinutes: v.totalMinutes, intent: v.intent, steps };
}

/** Names of the available variants, for the coach's context and the API. */
function variantNames() {
  return Object.keys(VARIANTS);
}

/** Look up one stretch by name, case- and punctuation-insensitively. */
function findStep(name) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(name);
  if (!target) return null;
  return (
    DAILY.steps.find((s) => norm(s.name) === target) ||
    DAILY.steps.find((s) => norm(s.name).includes(target) || target.includes(norm(s.name))) ||
    null
  );
}

/** One line for the morning briefing — never the whole routine. */
function briefingLine() {
  return `${DAILY.title} — ${DAILY.totalMinutes} minutes, ${DAILY.steps.length} movements.`;
}

/** Compact form for the coach's prompt: enough to talk about, not the full cues. */
function promptSummary() {
  const steps = DAILY.steps.map((s) => `${s.name} (${s.duration})`).join('; ');
  return [
    `Today's stretch routine — ${DAILY.title}, about ${DAILY.totalMinutes} minutes: ${steps}.`,
    `Variants you can offer if asked or if they are short of time: ${variantNames().join(', ')}.`,
    'You can explain any of these movements, why it is there, and what it should feel like.',
    SAFETY_NOTE,
  ].join(' ');
}

module.exports = { daily, variant, variantNames, findStep, briefingLine, promptSummary, SAFETY_NOTE, DAILY };
