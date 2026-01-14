import { supabaseAdmin } from "../../_lib/supabase";

function getAuth(req) {
  const expert_id = String(req.query.expert_id || "").trim();
  const headerToken = req.headers["x-dashboard-token"];
  const queryToken = req.query.dashboard_token;
  const dashboard_token = String(headerToken || queryToken || "").trim();
  return { expert_id, dashboard_token };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { expert_id, dashboard_token } = getAuth(req);
    if (!expert_id) return res.status(400).json({ error: "Missing expert_id" });
    if (!dashboard_token) return res.status(401).json({ error: "Missing dashboard_token" });

    const sb = supabaseAdmin();

    const { data: expert, error: e1 } = await sb
      .from("experts")
      .select("id,dashboard_token,photo_path")
      .eq("id", expert_id)
      .maybeSingle();

    if (e1) return res.status(500).json({ error: "DB error", details: e1.message });
    if (!expert) return res.status(404).json({ error: "Expert not found" });
    if (expert.dashboard_token !== dashboard_token) return res.status(403).json({ error: "Invalid dashboard_token" });

    if (expert.photo_path) {
      const { error: rmErr } = await sb.storage.from("avatars").remove([expert.photo_path]);
      if (rmErr) return res.status(500).json({ error: "Remove error", details: rmErr.message });
    }

    const { error: upDbErr } = await sb
      .from("experts")
      .update({
        photo_path: null,
        photo_updated_at: new Date().toISOString(),
      })
      .eq("id", expert_id);

    if (upDbErr) return res.status(500).json({ error: "DB update error", details: upDbErr.message });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
