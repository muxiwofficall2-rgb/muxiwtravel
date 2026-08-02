// /api/kv.js — proxies reads/writes to kvdb.io through our own domain.
// This exists so visitors using restrictive in-app browsers (WhatsApp, Imo,
// Instagram, etc.) never have to contact a third-party domain directly —
// their browser only ever talks to our own site, which almost every in-app
// browser allows, while the actual kvdb.io call happens here on Vercel's
// servers instead.

const BUCKET = "EF2FFoE8tQX1FMenfGZdnK";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const key = req.query.key;
  if (!key || !/^[a-zA-Z0-9_]+$/.test(key)) {
    return res.status(400).json({ error: "invalid key" });
  }

  const url = `https://kvdb.io/${BUCKET}/${key}`;

  try {
    if (req.method === "GET") {
      const r = await fetch(url, { cache: "no-store" });
      if (r.status === 404) return res.status(404).end();
      if (!r.ok) return res.status(502).json({ error: "upstream error" });
      const text = await r.text();
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(text);
    }

    if (req.method === "PUT" || req.method === "POST") {
      let body = req.body;
      if (typeof body !== "string") body = JSON.stringify(body);
      const r = await fetch(url, { method: "PUT", body, cache: "no-store" });
      if (!r.ok) return res.status(502).json({ error: "upstream error" });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
