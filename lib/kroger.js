'use strict';
/**
 * kroger.js — the Kroger (King Soopers) cart handoff (v3 F5, GOTK-168).
 *
 * THIS IS THE ONLY CODE IN THE APP THAT TALKS TO THE OUTSIDE WORLD.
 * Decision 8 grants exactly three Kroger public-API calls and nothing else:
 *
 *   Locations  GET  /v1/locations   find the owner's King Soopers
 *   Products   GET  /v1/products    match a list line to a real product
 *   Cart add   PUT  /v1/cart/add    put matched items in the owner's cart
 *
 * Everything about this module is built so that the grant cannot quietly widen:
 *
 * ADD-ONLY, STRUCTURALLY. There is no cart read, no cart removal, no checkout —
 * not because we choose not to call them, but because Kroger's public API has
 * no such endpoints and this module has no function that could reach one. The
 * request path for cart work is a single hard-coded string. Purchase always
 * completes by hand in the owner's Kroger app.
 *
 * ON REQUEST ONLY. Nothing here is scheduled and nothing polls. Products search
 * runs when the owner creates, rebuilds or hand-adds to the shopping list
 * (Decision 11, GOTK-181) and Cart add only on their explicit Send — from the
 * review screen or by asking in chat. The briefing composer runs with no tools
 * at all, so the one unprompted message of the day structurally cannot reach
 * this file. Search needs only the app's credentials; the owner's link is used
 * for the cart and nothing else.
 *
 * GROCERY LINE ITEMS ONLY. What leaves the box is: a search term, a location
 * id, a UPC, and a quantity. `outboundTerm()` is the single chokepoint every
 * search term passes through, and a test asserts that no meal description,
 * goal, weight, note or message field can reach a request.
 *
 * FAIL CLOSED, ALWAYS. Missing credential, missing store, expired token, HTTP
 * error, malformed response — every one of them returns a reason and the caller
 * falls back to the plain list. There is no path where a failure here silently
 * looks like success, and no error string carries a credential: everything
 * outward-facing goes through redact().
 *
 * Credentials: client id and secret are root-only files named in config
 * (per-secret paths, the app's existing convention). The OAuth refresh token is
 * the one credential this app WRITES, so it lives in the service-writable data
 * directory at 0600 — gitignored, never in the repo, never in an error string.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const secrets = require('./secrets');
const { STATUS_TEXT } = require('./shopterms');

const API = 'https://api.kroger.com/v1';

/** The three granted endpoints. Hard-coded so the grant cannot widen by string-building. */
const ENDPOINTS = {
  token: `${API}/connect/oauth2/token`,
  authorize: `${API}/connect/oauth2/authorize`,
  locations: `${API}/locations`,
  products: `${API}/products`,
  cartAdd: `${API}/cart/add`,
};

/** Cart writes need the owner's authorisation; product/location lookups do not. */
const SCOPE_CART = 'cart.basic:write';
const SCOPE_PRODUCT = 'product.compact';

const TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

function clientId(cfg) {
  return secrets.readSecret(cfg.secrets.krogerClientIdPath);
}
function clientSecret(cfg) {
  return secrets.readSecret(cfg.secrets.krogerClientSecretPath);
}

/**
 * Scrub anything credential-shaped out of a string bound for a log, an error,
 * or the chat page. Belt and braces over "don't put it there in the first
 * place": the Basic header, both client halves, and either token are removed.
 */
function scrub(str, cfg) {
  let s = String(str === null || str === undefined ? '' : str);
  for (const v of [clientId(cfg), clientSecret(cfg), readRefreshToken(cfg)]) {
    if (v) s = secrets.redact(s, v);
  }
  // Catch a bearer/basic header that reached a message some other way.
  return s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>');
}

/** Present and readable? Says nothing about the values. */
function configured(cfg) {
  return Boolean(clientId(cfg) && clientSecret(cfg));
}

/**
 * Why the handoff is unavailable, in words safe to show the owner — or null if
 * it is available. Distinguishes "the owner has not finished setting this up"
 * from "it is broken", because those need different things from them.
 */
