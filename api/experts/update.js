// api/experts/update.js
const { supabaseAdmin } = require("../_lib/supabase");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { expert_id, name, presentation, photo_url } = req.body || {};
    if (!expert_id) {
      return res.status(400).json({ error: "Missing expert_id" });
    }

    const patch = { updated_at: new Date().toISOString() };

    if (typeof name === "string") patch.name = name.trim().slice(0, 80);
    if (typeof presentation === "string") patch.presentation = presentation.trim().slice(0, 600);

    // photo_url: accepte null pour effacer
    if (photo_url === null) patch.photo_url = null;
    else if (typeof photo_url === "string") patch.photo_url = photo_url.trim().slice(0, 400);

    const sb = supabaseAdmin(); // ✅ ton helper retourne un client

    const { data, error } = await sb
      .from("experts")
      .update(patch)
      .eq("id", expert_id)
      .select("id, name, presentation, photo_url")
      .single();

    if (error) {
      console.error("Supabase update error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ expert: data });
  } catch (e) {
    console.error("Update expert crash:", e);
    return res.status(500).json({ error: e.message || "Unknown error" });
  }
};
