// /api/stripe/webhook.js
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const { supabaseAdmin } = require("../_lib/supabase");
const { getGoogleAccessToken } = require("../_lib/google");

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractMeetLink(eventResponse) {
  // Most common
  if (eventResponse?.hangoutLink) return eventResponse.hangoutLink;

  // Sometimes inside conferenceData.entryPoints
  const ep = eventResponse?.conferenceData?.entryPoints;
  if (Array.isArray(ep)) {
    const video = ep.find((e) => e.entryPointType === "video" && e.uri);
    if (video?.uri) return video.uri;
  }

  return null;
}

async function createCalendarEventWithMeet({
  accessToken,
  calendarId,
  booking,
  attendeeEmails = [],
}) {
  // IMPORTANT: sendUpdates=all => sends email invites to attendees
  // conferenceDataVersion=1 => allow Meet creation
  const endpoint =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      calendarId
    )}/events?conferenceDataVersion=1&sendUpdates=all`;

  const startISO = new Date(booking.slot_start).toISOString();
  const endISO = new Date(booking.slot_end).toISOString();

  const summary = booking.user_name
    ? `RunCall — ${booking.user_name}`
    : "RunCall — Booking";

  const descriptionLines = [
    "RunCall booking confirmed.",
    "",
    booking.user_name ? `Client: ${booking.user_name}` : null,
    booking.user_email ? `Email: ${booking.user_email}` : null,
    booking.user_note ? `Note: ${booking.user_note}` : null,
    "",
    "Booked via RunCall.",
  ].filter(Boolean);

  const attendees = attendeeEmails
    .filter(Boolean)
    .map((email) => ({ email }));

  const body = {
    summary,
    description: descriptionLines.join("\n"),
    start: { dateTime: startISO },
    end: { dateTime: endISO },
    attendees,
    // Creates a Google Meet
    conferenceData: {
      createRequest: {
        requestId: `runcall-${booking.id}-${Date.now()}`, // unique-ish
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  const r = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const d = await r.json();
  if (!r.ok) {
    throw new Error(d?.error?.message || "Failed to create Google Calendar event");
  }

  const meetLink = extractMeetLink(d);

  return {
    eventId: d.id,
    htmlLink: d.htmlLink || null,
    meetLink,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method not allowed");
  }

  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    res.statusCode = 400;
    return res.end(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const bookingId = session?.metadata?.booking_id || null;
      const paymentIntentId = session?.payment_intent || null;

      if (!bookingId) {
        console.log("⚠️ checkout.session.completed missing booking_id", {
          sessionId: session?.id,
        });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      const sb = supabaseAdmin();

      // 1) Load booking
      const { data: booking, error: bErr } = await sb
        .from("bookings")
        .select(
          "id,status,expert_id,slot_start,slot_end,timezone,user_name,user_email,user_note,source_calendar_id"
        )
        .eq("id", bookingId)
        .single();

      if (bErr || !booking) throw new Error("Booking not found in DB");

      // Idempotency
      if (booking.status === "confirmed") {
        console.log("ℹ️ Booking already confirmed", { bookingId });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      // 2) Load expert Google account
      const { data: acct, error: aErr } = await sb
        .from("expert_google_accounts")
        .select("expert_id,refresh_token,calendar_id,google_email")
        .eq("expert_id", booking.expert_id)
        .single();

      if (aErr || !acct?.refresh_token) {
        throw new Error("Expert Google account not connected (missing refresh_token)");
      }

      // 3) Load expert "contact" email from experts table (for notification)
      let expertContactEmail = null;
      try {
        const { data: expertRow } = await sb
          .from("experts")
          .select("email")
          .eq("id", booking.expert_id)
          .single();
        expertContactEmail = expertRow?.email || null;
      } catch {
        // optional
      }

      const calendarId = booking.source_calendar_id || acct.calendar_id || "primary";

      // Attendees we want to notify:
      // - client email
      // - expert google email (may not receive email because organizer)
      // - expert contact email (if different, it WILL receive invite email)
      const attendeeEmails = new Set();
      if (booking.user_email) attendeeEmails.add(booking.user_email);
      if (acct.google_email) attendeeEmails.add(acct.google_email);
      if (expertContactEmail) attendeeEmails.add(expertContactEmail);

      // 4) Create Meet event
      const accessToken = await getGoogleAccessToken(acct.refresh_token);

      const { eventId, meetLink, htmlLink } = await createCalendarEventWithMeet({
        accessToken,
        calendarId,
        booking,
        attendeeEmails: Array.from(attendeeEmails),
      });

      // 5) Update booking in DB (fill missing columns)
      const { error: uErr } = await sb
        .from("bookings")
        .update({
          status: "confirmed",
          stripe_session_id: session.id,
          stripe_payment_intent_id: paymentIntentId,
          google_calendar_id: calendarId,
          google_event_id: eventId,
          meet_link: meetLink,
          google_event_link: htmlLink,
          paid_at: new Date().toISOString(),
        })
        .eq("id", bookingId);

      if (uErr) {
        console.error("Supabase update failed:", uErr);
        // We still return 200 because the calendar event was created.
      }

      console.log("✅ Booking confirmed + event created", {
        bookingId,
        eventId,
        meetLink,
        paymentIntentId,
        notified: Array.from(attendeeEmails),
      });
    }

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ received: true }));
  } catch (e) {
    console.error("❌ Webhook finalize error:", e?.message || e);

    // In prod you usually want Stripe retries -> 500.
    // But if you're still in heavy testing, you can keep 200.
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ received: false, error: e?.message || "webhook error" }));
  }
};
