// /api/upload-image.js — proxies photo uploads to imgbb through our own
// domain, for the same reason as kv.js: some in-app browsers block direct
// requests to third-party domains, so the visitor's browser only talks to
// us, and we forward the upload to imgbb from Vercel's servers.
//
// This is used for two things: (1) permanently storing the image so it has
// a link the admin/customer can open later from the "status" screens, and
// (2) giving the upload widget its fast "yashil ✓" (ready) confirmation.
// It does NOT handle the Telegram notification — see /api/notify-telegram.js
// for that, which sends the photo bytes directly instead of relying on this
// URL, avoiding CDN-propagation race conditions.
//
// SECURITY: the imgbb key is read from an environment variable rather than
// written directly in this file, for the same reason the Telegram token
// was moved out of the codebase — anything hardcoded here would be visible
// to anyone who looks at the public GitHub repository.

const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }
  if (!IMGBB_API_KEY) {
    return res.status(500).json({ error: "IMGBB_API_KEY Vercel muhit o'zgaruvchilarida sozlanmagan." });
  }

  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 required" });
    }
    const base64Data = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const fd = new URLSearchParams();
    fd.append("key", IMGBB_API_KEY);
    fd.append("image", base64Data);

    const r = await fetch("https://api.imgbb.com/1/upload", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: fd.toString(),
    });
    const data = await r.json();
    if (data && data.data && data.data.url) {
      return res.status(200).json({ url: data.data.url });
    }
    return res.status(502).json({ error: "upload failed", details: data });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
