// Useful Gadgets Styling Studio – AI Scanner (Cloudflare Worker)
// Uses Cloudflare's own Workers AI (free daily allowance). No API key needed.
// Setup in the Cloudflare dashboard:
//   Settings → Bindings → Add → Workers AI, variable name: AI
//   Optional variable ALLOWED_ORIGIN = https://usefulgadgetssl.github.io

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

async function scanImage(env, image) {
  const messages = [
    { role: "system", content: SYSTEM },
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "https://usefulgadgetssl.github.io";
    const headers = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
      "Content-Type": "application/json"
    };
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers });

    if (origin !== allowed) return reply({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { headers });
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
      for (const image of images) {
        for (const it of await scanImage(env, image)) {
          if (!it || typeof it.name !== "string") continue;
          const name = it.name.trim();
          const k = name.toLowerCase();
          if (name.length < 3 || seen.has(k) || /not\s+worn/i.test(name)) continue;
          seen.add(k);
          items.push({
            name,
            category: CATS.includes(it.category) ? it.category : "Other",
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
