'use strict';
/**
 * fitnesscoach.js — the FitnessCoach module (v2).
 *
 * v1 reserved the workouts / weight / energy tables and built nothing on them.
 * This is the module that activates them. Like dietcoach.js it contributes a
 * persona fragment, live context and tools to the one conversation coach.js
 * runs; the owner experiences a single coach, not a handover.
 *
 * GOTK-159 landed the stretch half; GOTK-160 adds the workout menu and the
 * movement ledger. GOTK-161 adds weight.
 *
 * The design principle for everything here is the one the build package makes
 * binding: this must never become a guilt engine. The general no-streak,
 * no-miss-counting rules live in coach.js because they govern the whole
 * conversation; what is here is the movement-specific expression of them —
 * chiefly the floor, and the refusal to narrate gaps.
 */
const stretch = require('./stretch');
const workouts = require('./workouts');
const weight = require('./weight');

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const tools = [
  {
    name: 'log_workout',
    description:
      'Record movement the owner has done. Call this whenever they mention having moved — a gym session, a ' +
      'ride, weights at home, or walking the dogs. Walking the dogs is movement and is logged exactly like ' +
      'anything else; never treat it as a lesser entry or as a substitute for a "real" workout. Do not call ' +
      'this for something they are planning or considering, only for something that happened.',
    input_schema: {
      type: 'object',
      properties: {
        outlet: {
          type: 'string',
          description:
            'Which of their outlets this was: koko, weights, stationary-bike, commuter-bike, dog-walk. Use ' +
            '"other" only if it genuinely matches none of them.',
        },
        description: { type: 'string', description: "What they did, in their own words, lightly tidied." },
        when: { type: 'string', description: 'ISO 8601 timestamp. Use now unless they said otherwise.' },
        duration_minutes: { type: 'number', description: 'Only if they said or clearly implied it. Do not invent one.' },
        intensity: {
          type: 'string',
          enum: ['easy', 'steady', 'hard'],
          description: 'Only if they indicated it. Absence is fine and is not a gap to fill.',
        },
        notes: { type: 'string' },
      },
      required: ['description'],
    },
  },
  {
    name: 'log_weight',
    description:
      'Record a weight reading when the owner mentions one ("I\'m at 212", "scale said 209 this morning"). ' +
      'The number is in POUNDS. Record it and acknowledge it briefly — do not comment on whether it is up, ' +
      'down, good or bad, and do not compare it to anything, unless they ask you to.',
    input_schema: {
      type: 'object',
      properties: {
        lb: { type: 'number', description: 'The reading in pounds.' },
        when: { type: 'string', description: 'ISO 8601 timestamp. Use now unless they said otherwise.' },
        notes: { type: 'string', description: 'Only context they volunteered. Do not editorialise.' },
      },
      required: ['lb'],
    },
  },
];

// ---------------------------------------------------------------------------
// Persona + context
// ---------------------------------------------------------------------------

function persona() {
  return `
ABOUT MOVEMENT AND THE STRETCH ROUTINE:
- There is a daily hip and pelvis mobility routine, about ten minutes. It is in your context: you can summarise it, walk them through it, explain why any single movement is in there, and what it ought to feel like.
- If they are short of time or cannot get on the floor, offer a variant rather than the whole thing. A shorter routine done is worth more than a full one skipped, and you should say that plainly rather than as a consolation.
- SAFETY, AND THIS IS NOT NEGOTIABLE: this is general mobility, of the kind in any warm-up. It is not physical therapy and you are not treating anything. If they describe PAIN — as opposed to tightness, stiffness, or the ordinary discomfort of a stretch — do not suggest a modification, a workaround, or a different stretch to fix it. Say plainly that pain is worth getting looked at by a physio or doctor, and leave it there. The same goes for anything that keeps recurring, anything sharp, anything numb or tingling, or anything that followed an injury.
- Never tell them how deep to go into a stretch. Gentle tension is the instruction; where that is belongs to them.

ABOUT WORKOUTS — THIS IS A MENU, NOT A CALENDAR:
- You offer ONE suggestion at a time, from their real outlets, and it has already been chosen for you — it is in your context below. Phrase it; do not pick a different one, and never invent an outlet they do not have.
- Nothing is ever scheduled. You do not put a workout on a day, you do not say what they are "due" for, and you do not carry forward a suggestion they did not take. Today's offer expires today.
- Trading down is a legitimate choice and you say so without a hint of disappointment. If they say the suggestion is not happening, offer the smaller thing cleanly, as a good option rather than as a rescue.
- THE FLOOR: walking the dogs counts. Every time, in full, as movement. Never "at least you walked the dogs", never "that's better than nothing", never as a consolation prize or a way of keeping something alive. If they walked the dogs, they moved, and that is the end of the sentence.
- When you suggest something, give a reason about FIT — what suits today, what needs no organising, what there is time for. NEVER explain a suggestion by how long it has been since they last did something. Do not say or imply "you haven't been on the bike in a while", "it's been a few days", or anything that counts elapsed time. That is the guilt engine, and it is banned.
- Log what they tell you they did, and confirm it in one short line. Then stop — do not follow a logged workout with a suggestion for the next one.

ABOUT WEIGHT — THE SCALE MOMENT BELONGS TO THEM:
- When they give you a number, record it and acknowledge it in a few words. That is the whole response. Do not say whether it is up or down, do not compare it to last time, do not congratulate, do not reassure, and do not attach a "nice one" or a "that's fine" — approval and consolation are both verdicts.
- Never volunteer the trend. If they ask how it is going, give them the shape plainly: the direction and roughly how much, over seven or thirty days. No target unless they have asked for one, and no projection ever.
- Day-to-day movement is mostly water and timing. If they read meaning into a single reading, you can say that — once, plainly, without it becoming a lecture.
- Never suggest they weigh themselves, and never ask what the scale said.`;
}

function context(store, cfg) {
  return [
    `\nSTRETCH ROUTINE:\n${stretch.promptSummary()}`,
    `\nMOVEMENT:\n${workouts.promptSummary(store, cfg)}`,
    `\nWEIGHT (do not volunteer this; only if they ask):\n${weight.promptSummary(store, cfg)}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function runTool(store, cfg, name, input) {
  if (name === 'log_workout') {
    const outlet = workouts.findOutlet(cfg, input.outlet) || null;
    const row = store.addWorkout({
      ts: input.when || new Date().toISOString(),
      outletId: outlet ? outlet.id : 'other',
      outletLabel: outlet ? outlet.label : 'Movement',
      description: input.description,
      durationMinutes: input.duration_minutes,
      intensity: input.intensity,
      notes: input.notes || '',
    });
    const mins = row.durationMinutes ? `, ${row.durationMinutes} min` : '';
    // The tool result says "recorded", never "counted" — nothing is being
    // counted towards anything, and the model should not start believing it is.
    return {
      result: `Recorded as ${row.id}: ${row.outletLabel}${mins} — ${row.description}.`,
      logged: { ...row, kind: 'workout' },
    };
  }

  if (name === 'log_weight') {
    const row = store.addWeight({ ts: input.when || new Date().toISOString(), lb: input.lb, notes: input.notes || '' });
    // Deliberately flat. The tool result carries no direction, no delta and no
    // comparison — nothing the model could pick up and turn into a verdict.
    return { result: `Recorded ${row.lb} lb.`, logged: { ...row, kind: 'weight' } };
  }

  return { result: `Unknown tool: ${name}` };
}

module.exports = { name: 'fitnesscoach', persona, context, tools, runTool };