function unavailableReason(cfg) {
  if (!cfg.kroger || cfg.kroger.enabled === false) return 'The Kroger handoff is switched off in config.';
  if (!clientId(cfg) || !clientSecret(cfg)) {
    // Deliberately does not name the path: the reason is shown to the owner and
    // may pass through the model. They know where they put them.
    return 'I do not have Kroger credentials I can read, so I cannot reach your cart.';
  }
  if (!cfg.kroger.locationId) return 'No King Soopers store is set yet, so I do not know which shop to price against.';
  if (!readRefreshToken(cfg)) return 'HealthCoach is not linked to your Kroger account yet.';
  return null;
}

// ---------------------------------------------------------------------------
// the refresh token — the one credential this app writes
// ---------------------------------------------------------------------------

function refreshTokenPath(cfg) {
  return cfg.secrets.krogerRefreshTokenPath;
}

function readRefreshToken(cfg) {
  const p = refreshTokenPath(cfg);
  return p ? secrets.readSecret(p) : null;
}

/** Persist at 0600 in the service-writable data dir. Never logged, never echoed. */
function writeRefreshToken(cfg, token) {
  const p = refreshTokenPath(cfg);
  if (!p || !token) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
    fs.renameSync(tmp, p);
    return true;
  } catch {
    return false; // fail closed; the caller reports "could not link", not a path
  }
}

