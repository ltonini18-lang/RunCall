export default async function handler(req, res) {
  try {
    const expertId = String(req.query.expert_id || "").trim();
    if (!expertId) return res.status(400).json({ error: "Missing expert_id" });

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !KEY) {
      return res.status(500).json({ error: "Server not configured (Supabase env vars)" });
    }

    const url =
      `${SUPABASE_URL}/rest/v1/experts?` +
      `select=id,name,presentation,photo_url&` +
      `id=eq.${encodeURIComponent(expertId)}&limit=1`;

    const r = await fetch(url, {
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
      }
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({ error: "Supabase error", details: text });
    }

    const arr = JSON.parse(text || "[]");
    const row = arr[0];

    if (!row) return res.status(404).json({ error: "Expert not found" });

    return res.status(200).json({
      name: row.name,
      presentation: row.presentation,
      photo_url: row.photo_url || null
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
