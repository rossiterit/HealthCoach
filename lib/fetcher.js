'use strict';
/**
 * fetcher.js — the fenced single-page fetcher (v4 F5, Decision 9, GOTK-174).
 *
 * This is the app's second and last external capability, and the only one that
 * READS from the open internet. Everything about it is built to be small,
 * boring and refusable.
 *
 * WHAT IT WILL DO: fetch exactly one page, over http(s), that the owner pasted,
 * within a byte cap and a time cap, and hand back its bytes.
 *
 * WHAT IT CANNOT DO: follow links, fetch a second page on its own initiative,
 * reach anything on a private or internal address, or reach this droplet's own
 * services. There is no crawl function here because there is no crawling.
 *
 * THE ADDRESS FENCE, and why it is at the DNS layer.
 *
 * Checking the hostname string is not a defence. "localhost" is easy to catch
 * and irrelevant: the real attacks are a hostname that resolves to 127.0.0.1,
 * a hostname that resolves to a public address on the first lookup and a
 * private one on the second (DNS rebinding), and a public URL that 302s to
 * http://169.254.169.254/ or to one of our own ports. All three defeat string
 * checks and none of them defeat this.
 *
 * So validation happens in a custom `lookup` handler passed to the agent. Node
 * calls it for every connection, including every redirect hop, and it is the
 * single place an address can enter the process. It resolves once, checks EVERY
 * returned address, and fails the whole request if any of them is private —
 * fail closed rather than picking the public one, because which address gets
 * used afterwards is not ours to control.
 *
 * THIS DROPLET'S OWN ADDRESSES are in the blocklist too, public ones included.
 * gotkapp.com resolves to this machine: without that rule a "recipe URL" could
 * be pointed at our own nginx and read whatever it serves.
 *
 * NOTHING HERE INTERPRETS WHAT IT FETCHES. It returns bytes and a content type.
 * What those bytes are allowed to mean is recipeimport.js's problem, and that
 * module is where the second guardrail lives.
 */
const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const os = require('os');

const MAX_BYTES = 2 * 1024 * 1024;   // 2 MB: a recipe page that exceeds this is not a recipe page
const TIMEOUT_MS = 12000;            // per attempt
const TOTAL_TIMEOUT_MS = 25000;      // across all redirect hops
const MAX_REDIRECTS = 3;
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

/** Content types worth parsing. Anything else is refused before it is read. */
const TEXTUAL = /^(text\/html|text\/plain|application\/xhtml\+xml|application\/json|text\/)/i;

// ---------------------------------------------------------------------------
// the address fence
// ---------------------------------------------------------------------------

/** Every address this machine answers on — loopback, private AND public. */
function ownAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const a of list || []) out.add(normaliseIp(a.address));
  }
  return out;
}
const OWN = ownAddresses();

function normaliseIp(ip) {
  const s = String(ip || '').trim().toLowerCase();
  // Strip a zone index ("fe80::1%eth0") and unwrap IPv4-mapped IPv6.
  const bare = s.split('%')[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  return mapped ? mapped[1] : bare;
}

function ipv4Parts(ip) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n >= 0 && n <= 255) ? p : null;
}

/**
 * True for anything that is not a public internet address.
 *
 * Deliberately generous: every reserved, private, link-local, loopback,
 * carrier-NAT, multicast and benchmarking range, plus this host's own
 * addresses. A false refusal costs the owner a "paste the text"; a false
 * allowance is an SSRF.
 */
function isBlockedAddress(rawIp) {
  const ip = normaliseIp(rawIp);
  if (!ip) return 'unresolvable address';
  if (OWN.has(ip)) return 'this server’s own address';

  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return 'unspecified address';
    if (a === 10) return 'a private address';
    if (a === 127) return 'a loopback address';
    if (a === 169 && b === 254) return 'a link-local address';   // incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return 'a private address';
    if (a === 192 && b === 168) return 'a private address';
    if (a === 192 && b === 0) return 'a reserved address';        // 192.0.0.0/24, 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return 'a benchmarking address';
    if (a === 198 && b === 51) return 'a documentation address';
    if (a === 203 && b === 0) return 'a documentation address';
    if (a === 100 && b >= 64 && b <= 127) return 'a carrier-NAT address';
    if (a >= 224) return 'a multicast or reserved address';       // 224/4 and 240/4
    return null;
  }

  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return 'a loopback address';
    if (/^f[cd]/.test(ip)) return 'a unique-local address';       // fc00::/7
    if (/^fe[89ab]/.test(ip)) return 'a link-local address';      // fe80::/10
    if (/^ff/.test(ip)) return 'a multicast address';
    return null;
  }
  return 'an address I could not read';
}

