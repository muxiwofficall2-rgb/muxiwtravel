// /api/upload-image.js — proxies photo uploads to imgbb through our own
// domain, for the same reason as kv.js: some in-app browsers block direct
// requests to third-party domains, so the visitor's browser only talks to
// us, and we forward the upload to imgbb from Vercel's servers.

const IMGBB_API_KEY = "aacb40f24687e215c00fe5c42e37d0a7";

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
