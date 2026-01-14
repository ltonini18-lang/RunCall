import { supabaseAdmin } from "../_lib/supabase";

export default async function handler(req, res) {
  try {
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

    // Public page: soit tu ne renvoies rien (privacy), soit tu renvoies une signed URL courte
    // Ici je renvoie une signed URL si photo_path existe.
    let photo_url = null;
    if (row.photo_path) {
      const { data: signed, error: signErr } = await sb.storage
        .from("avatars")
        .createSignedUrl(row.photo_path, 60 * 10); // 10 min
      if (!signErr) photo_url = signed?.signedUrl || null;
    }

    return res.status(200).json({
      name: row.name,
      presentation: row.presentation,
      photo_url,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
