// api/experts/update.js
const { supabaseAdmin } = require("../_lib/supabase");
const { resolveSession } = require("../_lib/session");

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = new Set([
    "https://www.run-call.com",
    "https://run-call.com",
    "https://preview.run-call.com"
  ]);
  if (allowed.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-runcall-token");
}


export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const r = await resolveSession(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error, details: r.details });

    const { name, presentation, photo_url } = req.body || {};

    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanPresentation = typeof presentation === "string" ? presentation.trim() : "";

    let cleanPhotoUrl = undefined;
    if (photo_url === null) cleanPhotoUrl = null;
    else if (typeof photo_url === "string") cleanPhotoUrl = photo_url.trim();

    if (!cleanName || !cleanPresentation) {
      return res.status(400).json({ error: "Missing required fields (name, presentation)" });
    }
    if (cleanName.length > 120) return res.status(400).json({ error: "Name too long" });
    if (cleanPresentation.length > 3000) return res.status(400).json({ error: "Presentation too long" });
    if (typeof cleanPhotoUrl === "string" && cleanPhotoUrl.length > 800) {
      return res.status(400).json({ error: "Photo URL too long" });
    }

    const sb = supabaseAdmin();

    const patch = {
      name: cleanName,
      presentation: cleanPresentation,
      updated_at: new Date().toISOString()
    };
    if (cleanPhotoUrl !== undefined) patch.photo_url = cleanPhotoUrl || null;

    const { data, error } = await sb
      .from("experts")
      .update(patch)
      .eq("id", r.expert_id)
      .select("id,name,presentation,photo_url,photo_path")
      .single();

    if (error) return res.status(500).json({ error: "DB error", details: error.message });

    return res.status(200).json({
      expert: {
        id: data.id,
        name: data.name ?? null,
        presentation: data.presentation ?? null,
        photo_url: data.photo_url ?? null,
        photo_path: data.photo_path ?? null
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Unexpected server error", details: e?.message || String(e) });
  }
}
