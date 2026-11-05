// Useful Gadgets Styling Studio – AI Scanner + account & store sync (Cloudflare Worker)
// Uses Cloudflare's own Workers AI (free daily allowance). No API key needed.
// Setup in the Cloudflare dashboard:
//   Settings → Bindings → Add → Workers AI, variable name: AI
//   Settings → Bindings → Add → D1 database, variable name: DB   (tables are made automatically)
//   Settings → Variables and Secrets → Secret HUD_SECRET (same text as in the STL Sync script)
//   Optional variable ALLOWED_ORIGIN = https://usefulgadgetssl.github.io
//
// Routes
//   POST /            AI scan of 1-3 screenshots (website)
//   POST /auth/pair   {code} -> {token, name}  log in the website with a code from the HUD
//   GET  /me          -> {name}                who is logged in
//   POST /auth/logout                          log out
//   GET  /stores      -> {stores:[{name,shape,slurl}]}  my private stores
//   POST /lsl/code    (HUD) -> "CODE ABC123"   new login code, valid 10 minutes
//   POST /lsl/sync    (HUD) lines "name|shape|slurl-or-Marketplace-link". Adds/updates only ("RESET" is ignored)
//   POST /stores/delete {name, slurl}  remove one store from my private bank
//   POST /stores/clear                 remove all my stores
//   POST /lsl/scan    (HUD) lines "name|creator", first line "NEW" (new scan) or "MORE" (rest of it)
//   GET  /scans/latest -> {created, items:[{name,creator}]}  my latest outfit scan
//   GET  /shared       -> {stores:[{name,slurl}]}  approved store suggestions (added to the shared bank)
//   GET  /prefs        -> {share, admin}   POST /prefs {share:true|false}
//   GET  /admin/suggestions  (admin)  -> {pending:[...], shared:[...]}
//   POST /admin/decide       (admin)  {action:"approve"|"reject"|"remove", key, region, name?}
//
// Store suggestions: when a customer syncs, stores that are NOT in the shared bank (brands.json) are
// copied to "suggestions" (name + SLURL; the private "stores" table is never changed by this).
// When AUTO_APPROVE different avatars have the same store in the same region, it is approved automatically.
// The admin (ADMIN_NAMES, default ChristineStarz) can approve, reject or remove suggestions.
// Customers can turn sharing off under Settings & Accounts → Account; their suggestions are then deleted.

const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const CATS = ["Shape", "Head", "Body", "Skin", "Brows", "Eyes", "Hair", "Makeup", "Tattoo", "Blemishes", "Veins", "Moles", "Ears", "Teeth", "Nails", "Clothing", "Shoes", "Jewelry", "Accessories", "Alpha", "Other"];

const SYSTEM = `You read screenshots of the Firestorm (Second Life viewer) "Edit Outfit" / worn items list.
Return JSON only: {"items":[{"name":"...","category":"...","confidence":"high|medium|low"}]}.
Rules:
- Include only products that are actually WORN.
- Exclude every "... not worn" line, section headers (Clothing, Attachments, Body Parts), buttons and other interface text.
- Copy each product name exactly as written. Never invent or complete missing words.
- category must be one of: ${CATS.join(", ")}.
- If a name is hard to read, still include it but set confidence to "low".
Second Life category guide:
- Shape: the avatar shape, often named after a person or "Female Human"/"Male Human" (e.g. "*PKC* LeL EVO X Lieva - Female Human").
- Head: mesh heads and their parts: LeLUTKA / "lel evox" / Avalon, Catwa, Genus ("/ HEAD / lel evox / AVALON 4.0").
- Body: mesh bodies Legacy, Reborn, Maitreya, Kupra, eBODY, Inithium, Belleza ("Legacy (f) (1.7.1)", "Legacy (f) (Classic Fit)").
- Teeth: teeth, gums, tongue ("/ GUMS / TEETH / lel evox 4.0"). Eyes: eyeballs/iris ("/ EYES / lel evox 4.0").
- Brows: eyebrows. Nails: nails and nail polish. Hair: hair and hairbases. "nova." is a hair brand, so "nova. ..." is Hair.
- Skin: skins and skin details such as forehead lines, wrinkles, lotion. A skin named "(Brows - ...)" is still Skin.
- Veins: face or body veins. Blemishes / Moles / Tattoo / Ears as named.
- Makeup: eyeliner, eyeshadow, lipstick, blush, lashes, freckles, bindi.
- Words in brackets like (Legacy), [legacy/reborn], (EvoX) only tell which body or head it fits. They do not decide the category.
- If there are no worn products, return {"items":[]}.`;

const SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          category: { type: "string", enum: CATS },
          confidence: { type: "string", enum: ["high", "medium", "low"] }
        },
        required: ["name", "category", "confidence"]
      }
    }
  },
  required: ["items"]
};

// Shared brand list (brand -> category) from the website. Cached by Cloudflare for 1 hour.
const BRANDS_URL = "https://usefulgadgetssl.github.io/styling-studio/brands.json";
const bnorm = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
async function loadBank() {
  try {
    const r = await fetch(BRANDS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!r.ok) return {};
    return await r.json();
  } catch { return {}; }
}
async function loadBrands() {
  const j = await loadBank();
  return (j.brands || []).filter(b => b && typeof b.name === "string" && CATS.includes(b.category));
}
function brandCategory(brands, name) {
  const n = bnorm(name);
  let best = null, len = 0;
  for (const b of brands) {
    const k = bnorm(b.name);
    if (k.length > len && (n === k || n.startsWith(k + " "))) { best = b; len = k.length; }
  }
  return best ? best.category : null;
}

// The model may answer with an object or with text that contains JSON
function readItems(result) {
  let r = result && result.response !== undefined ? result.response : result;
  if (typeof r === "string") {
    const m = r.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try { r = JSON.parse(m[0]); } catch { return []; }
  }
  return Array.isArray(r && r.items) ? r.items : [];
}

async function scanImage(env, image, brands) {
  const hint = brands.length
    ? "\nKnown brands that make only one kind of product (brand = category): " +
      brands.map(b => b.name + " = " + b.category).join("; ") + "."
    : "";
  const messages = [
    { role: "system", content: SYSTEM + hint },
    {
      role: "user",
      content: [
        { type: "text", text: "List the worn products in this screenshot as JSON." },
        { type: "image_url", image_url: { url: image } }
      ]
    }
  ];
  try {
    return readItems(await env.AI.run(MODEL, {
      messages,
      max_tokens: 2000,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: SCHEMA }
    }));
  } catch (e) {
    // Retry without the JSON schema in case the model rejects it
    return readItems(await env.AI.run(MODEL, { messages, max_tokens: 2000, temperature: 0 }));
  }
}

