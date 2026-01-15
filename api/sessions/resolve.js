// api/sessions/resolve.js
import { createClient } from "@supabase/supabase-js";

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return send(res, 405, { error: "Method not allowed" });
    }

    const token = String(req.query.token || "");
    if (!token) return send(res, 400, { error: "Missing token" });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !KEY) return send(res, 500, { error: "Missing Supabase env vars" });

    const supabase = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } });

    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("sessions")
      .select("expert_id, expires_at")
      .eq("token", token)
      .limit(1)
      .maybeSingle();

    if (error) return send(res, 500, { error: "Query failed", details: error });
    if (!data?.expert_id) return send(res, 401, { error: "Invalid token" });
    if (data.expires_at && data.expires_at <= nowIso) return send(res, 401, { error: "Token expired" });

    return send(res, 200, { expert_id: data.expert_id });
  } catch (e) {
    return send(res, 500, { error: "Unexpected error", details: String(e) });
  }
}
