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

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
    // The single most common cause of "rasm yuklanmadi": the environment
    // variable was never added in Vercel, or it was added but the project
    // hasn't been redeployed since (env vars only take effect on the next
    // deploy). We say this explicitly instead of a vague failure so it's
    // obvious what to fix.
    return res.status(500).json({
      error: "IMGBB_API_KEY Vercel muhit o'zgaruvchilarida sozlanmagan yoki sozlangandan keyin qayta deploy qilinmagan.",
    });
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

    let r;
    try {
      r = await fetchWithTimeout(
        "https://api.imgbb.com/1/upload",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: fd.toString(),
        },
        25000
      );
    } catch (netErr) {
      return res.status(502).json({
        error: "imgbb bilan bog'lanib bo'lmadi: " + String(netErr && netErr.message || netErr),
      });
    }

    let data = null;
    try {
      data = await r.json();
    } catch (parseErr) {
      return res.status(502).json({ error: "imgbb noto'g'ri javob qaytardi (HTTP " + r.status + ")" });
    }

    if (r.ok && data && data.data && data.data.url) {
      return res.status(200).json({ url: data.data.url });
    }

    // Surface imgbb's own error message (e.g. invalid key, quota, bad
    // image) instead of a generic "upload failed" — this is what makes it
    // possible to tell "key is wrong" apart from "network hiccup" apart
    // from "image itself is bad" at a glance.
    const imgbbMsg = (data && data.error && (data.error.message || data.error)) || `HTTP ${r.status}`;
    return res.status(502).json({ error: "imgbb: " + imgbbMsg });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