/** Unlink the account. Used by the owner, and by a refresh that is rejected. */
function clearRefreshToken(cfg) {
  try {
    fs.unlinkSync(refreshTokenPath(cfg));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function request(cfg, url, { method = 'GET', headers = {}, body = null } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (cfg.kroger && cfg.kroger.timeoutMs) || TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    // Network/abort errors can echo the URL, which for the token endpoint has
    // carried an Authorization header in some client stacks. Scrub regardless.
    const code = (e && e.name === 'AbortError') ? 'timeout' : (e && e.cause && e.cause.code) || (e && e.name) || 'error';
    return { ok: false, status: 0, text: '', error: scrub(e.message, cfg), code: String(code).slice(0, 40) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The three ways a Kroger call can fail, as the owner should hear them
 * (Decision 11e). They are kept apart on purpose: the 2026-09-27 send said
 * "could not match anything" when every search had been refused, and an
 * error that reads as "no matches" sends the owner hunting for a list problem
 * that does not exist.
 */
const FAILURES = {
  no_response: STATUS_TEXT.no_response,
  signin: STATUS_TEXT.signin,
  no_match: STATUS_TEXT.no_match,
};

/** Which of the three an HTTP status means. Status 0 is no answer at all. */
function failureKind(status) {
  if (status === 401 || status === 403) return 'signin';
  // The token endpoint answers a bad client or a dead refresh token with 400.
  if (status === 400) return 'signin';
  return 'no_response';
}

function basicAuth(cfg) {
  return 'Basic ' + Buffer.from(`${clientId(cfg)}:${clientSecret(cfg)}`).toString('base64');
}

async function postToken(cfg, params) {
  const res = await request(cfg, ENDPOINTS.token, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(cfg),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    return { error: `Kroger refused the token request (HTTP ${res.status}).`, status: res.status, code: res.code, kind: failureKind(res.status) };
  }
  try {
    const json = JSON.parse(res.text);
    if (!json.access_token) return { error: 'Kroger returned no access token.' };
    return json;
  } catch {
    return { error: 'Kroger returned a token response I could not read.' };
  }
}

/** App-level token for Products and Locations. No owner authorisation needed. */
async function appToken(cfg) {
  if (!configured(cfg)) return { error: unavailableReason(cfg) };
  return postToken(cfg, { grant_type: 'client_credentials', scope: SCOPE_PRODUCT });
}

/**
 * Owner-level token for the cart, from the stored refresh token.
 *
 * Kroger rotates the refresh token on use, so a new one is persisted each time.
 * If Kroger rejects the refresh outright the stored token is cleared: a dead
 * token that stays on disk makes every later attempt fail with a confusing
 * error instead of the honest "you need to link your account again".
 */
async function ownerToken(cfg) {
  if (!configured(cfg)) return { error: unavailableReason(cfg) };
  const refresh = readRefreshToken(cfg);
  if (!refresh) return { error: 'HealthCoach is not linked to your Kroger account yet.' };

  const out = await postToken(cfg, { grant_type: 'refresh_token', refresh_token: refresh });
  if (out.error) {
    // Only a refusal means the link is dead. A timeout or an outage says
    // nothing about the token, and clearing it then would unlink the account
    // because Kroger was slow for a moment (GOTK-181).
    if (out.kind === 'signin') clearRefreshToken(cfg);
    return { error: out.error, kind: out.kind };
  }
  if (out.refresh_token) writeRefreshToken(cfg, out.refresh_token);
  return out;
}

// ---------------------------------------------------------------------------
// the one-time owner authorisation
// ---------------------------------------------------------------------------

// Short-lived CSRF state. One owner, one box: an in-memory map is right, and
// losing it on restart only means re-clicking the link.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function newState() {
  const s = crypto.randomBytes(24).toString('hex');
  pendingStates.set(s, Date.now() + STATE_TTL_MS);
  for (const [k, exp] of pendingStates) if (exp < Date.now()) pendingStates.delete(k);
  return s;
}

function consumeState(s) {
  if (!s || !pendingStates.has(s)) return false;
  const exp = pendingStates.get(s);
  pendingStates.delete(s);
  return exp >= Date.now();
}

/** Where to send the owner to link their Kroger account. Null if unconfigured. */
function authorizeUrl(cfg) {
  if (!configured(cfg)) return null;
  const u = new URL(ENDPOINTS.authorize);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId(cfg));
  u.searchParams.set('redirect_uri', cfg.kroger.redirectUri);
  u.searchParams.set('scope', SCOPE_CART);
  u.searchParams.set('state', newState());
  return u.toString();
}

/** Finish the handshake. Returns {ok} or {error} — never the token itself. */
async function completeAuthorization(cfg, code, state) {
  if (!configured(cfg)) return { error: unavailableReason(cfg) };
  if (!consumeState(state)) return { error: 'That authorisation link has expired. Start again.' };
  if (!code) return { error: 'Kroger did not send an authorisation code back.' };

  const out = await postToken(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.kroger.redirectUri,
  });
  if (out.error) return { error: out.error };
  if (!out.refresh_token) return { error: 'Kroger did not return a refresh token.' };
  if (!writeRefreshToken(cfg, out.refresh_token)) return { error: 'I could not save the Kroger link.' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// the outbound chokepoint
// ---------------------------------------------------------------------------

/**
 * The ONLY way a string becomes a Kroger search term.
 *
 * Decision 8: grocery line items only — no health, log, goal or personal data
 * leaves the app. This is where that is enforced rather than promised. A term
 * is a short shopping-list phrase; anything longer is truncated, control
 * characters go, and a value that does not look like a grocery line is
 * rejected outright so it cannot be smuggled through as a "search".
 */
function outboundTerm(raw) {
  const original = String(raw === null || raw === undefined ? '' : raw);

  // Checked on the RAW value, before whitespace is normalised: a line break
  // means several lines have been pasted in, and a list line has none.
  if (/[\n\r]/.test(original)) return null;

  const s = original
    .replace(/[ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  // A grocery line is a short phrase — "porridge oats", "salmon fillets",
  // "Simple Truth rolled oats 18 oz". Prose is what must never leave, and a
  // length cap alone does not catch it: the owner's goals summary is a
  // perfectly ordinary 56-character sentence. So sentence-shaped values are
  // rejected on their punctuation and their word count, not just their size.
  if (s.length > 60) return null;
  if (s.split(' ').length > 8) return null;
  // A colon or a middot means structure, not a shelf item: this is the exact
  // shape of the planner's own "Breakfast: Porridge · Lunch: Soup" line, which
  // is the most plausible thing to be passed in here by mistake.
  if (/[;?!:·|]/.test(s)) return null;
  if (/\.\s/.test(s) || /\.$/.test(s)) return null; // a full stop means a sentence
  if (/\b(I|my|me|we|you|they|because|should|feel|felt|weigh|weighs|weighed)\b/i.test(s)) return null;
  return s;
}

// ---------------------------------------------------------------------------
// the three granted calls
// ---------------------------------------------------------------------------

/** King Soopers near a zip, so the owner can set a location id once. */
async function findLocations(cfg, zip) {
  const tok = await appToken(cfg);
  if (tok.error) return { error: tok.error };
  const z = String(zip || '').replace(/[^0-9]/g, '').slice(0, 5);
  if (z.length !== 5) return { error: 'I need a five-digit zip code to find your store.' };

  const u = new URL(ENDPOINTS.locations);
  u.searchParams.set('filter.zipCode.near', z);
  u.searchParams.set('filter.chain', 'KINGSOOPERS');
  u.searchParams.set('filter.limit', '10');

  const res = await request(cfg, u.toString(), { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!res.ok) return { error: `Kroger's store lookup failed (HTTP ${res.status}).` };
  try {
    const json = JSON.parse(res.text);
    return {
      locations: (json.data || []).map((l) => ({
        locationId: l.locationId,
        name: l.name,
        address: l.address ? `${l.address.addressLine1}, ${l.address.city} ${l.address.state} ${l.address.zipCode}` : '',
      })),
    };
  } catch {
    return { error: 'I could not read the store list Kroger sent back.' };
  }
}

/**
 * Why a product SEARCH cannot run, or null. Searching needs the app's own
 * credentials and a store — not the owner's link, which only the cart needs.
 */
function searchUnavailableReason(cfg) {
  if (!cfg.kroger || cfg.kroger.enabled === false) return 'The Kroger handoff is switched off in config.';
  if (!clientId(cfg) || !clientSecret(cfg)) return 'I do not have Kroger credentials I can read, so I cannot reach your cart.';
  if (!cfg.kroger.locationId) return 'No King Soopers store is set yet, so I do not know which shop to price against.';
  return null;
}

/** Candidates kept per line, so the owner can pick a different match. */
const CANDIDATES = 5;

/**
 * Search the configured store for one shopping term. Read-only.
 *
 * What leaves the box is the cleaned term and the store id, nothing else.
 * What comes back is DATA: product descriptions are shown to the owner as
 * text and are never handed to the model or followed as instructions. Price
 * is not kept — it is not needed to shop, and storing it would put a figure
 * in the health store that nothing asked for.
 *
 * Returns { candidates: [...] } (best first) or { kind } — one of FAILURES.
 * An answer with no products is 'no_match'; a refusal or a silence never is.
 */
async function searchProducts(cfg, accessToken, term) {
  const clean = outboundTerm(term);
  if (!clean) return { kind: 'no_match' };

  const u = new URL(ENDPOINTS.products);
  u.searchParams.set('filter.term', clean);
  u.searchParams.set('filter.locationId', String(cfg.kroger.locationId));
  u.searchParams.set('filter.limit', String(CANDIDATES));

  const get = () => request(cfg, u.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  let res = await get();
  // One retry for a blip (no answer, rate limit, server error) before saying
  // "didn't respond". A refusal is not retried: it will not change.
  if (res.status === 0 || res.status === 429 || res.status >= 500) res = await get();
  // Kroger answers a term it will not search (too short, odd characters)
  // with 400: that is "no match for this item", not an outage.
  if (res.status === 400) return { kind: 'no_match' };
  if (!res.ok) return { kind: failureKind(res.status), status: res.status || res.code };

  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { kind: 'no_response' };
  }
  const candidates = (Array.isArray(json.data) ? json.data : [])
    .filter((d) => d && d.upc)
    .slice(0, CANDIDATES)
    .map((d) => {
      const item = (d.items || [])[0] || {};
      return {
        upc: String(d.upc).slice(0, 20),
        description: String(d.description || '').slice(0, 120),
        brand: d.brand ? String(d.brand).slice(0, 60) : null,
        size: item.size ? String(item.size).slice(0, 40) : null,
      };
    });
  if (!candidates.length) return { kind: 'no_match' };
  return { candidates };
}

const SEARCH_CONCURRENCY = 4;

/**
 * Match a set of shopping terms at the configured store (Decision 11).
 *
 * Called ONLY when the owner creates or rebuilds the list or adds an item by
 * hand — `reason` says which, and every call is logged with it so "no search
 * on page load, grid edits, schedule or briefing" can be checked in the
 * journal rather than taken on trust.
 *
 * One app token for the whole batch. If that token cannot be had, every term
 * gets the same honest failure rather than a column of "no match".
 *
 * Returns a Map of term -> { candidates } | { kind }.
 */
async function matchTerms(cfg, terms, { reason } = {}) {
  const unique = [...new Set((terms || []).filter(Boolean))];
  const out = new Map();
  if (!unique.length) return out;

  const why = searchUnavailableReason(cfg);
  if (why) {
    for (const t of unique) out.set(t, { kind: 'no_response', unavailable: why });
    return out;
  }

  console.log(`[kroger] products search: ${reason || 'unspecified'}, ${unique.length} term(s), store ${cfg.kroger.locationId}`);
  const tok = await appToken(cfg);
  if (tok.error) {
    const kind = tok.kind || 'no_response';
    console.log(`[kroger] products search: no app token (${FAILURES[kind]}; HTTP ${tok.status || tok.code || 0})`);
    for (const t of unique) out.set(t, { kind });
    return out;
  }

  // If Kroger stops answering part-way, stop asking: three silences in a row
  // and the rest are marked "didn't respond" at once, rather than the owner
  // watching a spinner while every remaining term waits out its timeout.
  let next = 0;
  let silentRun = 0;
  const worker = async () => {
    while (next < unique.length) {
      const term = unique[next];
      next += 1;
      if (silentRun >= 3) { out.set(term, { kind: 'no_response', status: 'skipped' }); continue; }
      const r = await searchProducts(cfg, tok.access_token, term);
      silentRun = r.kind === 'no_response' ? silentRun + 1 : 0;
      out.set(term, r);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, unique.length) }, worker));
  // Counts and HTTP statuses only — never the terms, never a token.
  const counts = {};
  const statuses = {};
  for (const r of out.values()) {
    const k = r.kind || 'matched';
    counts[k] = (counts[k] || 0) + 1;
    if (r.status !== undefined) statuses[r.status] = (statuses[r.status] || 0) + 1;
  }
  console.log(`[kroger] products search done: ${JSON.stringify(counts)}${Object.keys(statuses).length ? ` statuses ${JSON.stringify(statuses)}` : ''}`);
  return out;
}

/**
 * Add matched items to the owner's cart. PUT /v1/cart/add, add-only, 204.
 * This is the single write this app makes outside itself.
 */
async function addToCart(cfg, accessToken, lines) {
  const items = lines.map((l) => ({
    upc: String(l.upc),
    quantity: Math.min(Math.max(parseInt(l.quantity, 10) || 1, 1), 24),
    modality: cfg.kroger.modality === 'DELIVERY' ? 'DELIVERY' : 'PICKUP',
  }));
  if (!items.length) return { error: 'nothing to add' };

  const res = await request(cfg, ENDPOINTS.cartAdd, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  });
  // Kroger answers 204 with an empty body on success.
  if (res.status === 204 || res.ok) return { added: items.length };
  const kind = failureKind(res.status);
  return { error: FAILURES[kind], kind };
}

/**
 * Send already-matched lines to the cart — ONLY from the owner's explicit
 * Send. No searching happens here: every line arrives with the UPC the owner
 * saw on the review screen, so what lands in the cart is exactly what they
 * looked at.
 *
 * One PUT for the whole set, so a failure leaves the cart untouched rather
 * than half-filled. Returns { added } or { error, kind }.
 */
async function sendCart(cfg, lines) {
  const why = unavailableReason(cfg);
  if (why) return { error: why, kind: /not linked/i.test(why) ? 'signin' : 'unavailable' };
  const items = (lines || []).filter((l) => l && l.upc);
  if (!items.length) return { error: 'There is nothing matched to send.', kind: 'empty' };

  const tok = await ownerToken(cfg);
  if (tok.error) {
    const kind = tok.kind || 'signin';
    return { error: FAILURES[kind] || tok.error, kind };
  }
  const out = await addToCart(cfg, tok.access_token, items);
  if (out.error) return out;
  console.log(`[kroger] cart add: ${out.added} line(s)`);
  return { added: out.added };
}

module.exports = {
  ENDPOINTS,
  SCOPE_CART,
  SCOPE_PRODUCT,
  configured,
  unavailableReason,
  authorizeUrl,
  completeAuthorization,
  consumeState,
  newState,
  readRefreshToken,
  writeRefreshToken,
  clearRefreshToken,
  refreshTokenPath,
  outboundTerm,
  findLocations,
  searchUnavailableReason,
  searchProducts,
  matchTerms,
  addToCart,
  sendCart,
  appToken,
  ownerToken,
  failureKind,
  FAILURES,
  scrub,
};
