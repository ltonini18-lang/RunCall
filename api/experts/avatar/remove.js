import { supabaseAdmin } from "../../_lib/supabase";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const token = String(req.headers["x-dashboard-token"] || "").trim();
    if (!token) return res.status(401).json({ error: "Missing dashboard token" });

    const sb = supabaseAdmin();

    const { data: expert, error: e1 } = await sb
      .from("experts")
      .select("id,photo_path")
      .eq("dashboard_token", token)
      .maybeSingle();

    if (e1) return res.status(500).json({ error: "DB error", details: e1.message });
    if (!expert) return res.status(403).json({ error: "Invalid token" });

    if (expert.photo_path) {
      const { error: rmErr } = await sb.storage.from("avatars").remove([expert.photo_path]);
      if (rmErr) return res.status(500).json({ error: "Remove error", details: rmErr.message });
    }

    const { error: dbErr } = await sb
      .from("experts")
      .update({ photo_path: null, photo_updated_at: new Date().toISOString() })
      .eq("id", expert.id);

    if (dbErr) return res.status(500).json({ error: "DB update error", details: dbErr.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
