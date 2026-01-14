// /api/experts/update.js
// Receives: { name, presentation }
// Auth: header "x-dashboard-token"
// Returns: { expert: { id, name, presentation, photo_url } }

import { supabaseAdmin } from "../_lib/supabase";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://run-call.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-token");
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const token = String(req.headers["x-dashboard-token"] || "").trim();
    if (!token) return res.status(401).json({ error: "Missing dashboard token" });

    const { name, presentation } = req.body || {};

    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanPresentation = typeof presentation === "string" ? presentation.trim() : "";

    if (!cleanName || !cleanPresentation) {
      return res.status(400).json({ error: "Missing required fields (name, presentation)" });
    }
    if (cleanName.length > 120) return res.status(400).json({ error: "Name too long" });
    if (cleanPresentation.length > 3000) return res.status(400).json({ error: "Presentation too long" });

    // 🚫 hard refuse old field (prevents accidental regressions)
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "photo_url")) {
      return res.status(400).json({ error: "photo_url is not allowed. Use /api/experts/avatar/upload." });
    }

    const sb = supabaseAdmin();

    // Resolve expert by token (no spoofing via expert_id)
    const { data: expert, error: e1 } = await sb
      .from("experts")
      .select("id,photo_path")
      .eq("dashboard_token", token)
      .maybeSingle();

    if (e1) return res.status(500).json({ error: "DB error", details: e1.message });
    if (!expert) return res.status(403).json({ error: "Invalid token" });

    const { data: updated, error: e2 } = await sb
      .from("experts")
      .update({
        name: cleanName,
        presentation: cleanPresentation,
        updated_at: new Date().toISOString(),
      })
      .eq("id", expert.id)
      .select("id,name,presentation,photo_path")
      .single();

    if (e2) return res.status(500).json({ error: "Failed to update expert", details: e2.message });

    // Return signed url (nice UX: refresh header avatar)
    let photo_url = null;
    const path = updated?.photo_path || expert.photo_path;
    if (path) {
      const { data: signed, error: signErr } = await sb.storage
        .from("avatars")
        .createSignedUrl(path, 60 * 10);
      if (!signErr) photo_url = signed?.signedUrl || null;
    }

    return res.status(200).json({
      expert: {
        id: updated.id,
        name: updated.name ?? null,
        presentation: updated.presentation ?? null,
        photo_url,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unexpected server error", details: err?.message || String(err) });
  }
}
