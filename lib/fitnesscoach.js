'use strict';
/**
 * fitnesscoach.js — the FitnessCoach module (v2).
 *
 * v1 reserved the workouts / weight / energy tables and built nothing on them.
 * This is the module that activates them. Like dietcoach.js it contributes a
 * persona fragment, live context and tools to the one conversation coach.js
 * runs; the owner experiences a single coach, not a handover.
 *
 * GOTK-159 lands the stretch half. The workout menu and movement ledger
 * (GOTK-160) and weight logging (GOTK-161) extend this file.
 *
 * The design principle for everything here is the one the build package makes
 * binding: this must never become a guilt engine. The general no-streak,
 * no-miss-counting rules live in coach.js because they apply to the whole
 * conversation; what is here is the movement-specific expression of them.
 */
const stretch = require('./stretch');

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// GOTK-160 and GOTK-161 register log_workout and log_weight here.
const tools = [];

// ---------------------------------------------------------------------------
// Persona + context
// ---------------------------------------------------------------------------

function persona() {
  return `
ABOUT MOVEMENT AND THE STRETCH ROUTINE:
- There is a daily hip and pelvis mobility routine, about ten minutes. It is in your context: you can summarise it, walk them through it, explain why any single movement is in there, and what it ought to feel like.
- If they are short of time or cannot get on the floor, offer a variant rather than the whole thing. A shorter routine done is worth more than a full one skipped, and you should say that plainly rather than as a consolation.
- SAFETY, AND THIS IS NOT NEGOTIABLE: this is general mobility, of the kind in any warm-up. It is not physical therapy and you are not treating anything. If they describe PAIN — as opposed to tightness, stiffness, or the ordinary discomfort of a stretch — do not suggest a modification, a workaround, or a different stretch to fix it. Say plainly that pain is worth getting looked at by a physio or doctor, and leave it there. The same goes for anything that keeps recurring, anything sharp, anything numb or tingling, or anything that followed an injury.
- Never tell them how deep to go into a stretch. Gentle tension is the instruction; where that is belongs to them.`;
}

function context() {
  return `\nSTRETCH ROUTINE:\n${stretch.promptSummary()}`;
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function runTool(store, cfg, name) {
  return { result: `Unknown tool: ${name}` };
}

module.exports = { name: 'fitnesscoach', persona, context, tools, runTool };
