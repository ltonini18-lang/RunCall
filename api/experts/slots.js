export default async function handler(req, res) {
  try {
    const expertId = String(req.query.expert_id || "").trim();
    if (!expertId) return res.status(400).json({ error: "Missing expert_id" });

    // Fake slots (30 minutes) for UI testing
    const now = new Date();
    now.setMinutes(0, 0, 0);

    const slots = [];
    for (let i = 0; i < 12; i++) {
      const start = new Date(now);
      start.setHours(now.getHours() + 1 + i);

      const end = new Date(start);
      end.setMinutes(start.getMinutes() + 30);

      slots.push({ start: start.toISOString(), end: end.toISOString() });
    }

    return res.status(200).json({ slots });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