/**
 * A dns.lookup replacement that refuses to hand back a blocked address.
 *
 * This is the choke point. Node calls it for the initial request and again for
 * every redirect hop, so there is no way to reach an address that has not been
 * through here. If ANY address a hostname resolves to is blocked, the whole
 * lookup fails: resolving to both a public and a private address is a rebinding
 * setup, not a reason to prefer the public one.
 */
function guardedLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : options || {};

  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (!list.length) return cb(new Error('that address did not resolve'));

    for (const entry of list) {
      const why = isBlockedAddress(entry.address);
      if (why) {
        const e = new Error(`refused: ${hostname} is ${why}`);
        e.code = 'EBLOCKED';
        return cb(e);
      }
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

/** Scheme, port and shape checks that can be made before any network use. */
function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { error: 'that does not look like a web address' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { error: `I can only read http and https pages, not ${u.protocol.replace(':', '')}` };
  }
  // Credentials in a URL are never needed for a recipe page and are a classic
  // way to dress up an internal target.
  if (u.username || u.password) return { error: 'I will not fetch a URL with a username or password in it' };

  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) return { error: `I only read pages on the usual web ports, not port ${port}` };

  // A literal IP in the URL is checked here as well as at lookup, so an
  // obviously-internal target is refused without any network traffic at all.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    const why = isBlockedAddress(host);
    if (why) return { error: `that is ${why}, which I will not fetch` };
  }
  return { url: u };
}

// ---------------------------------------------------------------------------
// the fetch
// ---------------------------------------------------------------------------

function once(url, { deadline }) {
  return new Promise((resolve) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        headers: {
          // Honest about what we are. No cookies, no auth, no referrer.
          'User-Agent': 'HealthCoach/4 (personal recipe importer)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
          'Accept-Language': 'en',
        },
        timeout: Math.max(1000, Math.min(TIMEOUT_MS, deadline - Date.now())),
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: res.headers.location, status });
        }
        if (status !== 200) {
          res.resume();
          return resolve({ error: `the page came back as HTTP ${status}` , status });
        }

        const type = String(res.headers['content-type'] || '');
        if (type && !TEXTUAL.test(type)) {
          res.destroy();
          return resolve({ error: 'that link is not a web page I can read' });
        }
        // Refuse on a declared oversize length before reading a byte of it.
        const declared = Number(res.headers['content-length'] || 0);
        if (declared && declared > MAX_BYTES) {
          res.destroy();
          return resolve({ error: 'that page is too big to read' });
        }

        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BYTES) {
            // Cap enforced on the stream too: content-length can lie or be absent.
            res.destroy();
            return resolve({ error: 'that page is too big to read' });
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8'), type, status }));
        res.on('error', () => resolve({ error: 'the connection dropped while reading that page' }));
      },
    );

    req.on('timeout', () => { req.destroy(); resolve({ error: 'that page took too long to answer' }); });
    req.on('error', (e) => {
      // EBLOCKED is our own refusal and its message is safe and useful; any
      // other network error is reported generically rather than leaking a
      // resolver or socket detail into the chat.
      resolve({ error: e.code === 'EBLOCKED' ? e.message.replace(/^refused: /, '') : 'I could not reach that page' });
    });
    req.end();
  });
}

/**
 * Fetch one page, following at most MAX_REDIRECTS hops, validating the scheme,
 * port and every resolved address at each one.
 *
 * Returns { body, type, finalUrl } or { error }. Never throws: the caller's
 * whole job on failure is to say "paste the text instead".
 */
async function fetchPage(raw) {
  const checked = checkUrl(raw);
  if (checked.error) return { error: checked.error };

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let url = checked.url;
  const seen = new Set([url.href]);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() >= deadline) return { error: 'that page took too long to answer' };
    const out = await once(url, { deadline });

    if (out.error) return { error: out.error };
    if (out.body !== undefined) return { body: out.body, type: out.type, finalUrl: url.href };

    // A redirect. Re-validate from scratch: the destination is chosen by the
    // remote server, so it gets exactly the same scrutiny as the original.
    let next;
    try {
      next = new URL(out.redirect, url);
    } catch {
      return { error: 'that page redirected somewhere I could not read' };
    }
    const nextChecked = checkUrl(next.href);
    if (nextChecked.error) return { error: `that page redirected to somewhere I will not follow — ${nextChecked.error}` };
    if (seen.has(next.href)) return { error: 'that page redirects in a loop' };
    seen.add(next.href);
    url = nextChecked.url;
  }
  return { error: 'that page redirected too many times' };
}

module.exports = {
  fetchPage,
  checkUrl,
  isBlockedAddress,
  guardedLookup,
  normaliseIp,
  ownAddresses,
  MAX_BYTES,
  MAX_REDIRECTS,
  ALLOWED_PORTS,
  TOTAL_TIMEOUT_MS,
};
