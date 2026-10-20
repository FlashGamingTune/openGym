// Small Cloudflare Workers/D1 compatibility API for personal Open Gym mobile sync.
// It is NOT an official Open Gym server port. It supports pairing and JSON workout state only;
// exercise photos/videos, browser passkey signup, AI Coach, and push reminders are not included.
import { stampPut } from "../../api/sync-stamps.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoid 0/O and 1/I
const SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 45 * 24 * 60 * 60 * 1000;
const PAIR_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 1_500_000; // leave headroom for D1's per-value limits

const now = () => Date.now();
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});
const error = (message, status = 400) => json({ error: message }, status);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const bytesToHex = bytes => [...bytes].map(n => n.toString(16).padStart(2, "0")).join("");
const randomHex = (length = 32) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
};
async function hash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}
function makePairCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map(v => CODE_ALPHABET[v % CODE_ALPHABET.length]).join("");
}
function userOf(row) {
  return { id: row.id, name: row.name, admin: false };
}
function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}
function withCors(response, headers) {
  const h = new Headers(response.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
async function readJson(request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Response(JSON.stringify({ error: "state too large for this starter server" }), { status: 413, headers: { "content-type": "application/json" } });
  try { return JSON.parse(text); } catch { throw new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400, headers: { "content-type": "application/json" } }); }
}
async function findProfileById(db, id) {
  return db.prepare("SELECT id, name, state_json, revision, created_at FROM profiles WHERE id = ?").bind(id).first();
}
async function authenticated(request, env) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
  if (!match) return null;
  const tokenHash = await hash(match[1]);
  const row = await env.DB.prepare(
    "SELECT s.token_hash, s.profile_id, s.created_at AS session_created, s.expires_at, p.id, p.name, p.state_json, p.revision, p.created_at FROM sessions s JOIN profiles p ON p.id = s.profile_id WHERE s.token_hash = ?"
  ).bind(tokenHash).first();
  if (!row || row.expires_at <= now()) {
    if (row) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return { row, tokenHash };
}
async function issueSession(env, profileId) {
  const token = randomHex(32);
  const createdAt = now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, profile_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await hash(token), profileId, createdAt, createdAt + SESSION_MS).run();
  return token;
}
function stateForPhone(raw) {
  if (!isObject(raw)) return raw;
  const state = structuredClone(raw);
  // Server-owned / transient fields are not part of the phone's state document.
  delete state._rev;
  delete state._wid;
  delete state._wids;
  delete state._unstamped;
  delete state._prior;
  delete state.active;
  return state;
}
const ADMIN_HTML = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Gym Sync Setup</title><style>body{font:16px system-ui;max-width:620px;margin:8vh auto;padding:0 20px;background:#101411;color:#ecf3ed}main{border:1px solid #344239;border-radius:18px;padding:24px;background:#171e19}label{display:block;margin-top:18px}input{box-sizing:border-box;width:100%;padding:12px;border-radius:8px;border:1px solid #526359;background:#0d120e;color:#fff;margin-top:6px}button{margin-top:20px;padding:12px 16px;border:0;border-radius:9px;background:#d0f477;color:#1b2612;font-weight:700;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}.muted{color:#bdc9bf}</style><main><h1>Open Gym Sync Setup</h1><p class="muted">Private helper page for the owner of this personal sync server. The setup token is never saved by this page.</p><form id="f"><label>Admin setup token<input id="token" type="password" autocomplete="off" required></label><label>Profile name<input id="name" maxlength="40" value="Saad" required></label><button>Create one-time pairing code</button></form><pre id="out" role="status"></pre><p class="muted">A code works once for five minutes. Create a separate code for each phone. Keep your admin token private.</p></main><script>document.getElementById('f').addEventListener('submit',async e=>{e.preventDefault();const out=document.getElementById('out');out.textContent='Creating code…';try{const r=await fetch('/api/admin/pair-code',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+document.getElementById('token').value},body:JSON.stringify({name:document.getElementById('name').value})});const d=await r.json();if(!r.ok)throw new Error(d.error||('HTTP '+r.status));out.textContent='Pairing code: '+d.code+'\\nExpires: '+new Date(d.expires_at).toLocaleTimeString()+'\\n\\nIn the Open Gym app choose Connect to my server, enter this site address and the code.';}catch(err){out.textContent='Error: '+err.message;}});</script></html>`;

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") return new Response(null, { status: 204 });
  if (method === "GET" && path === "/") return new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (method === "GET" && path === "/api/health") return json({ ok: true, service: "opengym-cloudflare-sync", media: false });
  if (method === "GET" && path === "/api/config") return json({ invite_only: true, allow_guest: false, password_login: false, media: false, coach: { enabled: false }, web_push: false });

  if (method === "POST" && path === "/api/admin/pair-code") {
    if (!env.ADMIN_SETUP_TOKEN) return error("Server setup is incomplete: ADMIN_SETUP_TOKEN is not set", 503);
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") || "");
    if (!bearer || bearer[1] !== env.ADMIN_SETUP_TOKEN) return error("Unauthorized", 401);
    let body;
    try { body = await readJson(request); } catch (e) { return e instanceof Response ? e : error("invalid JSON"); }
    const name = String(body?.name || "Open Gym Owner").trim().slice(0, 40) || "Open Gym Owner";
    let profile = await env.DB.prepare("SELECT id, name FROM profiles ORDER BY created_at LIMIT 1").first();
    if (!profile) {
      const id = randomHex(16);
      await env.DB.prepare("INSERT INTO profiles (id, name, state_json, revision, created_at) VALUES (?, ?, NULL, 0, ?)").bind(id, name, now()).run();
      profile = { id, name };
    }
    // Keep only a small number of live codes; one-time use is enforced with UPDATE ... RETURNING below.
    await env.DB.prepare("DELETE FROM pairing_codes WHERE expires_at <= ? OR used_at IS NOT NULL").bind(now()).run();
    const code = makePairCode();
    const expiresAt = now() + PAIR_MS;
    await env.DB.prepare("INSERT INTO pairing_codes (code_hash, profile_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)").bind(await hash(code), profile.id, expiresAt, now()).run();
    return json({ code, expires_at: expiresAt, user: userOf(profile) });
  }

  if (method === "POST" && path === "/api/pair/redeem") {
    let body;
    try { body = await readJson(request); } catch (e) { return e instanceof Response ? e : error("invalid JSON"); }
    const code = String(body?.code || "").trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) return error("invalid or expired code", 400);
    const codeHash = await hash(code);
    const claim = await env.DB.prepare("UPDATE pairing_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING profile_id")
      .bind(now(), codeHash, now()).first();
    if (!claim) return error("invalid or expired code", 400);
    const profile = await findProfileById(env.DB, claim.profile_id);
    if (!profile) return error("profile unavailable", 400);
    const token = await issueSession(env, profile.id);
    return json({ token, user: userOf(profile) });
  }

  if (method === "GET" && path === "/api/me") {
    const auth = await authenticated(request, env);
    if (!auth) return error("not signed in", 401);
    const response = { user: userOf(auth.row) };
    if (auth.row.expires_at - now() < RENEW_AFTER_MS) {
      const token = await issueSession(env, auth.row.id);
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(auth.tokenHash).run();
      response.token = token;
    }
    return json(response);
  }

  if (method === "POST" && path === "/api/logout") {
    const auth = await authenticated(request, env);
    if (!auth) return error("not signed in", 401);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(auth.tokenHash).run();
    return json({ ok: true });
  }

  if (path === "/api/data" || path === "/api/data/rev") {
    const auth = await authenticated(request, env);
    if (!auth) return error("not signed in", 401);
    const profile = auth.row;
    const rev = Number(profile.revision) || 0;
    const current = profile.state_json ? JSON.parse(profile.state_json) : null;
    if (method === "GET" && path === "/api/data/rev") return json({ rev });
    if (method === "GET" && path === "/api/data") return json({ state: current ? stateForPhone(current) : null, rev });
    if (method === "PUT" && path === "/api/data") {
      let body;
      try { body = await readJson(request); } catch (e) { return e instanceof Response ? e : error("invalid JSON"); }
      if (!isObject(body?.state)) return error("state required", 400);
      if ((body.state.workouts != null && !Array.isArray(body.state.workouts)) || (body.state.routines != null && !Array.isArray(body.state.routines))) return error("invalid state", 400);
      if (body.baseRev != null && Number(body.baseRev) !== rev) return json({ error: "conflict", rev, state: current ? stateForPhone(current) : null }, 409);
      const next = structuredClone(body.state);
      delete next.active;
      let report = {};
      try {
        stampPut(current, next, { overRead: body.baseRev != null && Number(body.baseRev) === rev, stamped: body.stamped === true, report, now: now() });
      } catch (e) {
        if (e instanceof RangeError) return error("invalid state", 400);
        throw e;
      }
      next._rev = rev + 1;
      const serialized = JSON.stringify(next);
      if (new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES) return error("Workout history is too large for this starter server (1.5 MB limit)", 413);
      // Atomic compare-and-swap: concurrent phone writes cannot silently overwrite one another.
      const updated = await env.DB.prepare("UPDATE profiles SET state_json = ?, revision = revision + 1 WHERE id = ? AND revision = ?")
        .bind(serialized, profile.id, rev).run();
      if ((updated.meta?.changes || 0) !== 1) {
        const latest = await findProfileById(env.DB, profile.id);
        const latestState = latest?.state_json ? JSON.parse(latest.state_json) : null;
        return json({ error: "conflict", rev: Number(latest?.revision) || 0, state: latestState ? stateForPhone(latestState) : null }, 409);
      }
      return json({ ok: true, rev: rev + 1 });
    }
  }

  return error("Not found", 404);
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request);
    try {
      return withCors(await handle(request, env), headers);
    } catch (e) {
      console.error("Open Gym Worker error", e);
      return withCors(error("Internal server error", 500), headers);
    }
  },
};

