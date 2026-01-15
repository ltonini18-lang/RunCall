// api/sessions/resolve.js
const { resolveSession } = require("../_lib/session");

function setCors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = new Set([
    "https://www.run-call.com",
    "https://run-call.com",
    "https://preview.run-call.com"
  ]);
  if (allowed.has(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-session-token, x-runcall-token");
}

export default async function handler(req, res) {
  try {
    setCors(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const r = await resolveSession(req);
    if (!r.ok) return res.status(r.status).json({ error: r.error, details: r.details });

    return res.status(200).json({ expert_id: r.expert_id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
