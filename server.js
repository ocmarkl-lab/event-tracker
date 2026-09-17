// Event Tracker — Pava trade-fair / conference meeting tracker with team chat.
// Zero dependencies (Node >= 20). Source of truth: data/<slug>.json in this GitHub repo.
// Env: APP_PASSWORD (required), ANTHROPIC_API_KEY (chat), GITHUB_TOKEN (persist edits),
//      GITHUB_REPO (default ocmarkl-lab/event-tracker), GITHUB_BRANCH (default main),
//      CLAUDE_MODEL (default claude-opus-5), PORT.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || '';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const GH_REPO = process.env.GITHUB_REPO || 'ocmarkl-lab/event-tracker';
const GH_BRANCH = process.env.GITHUB_BRANCH || 'main';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const API_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const STATUSES = ['To approach', 'Attempted', 'Confirmed', 'Met', 'Declined', 'Skip'];
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- auth (password form + signed cookie) ----------
const SECRET = crypto.createHash('sha256').update('et:' + PASSWORD).digest();
const sign = v => v + '.' + crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
function authed(req) {
  if (!PASSWORD) return true; // local dev only
  const m = /(?:^|;\s*)et_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [v, s] = [m[1].slice(0, m[1].lastIndexOf('.')), m[1]];
  const expected = Buffer.from(sign(v));
  const got = Buffer.from(s);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got) && Number(v) > Date.now();
}
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

// ---------- storage (GitHub contents API, local fallback) ----------
const cache = new Map(); // slug -> {data, sha, pending, timer, version, checked}
const gh = (p, opt = {}) => fetch(`https://api.github.com/repos/${GH_REPO}/${p}`, {
  ...opt,
  headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'event-tracker', ...(opt.headers || {}) },
});
const slugOk = s => /^[a-z0-9-]{2,60}$/.test(s);

async function listEvents() {
  let files = [];
  if (GH_TOKEN) {
    const r = await gh(`contents/data?ref=${GH_BRANCH}`);
    if (r.ok) files = (await r.json()).map(f => f.name);
  }
  if (!files.length) files = fs.readdirSync(DATA_DIR);
  const out = [];
  for (const f of files.filter(f => f.endsWith('.json'))) {
    const slug = f.replace(/\.json$/, '');
    try { const e = await load(slug); out.push({ slug, name: e.data.name, city: e.data.city, conference: e.data.conference }); } catch (_) {}
  }
  return out;
}

async function load(slug) {
  if (!slugOk(slug)) throw Object.assign(new Error('bad slug'), { status: 400 });
  if (cache.has(slug)) {
    const c = cache.get(slug);
    // pick up commits made outside the app (Anni, manual edits) — at most every 30 s, never over unsaved edits
    if (GH_TOKEN && !c.pending.length && !c.timer && Date.now() - (c.checked || 0) > 30000) {
      c.checked = Date.now();
      try {
        const r = await gh(`contents/data/${slug}.json?ref=${GH_BRANCH}`);
        if (r.ok) {
          const j = await r.json();
          if (j.sha !== c.sha) { c.data = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); c.sha = j.sha; c.version++; }
        }
      } catch (_) {}
    }
    return c;
  }
  let entry;
  if (GH_TOKEN) {
    const r = await gh(`contents/data/${slug}.json?ref=${GH_BRANCH}`);
    if (r.ok) {
      const j = await r.json();
      entry = { data: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')), sha: j.sha };
    } else if (r.status !== 404) throw new Error('GitHub read failed: ' + r.status);
  }
  if (!entry) {
    const f = path.join(DATA_DIR, slug + '.json');
    if (!fs.existsSync(f)) throw Object.assign(new Error('not found'), { status: 404 });
    entry = { data: JSON.parse(fs.readFileSync(f, 'utf8')), sha: null };
  }
  entry.version = 1; entry.pending = []; entry.timer = null; entry.checked = Date.now();
  cache.set(slug, entry);
  return entry;
}