// ---------- account & store sync (D1 database "DB") ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLURL = /^(?:https?:\/\/(?:maps\.secondlife\.com|slurl\.com)\/secondlife\/|secondlife:\/\/)[^\s<>"']{1,300}$/i;
// 🛒 Marketplace product or store links from the HUD (kept in the same "stores" table)
const MPURL = /^https:\/\/marketplace\.secondlife\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?(?:p\/[^\s<>"'\/?#]{1,200}\/\d{1,12}|stores\/\d{1,12})$/;
const CODE_MINUTES = 10;
const SESSION_DAYS = 90;
const MAX_STORES = 2000;   // per avatar
const AUTO_APPROVE = 3;    // different avatars with the same store + region -> shared automatically

// Same idea as storeBrandName() on the website: "[theSkinnery] Mainstore" -> "theskinnery"
const STORE_WORDS = /\b(?:main\s*store|mainstore|main|store|shop|official|hq|outlet|sim|flagship|boutique|landmark|lm|location|gacha|event)\b/gi;
const storeKey = name => bnorm(String(name || "").replace(/[\[\]{}()*|]/g, " ").replace(STORE_WORDS, " "));
// Names that are about the customer's own place, never a store
const PRIVATE_NAME = /^(?:home|my home|house|my house|skybox|my skybox|sandbox|platform|land|my land|parcel|rez|rez zone|work|club|beach|pose|poses|photo|photos|studio|my studio)$/;
function slurlRegion(slurl) {
  const m = String(slurl).match(/^(?:https?:\/\/(?:maps\.secondlife\.com|slurl\.com)\/secondlife\/|secondlife:\/\/)([^\/]+)/i);
  if (!m) return "";
  let r = m[1];
  try { r = decodeURIComponent(r.replace(/\+/g, " ")); } catch {}
  return r.toLowerCase().replace(/\s+/g, " ").trim();
}
function isAdmin(env, ownerName) {
  const n = String(ownerName || "").toLowerCase().replace(/\s+resident$/, "").trim();
  const list = String(env.ADMIN_NAMES || "ChristineStarz").split(",").map(x => x.toLowerCase().replace(/\s+resident$/, "").trim()).filter(Boolean);
  return !!n && list.includes(n);
}

let tablesReady = false;
async function ensureTables(env) {
  if (tablesReady) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, owner_key TEXT NOT NULL, owner_name TEXT, expires INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, owner_key TEXT NOT NULL, owner_name TEXT, created INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS stores (owner_key TEXT NOT NULL, name TEXT NOT NULL, shape TEXT, slurl TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (owner_key, name, slurl))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_key TEXT NOT NULL, created INTEGER NOT NULL, items TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS prefs (owner_key TEXT PRIMARY KEY, share INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS suggestions (key TEXT NOT NULL, region TEXT NOT NULL, owner_key TEXT NOT NULL, name TEXT NOT NULL, slurl TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (key, region, owner_key))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS shared (key TEXT PRIMARY KEY, name TEXT NOT NULL, slurl TEXT NOT NULL, how TEXT NOT NULL, updated INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS rejected (key TEXT NOT NULL, region TEXT NOT NULL, PRIMARY KEY (key, region))")
  ]);
  tablesReady = true;
}

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
function randomCode() {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), b => A[b % A.length]).join("");
}
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
async function sha256(s) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}
function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Copy synced stores that are not in the shared bank to "suggestions". Only name + SLURL; never Marketplace links.
async function suggestStores(env, owner, lines, reset, now) {
  const pref = await env.DB.prepare("SELECT share FROM prefs WHERE owner_key = ?").bind(owner).first();
  if (pref && !pref.share) return;
  const bank = await loadBank();
  const known = new Set((bank.stores || []).filter(s => s && typeof s.name === "string").map(s => storeKey(s.name)).filter(Boolean));
  const stmts = [];
  if (reset) stmts.push(env.DB.prepare("DELETE FROM suggestions WHERE owner_key = ?").bind(owner));
  const touched = new Map();
  for (const l of lines) {
    const p = l.split("|");
    if (p.length < 3) continue;
    const name = p[0].trim().slice(0, 80), slurl = p.slice(2).join("|").trim();
    if (!name || !SLURL.test(slurl)) continue;
    const key = storeKey(name), region = slurlRegion(slurl);
    if (key.length < 3 || !region || PRIVATE_NAME.test(key) || known.has(key)) continue;
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO suggestions (key, region, owner_key, name, slurl, created) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(key, region, owner, name, slurl, now));
    touched.set(key + "\n" + region, { key, region });
  }
  if (stmts.length) await env.DB.batch(stmts);
  // Approve automatically when enough different avatars agree (same store name, same region)
  for (const { key, region } of touched.values()) {
    const done = await env.DB.prepare("SELECT 1 AS x FROM shared WHERE key = ? UNION ALL SELECT 1 FROM rejected WHERE key = ? AND region = ? LIMIT 1").bind(key, key, region).first();
    if (done) continue;
    const c = await env.DB.prepare("SELECT COUNT(DISTINCT owner_key) AS n FROM suggestions WHERE key = ? AND region = ?").bind(key, region).first();
    if (!c || c.n < AUTO_APPROVE) continue;
    const best = await env.DB.prepare("SELECT name, slurl FROM suggestions WHERE key = ? AND region = ? ORDER BY created DESC LIMIT 1").bind(key, region).first();
    if (best) await env.DB.prepare("INSERT OR IGNORE INTO shared (key, name, slurl, how, updated) VALUES (?, ?, ?, 'auto', ?)").bind(key, best.name, best.slurl, now).run();
  }
}

