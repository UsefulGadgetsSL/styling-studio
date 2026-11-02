# AI Scanner 2.0 — Cloudflare Worker (free Workers AI)

The public GitHub Pages website cannot keep secrets, so the AI call runs in a Cloudflare Worker.
This version uses Cloudflare's own **Workers AI** (model `@cf/meta/llama-4-scout-17b-16e-instruct`).
No API key and no payment card are needed; it runs inside the free daily allowance.

Live Worker: `https://styling-studio-ai.usefulgadgetssl.workers.dev`

## Setup (already done 2026-11-02)
1. Cloudflare dashboard → Workers & Pages → Create → Start with Hello World, name `styling-studio-ai`, Deploy.
2. Settings → Bindings → Add binding → **Workers AI**, variable name `AI`.
3. Edit code → replace everything with `worker.js` → Deploy.
4. Optional: Settings → Variables → `ALLOWED_ORIGIN = https://usefulgadgetssl.github.io` (this is also the default).
5. In Styling Studio, paste the Worker URL in *AI scanner endpoint* and click **Save endpoint** (saved per browser).

## Before opening the AI button to other users
The Worker URL is public. The Origin check only stops other websites in a browser, not scripts.
Add Turnstile, rate limits and/or login before sharing it, so nobody can use up the daily allowance.

Images are sent to Cloudflare Workers AI only when **Read with AI** is clicked.
The OCR button still works without the Worker.