function applyPatch(data, op) {
  const row = data.rows.find(r => r.id === op.id);
  if (!row) throw Object.assign(new Error('unknown company id ' + op.id), { status: 404 });
  if (op.status !== undefined) {
    if (!STATUSES.includes(op.status)) throw Object.assign(new Error('bad status'), { status: 400 });
    row.status = op.status;
  }
  for (const k of ['slot', 'notes', 'contact']) if (op[k] !== undefined) row[k] = String(op[k]).slice(0, 500);
  row.updatedBy = String(op.by || '').slice(0, 60);
  row.updatedAt = op.at;
  data.updatedAt = op.at;
  return row;
}

async function update(slug, op) {
  const e = await load(slug);
  op.at = new Date().toISOString();
  const row = applyPatch(e.data, op);
  e.version++;
  e.pending.push(op);
  if (GH_TOKEN) { clearTimeout(e.timer); e.timer = setTimeout(() => { e.timer = null; flush(slug).catch(err => console.error('flush', err)); }, 4000); }
  return row;
}

async function flush(slug, attempt = 0) {
  const e = cache.get(slug);
  if (!e || !e.pending.length) return;
  const ops = e.pending.splice(0);
  const body = {
    message: `tracker(${slug}): ${ops.length} update(s) by ${[...new Set(ops.map(o => o.by || '?'))].join(', ')}`,
    content: Buffer.from(JSON.stringify(e.data, null, 1) + '\n').toString('base64'),
    branch: GH_BRANCH,
  };
  if (e.sha) body.sha = e.sha;
  const r = await gh(`contents/data/${slug}.json`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  if (r.ok) { e.sha = (await r.json()).content.sha; return; }
  if ((r.status === 409 || r.status === 422) && attempt < 3) {
    // someone committed in between (e.g. Anni): reload remote, replay our ops
    cache.delete(slug);
    const fresh = await load(slug);
    for (const op of ops) { try { applyPatch(fresh.data, op); } catch (_) {} }
    fresh.version = e.version + 1;
    fresh.pending = ops.concat(fresh.pending);
    return flush(slug, attempt + 1);
  }
  e.pending.unshift(...ops);
  throw new Error('GitHub write failed: ' + r.status + ' ' + (await r.text()).slice(0, 200));
}
setInterval(() => { for (const [slug, e] of cache) if (e.pending.length && !e.timer) flush(slug).catch(() => {}); }, 60000).unref();

// ---------- chat (Anthropic Messages API with an update tool) ----------
const TOOLS = [{
  name: 'update_company',
  description: 'Update one company row in the tracker: status, meeting slot, notes or contact. Only call this when the user clearly asks for a change.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Row id from the tracker data' },
      status: { type: 'string', enum: STATUSES },
      slot: { type: 'string', description: 'e.g. "Wed 11:00"' },
      notes: { type: 'string' },
      contact: { type: 'string' },
    },
    required: ['id'],
  },
}];

function systemPrompt(ev) {
  const compact = ev.rows.map(r => [r.id, r.tier, r.company, r.country, r.stand, r.sector, r.why, r.contact, r.status, r.slot, r.notes].join(' | ')).join('\n');
  return `You are the assistant inside the Pava Partners meeting tracker for ${ev.name} (${ev.city}, venue ${ev.venue}; conference ${ev.conference}; exhibition ${ev.exhibition}).
Pava is a deep-tech M&A advisory (semiconductors, photonics, quantum, space, robotics; EUR 30–300m EV; DACH/Benelux focus). Users are Pava team members.
Timing note: ${ev.alert || '-'}
Tiers: ${Object.entries(ev.tiers).map(([k, v]) => k + ' = ' + v.name).join('; ')}.
Tracker rows (id | tier | company | country | stand | sector | why meet | contact | status | slot | notes):
${compact}

Rules:
- Answer briefly and concretely, from the tracker data. Say clearly when something is not in the data; do not invent facts, names or email addresses. "⚠" marks unverified items.
- You can draft outreach (email or LinkedIn note, max ~120 words) and plan a floor route by stand number.
- To change the tracker, call update_company. Only do so when explicitly asked; then confirm what changed.
- Reply in the language the user writes in.`;
}