// Requests from the U.G. Styling Assistant HUD. They have no Origin, so they must carry the HUD secret.
// Second Life itself adds X-SecondLife-Owner-Key / -Owner-Name to every script request.
async function handleHud(request, env, path) {
  const text = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (request.method !== "POST") return text("method not allowed", 405);
  if (!env.HUD_SECRET || !sameText(request.headers.get("X-UG-Secret") || "", env.HUD_SECRET)) return text("forbidden", 403);
  const owner = (request.headers.get("X-SecondLife-Owner-Key") || "").toLowerCase();
  const ownerName = (request.headers.get("X-SecondLife-Owner-Name") || "").slice(0, 64);
  if (!UUID.test(owner)) return text("no owner", 400);
  if (!env.DB) return text("database missing", 503);
  await ensureTables(env);
  const now = Date.now();

  if (path === "/lsl/code") {
    await env.DB.prepare("DELETE FROM codes WHERE expires < ? OR owner_key = ?").bind(now, owner).run();
    const code = randomCode();
    await env.DB.prepare("INSERT INTO codes (code, owner_key, owner_name, expires) VALUES (?, ?, ?, ?)")
      .bind(code, owner, ownerName, now + CODE_MINUTES * 60000).run();
    return text("CODE " + code);
  }

  if (path === "/lsl/sync") {
    const lines = (await request.text()).split("\n").map(l => l.trim()).filter(Boolean).slice(0, 200);
    const stmts = [];
    // A sync only adds and updates (2026-11-05). "RESET" from older HUDs is ignored, so stores deleted
    // in the HUD stay in the private store bank. They are removed on the website (/stores/delete).
    const reset = false;
    if (lines[0] === "RESET") lines.shift();
    let added = 0;
    for (const l of lines) {
      const p = l.split("|");
      if (p.length < 3) continue;
      const name = p[0].trim().slice(0, 80), shape = p[1].trim().slice(0, 60), slurl = p.slice(2).join("|").trim();
      if (!name || !(SLURL.test(slurl) || MPURL.test(slurl))) continue;
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO stores (owner_key, name, shape, slurl, updated) VALUES (?, ?, ?, ?, ?)")
        .bind(owner, name, shape, slurl, now));
      added++;
    }
    const before = reset ? 0 : (await env.DB.prepare("SELECT COUNT(*) AS c FROM stores WHERE owner_key = ?").bind(owner).first()).c;
    if (before + added > MAX_STORES) return text("FULL " + MAX_STORES, 413);
    if (stmts.length) await env.DB.batch(stmts);
    const total = (await env.DB.prepare("SELECT COUNT(*) AS c FROM stores WHERE owner_key = ?").bind(owner).first()).c;
    // Suggestions for the shared bank. Runs after the private sync is saved, and a problem here never affects it.
    try { await suggestStores(env, owner, lines, reset, now); } catch (e) {}
    return text("SYNCED " + added + " " + total);
  }

  // Outfit scan from the HUD (🔍 SCAN ME). Only my own attachments; only the last 5 scans are kept.
  if (path === "/lsl/scan") {
    const lines = (await request.text()).split("\n").map(l => l.trim()).filter(Boolean).slice(0, 120);
    const first = lines.shift();
    const items = [];
    for (const l of lines) {
      const p = l.split("|");
      const name = (p[0] || "").trim().slice(0, 120);
      const creator = (p[1] || "").trim().slice(0, 80);
      if (name.length >= 2) items.push(creator ? { name, creator } : { name });
    }
    if (first === "NEW") {
      await env.DB.prepare("INSERT INTO scans (owner_key, created, items) VALUES (?, ?, ?)").bind(owner, now, JSON.stringify(items)).run();
      await env.DB.prepare("DELETE FROM scans WHERE owner_key = ? AND id NOT IN (SELECT id FROM scans WHERE owner_key = ? ORDER BY id DESC LIMIT 5)").bind(owner, owner).run();
      return text("SCANNED " + items.length);
    }
    if (first === "MORE") {
      const last = await env.DB.prepare("SELECT id, items FROM scans WHERE owner_key = ? AND created > ? ORDER BY id DESC LIMIT 1").bind(owner, now - 5 * 60000).first();
      if (!last) return text("no scan to add to", 409);
      const all = JSON.parse(last.items || "[]").concat(items).slice(0, 300);
      await env.DB.prepare("UPDATE scans SET items = ? WHERE id = ?").bind(JSON.stringify(all), last.id).run();
      return text("SCANNED " + items.length);
    }
    return text("bad scan", 400);
  }
  return text("not found", 404);
}

