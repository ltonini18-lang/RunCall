import { supabaseAdmin } from "../_lib/supabase";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const token = String(req.query.token || "").trim();
    if (!token) return res.status(400).json({ error: "Missing token" });

    const sb = supabaseAdmin();

    const { data: expert, error } = await sb
      .from("experts")
      .select("id,name,presentation,photo_path")
      .eq("dashboard_token", token)
      .maybeSingle();

    if (error) return res.status(500).json({ error: "DB error", details: error.message });
    if (!expert) return res.status(404).json({ error: "Invalid token" });

    let photo_url = null;
    if (expert.photo_path) {
      const { data: signed, error: signErr } = await sb.storage
        .from("avatars")
        .createSignedUrl(expert.photo_path, 60 * 10); // 10 min
      if (!signErr) photo_url = signed?.signedUrl || null;
    }

    return res.status(200).json({
      expert_id: expert.id,
      name: expert.name,
      presentation: expert.presentation,
      photo_url,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
