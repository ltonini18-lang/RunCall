// /api/experts/update.js
// Receives: { expert_id, name, presentation, photo_url? }
// Requires header: x-dashboard-token
// Returns: { expert: { id, name, presentation, photo_url } }

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = new Set([
    "https://www.run-call.com",
    "https://run-call.com",
    "https://preview.run-call.com"
  ]);

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-dashboard-token");
}


export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !KEY) {
      return res.status(500).json({ error: "Server not configured" });
    }

    // ✅ Require dashboard token (same as avatar upload/session flow)
    const dashboardToken = String(req.headers["x-dashboard-token"] || "").trim();
    if (!dashboardToken) {
      return res.status(401).json({ error: "Missing dashboard token" });
    }

    const { expert_id, name, presentation, photo_url } = req.body || {};

    const expertId = String(expert_id || "").trim();
    if (!expertId) {
      return res.status(400).json({ error: "Missing expert_id" });
    }

    const cleanName = typeof name === "string" ? name.trim() : "";
    const cleanPresentation = typeof presentation === "string" ? presentation.trim() : "";

    // photo_url can be: string | null | undefined
    let cleanPhotoUrl = undefined;
    if (photo_url === null) cleanPhotoUrl = null;
    else if (typeof photo_url === "string") cleanPhotoUrl = photo_url.trim();

    if (!cleanName || !cleanPresentation) {
      return res.status(400).json({ error: "Missing required fields (name, presentation)" });
    }

    if (cleanName.length > 120) {
      return res.status(400).json({ error: "Name too long" });
    }
    if (cleanPresentation.length > 3000) {
      return res.status(400).json({ error: "Presentation too long" });
    }
    if (typeof cleanPhotoUrl === "string" && cleanPhotoUrl.length > 800) {
      return res.status(400).json({ error: "Photo URL too long" });
    }

    // ✅ Resolve expert via dashboard_token to prevent arbitrary updates
    const sessionResp = await fetch(
      `${SUPABASE_URL}/rest/v1/experts?select=id&dashboard_token=eq.${encodeURIComponent(dashboardToken)}&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          Accept: "application/json"
        }
      }
    );

    const sessionText = await sessionResp.text();
    let sessionData;
    try { sessionData = JSON.parse(sessionText || "[]"); } catch { sessionData = null; }

    if (!sessionResp.ok) {
      return res.status(500).json({ error: "Failed to verify session", details: sessionText });
    }

    const sessionRow = Array.isArray(sessionData) ? sessionData[0] : null;
    if (!sessionRow?.id) {
      return res.status(403).json({ error: "Invalid dashboard token" });
    }

    if (String(sessionRow.id) !== expertId) {
      return res.status(403).json({ error: "Token does not match expert_id" });
    }

    const patch = {
      name: cleanName,
      presentation: cleanPresentation,
      updated_at: new Date().toISOString()
    };

    // only set photo_url if provided (string or null)
    if (cleanPhotoUrl !== undefined) {
      patch.photo_url = cleanPhotoUrl || null;
    }

    // Supabase REST update: PATCH /rest/v1/experts?id=eq.<id>
    const updateResp = await fetch(
      `${SUPABASE_URL}/rest/v1/experts?id=eq.${encodeURIComponent(expertId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          Prefer: "return=representation"
        },
        body: JSON.stringify(patch)
      }
    );

    const text = await updateResp.text();
    let data;
    try { data = JSON.parse(text || "[]"); } catch { data = null; }

    if (!updateResp.ok) {
      return res.status(500).json({ error: "Failed to update expert", details: text });
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return res.status(500).json({ error: "No expert returned from DB" });
    }

    return res.status(200).json({
      expert: {
        id: row.id,
        name: row.name ?? null,
        presentation: row.presentation ?? null,
        photo_url: row.photo_url ?? null
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unexpected server error", details: err?.message || String(err) });
  }
}
