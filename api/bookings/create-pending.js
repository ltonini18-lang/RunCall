// /api/bookings/create-pending.js
const { supabaseAdmin } = require("../_lib/supabase");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const {
      expert_id,
      slot_start,
      slot_end,
      timezone,
      source_calendar_id = "primary",
      source_event_id = null,
      user_name,
      user_email,
      user_note = null
    } = body;

    if (!expert_id || !slot_start || !slot_end || !timezone || !user_name || !user_email) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Missing required fields" }));
    }

    const start = new Date(slot_start);
    const end = new Date(slot_end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Invalid slot_start/slot_end" }));
    }

    const minutes = (end - start) / 60000;
    if (minutes !== 30) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Slot must be 30 minutes" }));
    }

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("bookings")
      .insert({
        expert_id,
        source_calendar_id,
        source_event_id,
        slot_start: start.toISOString(),
        slot_end: end.toISOString(),
        timezone,
        user_name,
        user_email,
        user_note,
        status: "hold",
        expires_at: expiresAt
      })
      .select("id")
      .single();

    if (error) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: error.message }));
    }

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ booking_id: data.id }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: e?.message || "Server error" }));
  }
};
