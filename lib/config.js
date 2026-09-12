'use strict';
/**
 * config.js — non-secret runtime configuration.
 *
 * config.json carries only settings that are safe to commit: port, base path,
 * check-in hour, model choice, and the *paths* to secret files. It never carries
 * a secret value. Secrets are read at point of use by secrets.js, which is the
 * only module allowed to touch them (confidentiality floor: used, never shown).
 *
 * Every field is overridable by env var so a throwaway test instance can run on
 * a different port and a scratch data dir without editing the committed file.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function load() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

  const cfg = {
    root: ROOT,
    port: Number(process.env.HEALTHCOACH_PORT || raw.port),
    host: process.env.HEALTHCOACH_HOST || raw.host,
    basePath: raw.basePath,
    publicUrl: process.env.HEALTHCOACH_PUBLIC_URL || raw.publicUrl,
    // Relative dataDir resolves under the repo; an absolute env value wins, which
    // is how the throwaway test instance keeps its writes out of the live store.
    dataDir: path.resolve(ROOT, process.env.HEALTHCOACH_DATA_DIR || raw.dataDir),
    timezone: process.env.HEALTHCOACH_TZ || raw.timezone,
    // The single daily touch. Time AND timezone are explicit this release: the
    // send time is measured in briefing.timezone, which need not match the
    // timezone the app buckets days by (it does today, but the spec separates
    // them and a future traveller would notice if we conflated them).
    briefing: {
      enabled: process.env.HEALTHCOACH_BRIEFING_ENABLED
        ? process.env.HEALTHCOACH_BRIEFING_ENABLED !== '0'
        : raw.briefing.enabled,
      time: process.env.HEALTHCOACH_BRIEFING_TIME || raw.briefing.time,
      timezone: process.env.HEALTHCOACH_BRIEFING_TZ || raw.briefing.timezone || raw.timezone,
    },
    coach: {
      model: process.env.HEALTHCOACH_MODEL || raw.coach.model,
      effort: process.env.HEALTHCOACH_EFFORT || raw.coach.effort,
      maxTokens: Number(process.env.HEALTHCOACH_MAX_TOKENS || raw.coach.maxTokens),
      historyTurns: Number(raw.coach.historyTurns),
    },
    fitness: { outlets: raw.fitness && raw.fitness.outlets },
    nutrition: { engine: process.env.HEALTHCOACH_NUTRITION_ENGINE || raw.nutrition.engine },
    secrets: {
      anthropicKeyPath: process.env.HEALTHCOACH_ANTHROPIC_KEY_PATH || raw.secrets.anthropicKeyPath,
      telegramTokenPath: process.env.HEALTHCOACH_TELEGRAM_TOKEN_PATH || raw.secrets.telegramTokenPath,
      telegramChatIdPath: process.env.HEALTHCOACH_TELEGRAM_CHAT_ID_PATH || raw.secrets.telegramChatIdPath,
    },
  };

  return cfg;
}

module.exports = { load };
