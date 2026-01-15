// /api/experts/get.js
// Public endpoint used by intervenant.html
// Returns: { id, name, presentation, photo_url }
// photo_url is a short-lived signed URL generated from photo_path (Supabase Storage)

import { supabaseAdmin } from "../_lib/supabase";

function setCors(req, res) {
  const origin = String(req.headers.origin || "");

  const allowed = new Set([
    "https://www.run-call.com",
    "https://run-call.com",
    "https://preview.run-call.com",
    "http://localhost:3000",
    "http://localhost:5173",
  ]);

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    // safe default: no wildcard (avoid leaking private data cross-site)
    res.setHeader("Access-Control-Allow-Origin", "https://preview.run-call.com");
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Avoid caching signed URLs by proxies/CDNs
    res.setHeader("Cache-Control", "no-store");

    const expertIdRaw = req.query.expert_id;
    if (!expertIdRaw) return res.status(400).json({ error: "Missing expert_id", received_query: req.query });

    const expertId = String(expertIdRaw).trim();
    if (!expertId) return res.status(400).json({ error: "Empty expert_id", received_query: req.query });

    const sb = supabaseAdmin();

    const { data: row, error } = await sb
      .from("experts")
      .select("id,name,presentation,photo_path")
      .eq("id", expertId)
      .maybeSingle();

    if (error) return res.status(500).json({ error: "DB error", details: error.message });
    if (!row) return res.status(404).json({ error: "Expert not found" });

    // Signed URL from photo_path (10 min)
    let photo_url = null;
    const photoPath = String(row.photo_path || "").trim();
    if (photoPath) {
      const { data: signed, error: signErr } = await sb.storage
        .from("avatars")
        .createSignedUrl(photoPath, 60 * 10);

      if (!signErr) photo_url = signed?.signedUrl || null;
    }

    return res.status(200).json({
      id: row.id,
      name: row.name ?? null,
      presentation: row.presentation ?? null,
      photo_url,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error", details: e?.message || String(e) });
  }
}