async function chat(slug, messages, by) {
  if (!API_KEY) throw Object.assign(new Error('Chat is not configured (ANTHROPIC_API_KEY missing).'), { status: 503 });
  const e = await load(slug);
  const convo = messages.slice(-20).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 8000) }));
  const changed = [];
  for (let round = 0; round < 4; round++) {
    const r = await fetch(API_BASE + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: systemPrompt(e.data), tools: TOOLS, messages: convo }),
    });
    if (!r.ok) throw Object.assign(new Error('Claude API error ' + r.status + ': ' + (await r.text()).slice(0, 300)), { status: 502 });
    const j = await r.json();
    convo.push({ role: 'assistant', content: j.content });
    const uses = j.content.filter(b => b.type === 'tool_use');
    if (j.stop_reason !== 'tool_use' || !uses.length) {
      return { text: j.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), changed };
    }
    const results = [];
    for (const u of uses) {
      try {
        const row = await update(slug, { ...u.input, by: `${by} via chat` });
        changed.push(row.id);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify({ ok: true, row }) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Error: ' + err.message, is_error: true });
      }
    }
    convo.push({ role: 'user', content: results });
  }
  return { text: 'Stopped after several tool steps — please check the tracker.', changed };
}

// ---------- http ----------
const send = (res, status, body, headers = {}) => {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/html; charset=utf-8' : 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
};
const readBody = req => new Promise((ok, fail) => {
  let b = ''; req.on('data', c => { b += c; if (b.length > 200000) { fail(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (_) { ok(Object.fromEntries(new URLSearchParams(b))); } });
});
const page = name => fs.readFileSync(path.join(PUBLIC_DIR, name));
const loginTries = new Map();

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname === '/login' && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      const t = loginTries.get(ip) || { n: 0, at: Date.now() };
      if (Date.now() - t.at > 15 * 60000) { t.n = 0; t.at = Date.now(); }
      if (t.n >= 10) return send(res, 429, page('login.html').toString().replace('<!--msg-->', '<p class="err">Too many attempts — try again in 15 minutes.</p>'));
      const body = await readBody(req);
      if (PASSWORD && safeEqual(body.password || '', PASSWORD)) {
        const cookie = sign(String(Date.now() + 30 * 864e5));
        return send(res, 303, '', { Location: '/', 'Set-Cookie': `et_session=${cookie}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 86400}` });
      }
      t.n++; loginTries.set(ip, t);
      return send(res, 401, page('login.html').toString().replace('<!--msg-->', '<p class="err">Wrong password.</p>'));
    }
    if (!authed(req)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'login required' });
      return send(res, 200, page('login.html'));
    }
    if (url.pathname === '/logout') return send(res, 303, '', { Location: '/', 'Set-Cookie': 'et_session=; Path=/; Max-Age=0' });
    if (url.pathname === '/' || url.pathname.startsWith('/e/')) return send(res, 200, page('index.html'));
    if (url.pathname === '/api/events' && req.method === 'GET') return send(res, 200, { events: await listEvents(), chat: !!API_KEY, persist: !!GH_TOKEN });
    let m = /^\/api\/events\/([a-z0-9-]+)$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const e = await load(m[1]);
      return send(res, 200, { version: e.version, event: e.data, chat: !!API_KEY, persist: !!GH_TOKEN, statuses: STATUSES });
    }
    m = /^\/api\/events\/([a-z0-9-]+)\/rows\/([a-z0-9-]+)$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      const b = await readBody(req);
      const row = await update(m[1], { id: m[2], status: b.status, slot: b.slot, notes: b.notes, contact: b.contact, by: b.by });
      return send(res, 200, { row, version: cache.get(m[1]).version });
    }
    m = /^\/api\/events\/([a-z0-9-]+)\/chat$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      const b = await readBody(req);
      const out = await chat(m[1], Array.isArray(b.messages) ? b.messages : [], String(b.by || 'someone').slice(0, 60));
      return send(res, 200, { ...out, version: cache.get(m[1]).version });
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return send(res, err.status || 500, { error: err.message });
  }
}).listen(PORT, () => console.log(`event-tracker on :${PORT} (persist=${!!GH_TOKEN}, chat=${!!API_KEY})`));

process.on('SIGTERM', async () => {
  for (const slug of cache.keys()) { try { await flush(slug); } catch (_) {} }
  process.exit(0);
});
