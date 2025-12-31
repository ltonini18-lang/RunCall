// /api/experts/create.js
// Vercel Serverless Function (Node)
// Receives: { name, email, presentation, source }
// Returns: { expert_id }

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://run-call.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isValidEmail(email) {
  // Simple but solid-enough validation
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    const { name, email, presentation, source } = req.body || {};

    const cleanName = String(name || "").trim();
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanPresentation = String(presentation || "").trim();
    const cleanSource = String(source || "v2_onboarding").trim();

    if (!cleanName || !cleanEmail || !cleanPresentation) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ error: "Invalid email" });
    }

    // Optional guardrails: avoid huge payloads
    if (cleanName.length > 120) {
      return res.status(400).json({ error: "Name too long" });
    }
    if (cleanPresentation.length > 3000) {
      return res.status(400).json({ error: "Presentation too long" });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Server not configured" });
    }

    // Insert row via Supabase REST API
    // We use service role key so we don’t need anon keys/RLS during MVP.
    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/experts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Prefer": "return=representation"
      },
      body: JSON.stringify([
        {
          name: cleanName,
          email: cleanEmail,
          presentation: cleanPresentation,
          source: cleanSource,
          status: "draft"
        }
      ])
    });

    const text = await insertResp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!insertResp.ok) {
      // Supabase error payload can be in text; return a clean message
      return res.status(500).json({ error: "Failed to create expert" });
    }

    const expertId = data && data[0] && data[0].id;
    if (!expertId) {
      return res.status(500).json({ error: "Missing expert_id from DB" });
    }

    return res.status(200).json({ expert_id: expertId });

  } catch (err) {
    return res.status(500).json({ error: "Unexpected server error" });
  }
}
