// /api/bookings/confirm.js
import { createClient } from "@supabase/supabase-js";

function supabaseAdmin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!r.ok) throw new Error("Failed to refresh Google token");
  return r.json();
}

async function createGoogleMeetEvent({ accessToken, calendarId, booking }) {
  // Create a Calendar event with Google Meet conference
  const requestId = `runcall-${booking.id}`; // must be unique-ish

  const payload = {
    summary: `RunCall • ${booking.user_name || "Booking"}`,
    description:
      `RunCall booking\n\n` +
      `Client: ${booking.user_name || ""}\n` +
      `Email: ${booking.user_email || ""}\n` +
      (booking.user_note ? `Note: ${booking.user_note}\n` : "") +
      `\nBooking ID: ${booking.id}`,
    start: { dateTime: booking.slot_start, timeZone: booking.timezone || "UTC" },
    end: { dateTime: booking.slot_end, timeZone: booking.timezone || "UTC" },
    attendees: booking.user_email ? [{ email: booking.user_email }] : [],
    conferenceData: {
      createRequest: {
        requestId,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  const url =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
    `?conferenceDataVersion=1&sendUpdates=all`;

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }

  if (!r.ok) {
    const msg = data?.error?.message || text || "Google Calendar event create failed";
    throw new Error(msg);
  }
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { booking_id, force } = req.body || {};
    if (!booking_id) return res.status(400).json({ error: "Missing booking_id" });

    const sb = supabaseAdmin();

    // 1) booking
    const { data: booking, error: bErr } = await sb
      .from("bookings")
      .select("*")
      .eq("id", booking_id)
      .single();
    if (bErr || !booking) return res.status(404).json({ error: "Booking not found" });

    // If not paid, block unless force=true
    if (!force && booking.status !== "paid") {
      return res.status(400).json({ error: `Booking not paid (status=${booking.status})` });
    }

    // Already confirmed => idempotent
    if (booking.status === "confirmed" && booking.meet_url) {
      return res.json({ ok: true, already_confirmed: true, meet_url: booking.meet_url });
    }

    // 2) expert google account (tokens + calendar_id)
    const { data: ga, error: gaErr } = await sb
      .from("expert_google_accounts")
      .select("*")
      .eq("expert_id", booking.expert_id)
      .eq("provider", "google")
      .single();
    if (gaErr || !ga) return res.status(400).json({ error: "Expert Google account not connected" });

    // 3) refresh token -> access token
    if (!ga.refresh_token) return res.status(400).json({ error: "Missing refresh_token for expert" });

    const token = await refreshAccessToken(ga.refresh_token);
    const accessToken = token.access_token;

    // Pick calendar to write into (default primary)
    const calendarId = ga.calendar_id || "primary";

    // 4) create event with Meet
    const event = await createGoogleMeetEvent({
      accessToken,
      calendarId,
      booking,
    });

    const meetUrl =
      event?.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
      event?.hangoutLink ||
      null;

    // 5) persist
    const { error: upErr } = await sb
      .from("bookings")
      .update({
        status: "confirmed",
        confirmed_at: new Date().toISOString(),
        google_calendar_id: calendarId,
        google_event_id: event.id || null,
        meet_url: meetUrl,
      })
      .eq("id", booking.id);

    if (upErr) throw new Error("Failed to update booking as confirmed");

    return res.json({
      ok: true,
      booking_id: booking.id,
      google_event_id: event.id,
      meet_url: meetUrl,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Server error" });
  }
}
