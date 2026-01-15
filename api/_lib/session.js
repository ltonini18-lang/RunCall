// api/_lib/session.js
const { supabaseAdmin } = require("./supabase");

// Read token from header OR query (handy)
function getSessionToken(req) {
  const h =
    (req.headers["x-session-token"] || req.headers["x-runcall-token"] || "").toString().trim();
  if (h) return h;

  const q = (req.query && req.query.token ? String(req.query.token) : "").trim();
  return q || "";
}

async function resolveSession(req) {
  const token = getSessionToken(req);
  if (!token) return { ok: false, status: 401, error: "Missing session token" };

  const sb = supabaseAdmin();

  const { data: row, error } = await sb
    .from("sessions")
    .select("token, expert_id, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: "DB error", details: error.message };
  if (!row?.expert_id) return { ok: false, status: 403, error: "Invalid token" };

  // Expiration
  const exp = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (exp && exp < Date.now()) {
    return { ok: false, status: 403, error: "Token expired" };
  }

  return { ok: true, expert_id: String(row.expert_id) };
}

module.exports = { resolveSession, getSessionToken };
