// api/sessions/create.js
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return json(res, 405, { error: "Method not allowed" });
    }

    const expert_id = req.query.expert_id;
    if (!expert_id) return json(res, 400, { error: "Missing expert_id" });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json(res, 500, {
        error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var",
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Generate a strong random token
    const token =
      (crypto.randomUUID && crypto.randomUUID()) ||
      crypto.randomBytes(32).toString("hex");

    // 30 days expiry (adjust if you want)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabase.from("sessions").insert([
      {
        token,
        expert_id,
        expires_at: expiresAt,
      },
    ]);

    if (error) {
      return json(res, 500, { error: "Supabase insert failed", details: error });
    }

    return json(res, 200, { token, expires_at: expiresAt });
  } catch (e) {
    return json(res, 500, { error: "Unexpected error", details: String(e) });
  }
}
