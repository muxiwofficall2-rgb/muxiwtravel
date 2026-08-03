// /api/kv.js — proxies reads/writes to Upstash Redis (connected via Vercel
// Storage) through our own domain. This exists so visitors using
// restrictive in-app browsers (WhatsApp, Imo, Instagram, etc.) never have
// to contact a third-party domain directly — their browser only ever talks
// to our own site, while the actual Redis call happens here on Vercel's
// servers instead.
//
// Requires no manual setup beyond connecting the Upstash Redis database to
// this Vercel project (Storage tab -> Connect to Project) — Vercel injects
// the right environment variables automatically.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({
      error: "Redis is not connected to this project yet. Go to Vercel -> Storage -> connect the database to this project.",
    });
  }

  const key = req.query.key;
  if (!key || !/^[a-zA-Z0-9_]+$/.test(key)) {
    return res.status(400).json({ error: "invalid key" });
  }

  const authHeaders = { Authorization: `Bearer ${REDIS_TOKEN}` };

  try {
    if (req.method === "GET") {
      const r = await fetch(`${REDIS_URL}/get/${key}`, {
        headers: authHeaders,
        cache: "no-store",
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return res.status(502).json({ error: `upstream ${r.status}`, upstream: t.slice(0, 200) });
      }
      const data = await r.json();
      if (data.result === null || data.result === undefined) {
        return res.status(404).end();
      }
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(data.result);
    }

    if (req.method === "PUT" || req.method === "POST") {
      let body = req.body;
      if (typeof body !== "string") body = JSON.stringify(body);

      const r = await fetch(`${REDIS_URL}/set/${key}`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "text/plain" },
        body,
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return res.status(502).json({ error: `upstream ${r.status}`, upstream: t.slice(0, 200) });
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
