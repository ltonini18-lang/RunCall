export default async function handler(req, res) {
  try {
    const expertIdRaw = req.query.expert_id;

    if (!expertIdRaw) {
      return res.status(400).json({
        error: "Missing expert_id",
        received_query: req.query
      });
    }

    const expertId = String(expertIdRaw).trim();

    if (!expertId) {
      return res.status(400).json({
        error: "Empty expert_id",
        received_query: req.query
      });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !KEY) {
      return res.status(500).json({ error: "Server not configured (Supabase env vars)" });
    }

    // ✅ Include photo_url + return full expert row
    const url =
      `${SUPABASE_URL}/rest/v1/experts?` +
      `select=id,name,presentation,photo_url,auth_user_id&` +
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

    // ✅ Consistent shape with dashboard expectations
    return res.status(200).json({
      expert: {
        id: row.id,
        name: row.name ?? null,
        presentation: row.presentation ?? null,
        photo_url: row.photo_url ?? null,
        auth_user_id: row.auth_user_id ?? null
      }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