// Logged-in website: "Authorization: Bearer <token>" -> session row, or null
async function sessionFor(request, env) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+([0-9a-f]{64})$/i);
  if (!m || !env.DB) return null;
  await ensureTables(env);
  const s = await env.DB.prepare("SELECT owner_key, owner_name, created FROM sessions WHERE token_hash = ?").bind(await sha256(m[1].toLowerCase())).first();
  if (!s) return null;
  if (Date.now() - s.created > SESSION_DAYS * 86400000) return null;
  return s;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path.startsWith("/lsl/")) return handleHud(request, env, path);

    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "https://usefulgadgetssl.github.io";
    const headers = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
      "Content-Type": "application/json"
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers });

    if (origin !== allowed) return reply({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { headers });

    // --- account ---
    if (path === "/auth/pair" || path === "/me" || path === "/auth/logout" || path === "/stores" || path === "/scans/latest" ||
        path === "/shared" || path === "/prefs" || path === "/admin/suggestions" || path === "/admin/decide" ||
        path === "/stores/delete" || path === "/stores/clear") {
      if (!env.DB) return reply({ error: "Database (DB) is not connected yet" }, 503);
      await ensureTables(env);
      // Approved suggestions, for everyone (no login). Only store name + SLURL.
      if (path === "/shared") {
        const r = await env.DB.prepare("SELECT name, slurl FROM shared ORDER BY name LIMIT 5000").all();
        return reply({ stores: r.results || [] });
      }
      if (path === "/auth/pair") {
        if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
        let body; try { body = await request.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
        const code = String(body && body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (code.length !== 6) return reply({ error: "The code has 6 letters/numbers" }, 400);
        const row = await env.DB.prepare("SELECT owner_key, owner_name, expires FROM codes WHERE code = ?").bind(code).first();
        if (!row || row.expires < Date.now()) return reply({ error: "Code not found or too old. Get a new one in the HUD: 🔄 SYNC → 🔑 WEB LOGIN" }, 401);
        const token = randomToken();
        await env.DB.batch([
          env.DB.prepare("DELETE FROM codes WHERE code = ?").bind(code),
          env.DB.prepare("INSERT INTO sessions (token_hash, owner_key, owner_name, created) VALUES (?, ?, ?, ?)")
            .bind(await sha256(token), row.owner_key, row.owner_name, Date.now())
        ]);
        return reply({ token, name: row.owner_name || "" });
      }
      const s = await sessionFor(request, env);
      if (!s) return reply({ error: "Not logged in" }, 401);
      if (path === "/me") return reply({ name: s.owner_name || "" });
      if (path === "/auth/logout") {
        const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+([0-9a-f]{64})$/i);
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(m[1].toLowerCase())).run();
        return reply({ ok: true });
      }
      if (path === "/stores") {
        const r = await env.DB.prepare("SELECT name, shape, slurl, updated FROM stores WHERE owner_key = ? ORDER BY updated DESC LIMIT ?").bind(s.owner_key, MAX_STORES).all();
        return reply({ stores: r.results || [] });
      }
      if (path === "/stores/delete" || path === "/stores/clear") {
        if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
        if (path === "/stores/clear") {
          await env.DB.prepare("DELETE FROM stores WHERE owner_key = ?").bind(s.owner_key).run();
          return reply({ ok: true });
        }
        let body; try { body = await request.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
        const name = String(body && body.name || ""), slurl = String(body && body.slurl || "");
        if (!name || !slurl) return reply({ error: "Missing store" }, 400);
        const r = await env.DB.prepare("DELETE FROM stores WHERE owner_key = ? AND name = ? AND slurl = ?").bind(s.owner_key, name, slurl).run();
        return reply({ ok: true, deleted: (r.meta && r.meta.changes) || 0 });
      }
      if (path === "/scans/latest") {
        const row = await env.DB.prepare("SELECT created, items FROM scans WHERE owner_key = ? ORDER BY id DESC LIMIT 1").bind(s.owner_key).first();
        if (!row) return reply({ created: 0, items: [] });
        return reply({ created: row.created, items: JSON.parse(row.items || "[]") });
      }
      if (path === "/prefs") {
        if (request.method === "POST") {
          let body; try { body = await request.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
          const share = body && body.share === false ? 0 : 1;
          const stmts = [env.DB.prepare("INSERT OR REPLACE INTO prefs (owner_key, share) VALUES (?, ?)").bind(s.owner_key, share)];
          if (!share) stmts.push(env.DB.prepare("DELETE FROM suggestions WHERE owner_key = ?").bind(s.owner_key));
          await env.DB.batch(stmts);
        }
        const p = await env.DB.prepare("SELECT share FROM prefs WHERE owner_key = ?").bind(s.owner_key).first();
        return reply({ share: !p || !!p.share, admin: isAdmin(env, s.owner_name) });
      }
      // --- admin: review store suggestions ---
      if (!isAdmin(env, s.owner_name)) return reply({ error: "Admin only" }, 403);
      if (path === "/admin/suggestions") {
        const pend = await env.DB.prepare(
          "SELECT g.key, g.region, g.n, g.last, " +
          "(SELECT name FROM suggestions x WHERE x.key = g.key AND x.region = g.region ORDER BY created DESC LIMIT 1) AS name, " +
          "(SELECT slurl FROM suggestions x WHERE x.key = g.key AND x.region = g.region ORDER BY created DESC LIMIT 1) AS slurl " +
          "FROM (SELECT key, region, COUNT(DISTINCT owner_key) AS n, MAX(created) AS last FROM suggestions GROUP BY key, region) g " +
          "WHERE g.key NOT IN (SELECT key FROM shared) AND NOT EXISTS (SELECT 1 FROM rejected r WHERE r.key = g.key AND r.region = g.region) " +
          "ORDER BY g.n DESC, g.last DESC LIMIT 300").all();
        const sh = await env.DB.prepare("SELECT key, name, slurl, how, updated FROM shared ORDER BY updated DESC LIMIT 1000").all();
        return reply({ pending: pend.results || [], shared: sh.results || [], autoApprove: AUTO_APPROVE });
      }
      if (path === "/admin/decide") {
        if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
        let body; try { body = await request.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
        const key = String(body && body.key || "").slice(0, 100), region = String(body && body.region || "").slice(0, 100), action = body && body.action;
        if (!key) return reply({ error: "Missing store" }, 400);
        const now = Date.now();
        if (action === "approve") {
          const best = await env.DB.prepare("SELECT name, slurl FROM suggestions WHERE key = ? AND region = ? ORDER BY created DESC LIMIT 1").bind(key, region).first();
          if (!best) return reply({ error: "Suggestion not found" }, 404);
          const name = String(body.name || best.name).trim().slice(0, 80) || best.name;
          await env.DB.prepare("INSERT OR REPLACE INTO shared (key, name, slurl, how, updated) VALUES (?, ?, ?, 'admin', ?)").bind(key, name, best.slurl, now).run();
        } else if (action === "reject") {
          await env.DB.prepare("INSERT OR IGNORE INTO rejected (key, region) VALUES (?, ?)").bind(key, region).run();
        } else if (action === "remove") {
          await env.DB.prepare("DELETE FROM shared WHERE key = ?").bind(key).run();
        } else return reply({ error: "Unknown action" }, 400);
        return reply({ ok: true });
      }
    }

    // --- AI scan ---
    if (path !== "/" && path !== "/scan") return reply({ error: "Not found" }, 404);
    if (request.method !== "POST") return reply({ error: "Method not allowed" }, 405);
    if (!env.AI) return reply({ error: "Workers AI binding (AI) is missing" }, 503);
    if (Number(request.headers.get("content-length") || 0) > 5500000) return reply({ error: "Upload too large" }, 413);

    let payload;
    try { payload = await request.json(); } catch { return reply({ error: "Invalid JSON" }, 400); }
    const images = payload && payload.images;
    if (!Array.isArray(images) || images.length < 1 || images.length > 3 ||
        images.some(x => typeof x !== "string" || x.length > 2100000 || !/^data:image\/(png|jpeg|webp);base64,/.test(x)))
      return reply({ error: "Send 1–3 PNG/JPEG/WebP images, max ~1.5MB each" }, 400);

    try {
      const items = [];
      const seen = new Set();
      const brands = await loadBrands();
      for (const image of images) {
        for (const it of await scanImage(env, image, brands)) {
          if (!it || typeof it.name !== "string") continue;
          const name = it.name.trim();
          const k = name.toLowerCase();
          if (name.length < 3 || seen.has(k) || /not\s+worn/i.test(name)) continue;
          seen.add(k);
          // A known one-kind brand wins, except Head/Body brands (their parts can be eyes, teeth, ...)
          const bc = brandCategory(brands, name);
          let category = CATS.includes(it.category) ? it.category : "Other";
          if (bc && (bc !== "Head" && bc !== "Body" || category === "Other")) category = bc;
          items.push({
            name,
            category,
            confidence: ["high", "medium", "low"].includes(it.confidence) ? it.confidence : "low"
          });
        }
      }
      return reply({ items });
    } catch (e) {
      return reply({ error: "AI analysis failed: " + (e && e.message ? e.message : "unknown") }, 502);
    }
  }
};
