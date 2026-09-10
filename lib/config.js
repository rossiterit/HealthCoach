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
    checkin: {
      hourLocal: Number(process.env.HEALTHCOACH_CHECKIN_HOUR ?? raw.checkin.hourLocal),
      enabled: process.env.HEALTHCOACH_CHECKIN_ENABLED
        ? process.env.HEALTHCOACH_CHECKIN_ENABLED !== '0'
        : raw.checkin.enabled,
    },
    coach: {
      model: process.env.HEALTHCOACH_MODEL || raw.coach.model,
      effort: process.env.HEALTHCOACH_EFFORT || raw.coach.effort,
      maxTokens: Number(process.env.HEALTHCOACH_MAX_TOKENS || raw.coach.maxTokens),
      historyTurns: Number(raw.coach.historyTurns),
    },
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
