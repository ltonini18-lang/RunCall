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

async function createCalendarEventWithMeet({ accessToken, calendarId, booking, expertEmail }) {
  // Google Calendar API: insert event + conferenceData (Meet)
  const endpoint = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calendarId
  )}/events?conferenceDataVersion=1`;

  const startISO = new Date(booking.slot_start).toISOString();
  const endISO = new Date(booking.slot_end).toISOString();

  // IMPORTANT:
  // - DO NOT include "RunCall" in the summary, otherwise your slot parser might treat it as availability.
  // - Make it a normal busy event so it blocks future bookings.
  const summary = booking.user_name ? `Call with ${booking.user_name}` : "Call booked";

  const descriptionLines = [
    "RunCall booking confirmed.",
    "",
    booking.user_name ? `Client: ${booking.user_name}` : null,
    booking.user_email ? `Email: ${booking.user_email}` : null,
    booking.user_note ? `Note: ${booking.user_note}` : null,
    "",
    "Booked via RunCall.",
  ].filter(Boolean);

  const body = {
    summary,
    description: descriptionLines.join("\n"),
    start: { dateTime: startISO },
    end: { dateTime: endISO },

    // Make sure it blocks time on the calendar
    transparency: "opaque",

    // Add attendees so Google sends the invite & Meet link to both parties
    attendees: [
      booking.user_email ? { email: booking.user_email } : null,
      expertEmail ? { email: expertEmail } : null,
    ].filter(Boolean),

    // Creates a Google Meet
    conferenceData: {
      createRequest: {
        requestId: `runcall-${booking.id}-${Date.now()}`, // must be unique-ish
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

  const meetLink =
    d?.hangoutLink ||
    d?.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
    null;

  return { eventId: d.id, htmlLink: d.htmlLink || null, meetLink };
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

      if (!bookingId) {
        console.log("⚠️ checkout.session.completed missing booking_id metadata", {
          sessionId: session?.id,
        });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      const sb = supabaseAdmin();

      // 1) Load booking (need slot + expert)
      const { data: booking, error: bErr } = await sb
        .from("bookings")
        .select(
          "id,status,expert_id,slot_start,slot_end,timezone,user_name,user_email,user_note,source_calendar_id"
        )
        .eq("id", bookingId)
        .single();

      if (bErr || !booking) throw new Error("Booking not found in DB");

      // Idempotency: if already confirmed, do nothing
      if (booking.status === "confirmed") {
        console.log("ℹ️ Booking already confirmed", { bookingId });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      // 2) Load expert Google account (refresh_token, calendar_id)
      const { data: acct, error: aErr } = await sb
        .from("expert_google_accounts")
        .select("expert_id,refresh_token,calendar_id")
        .eq("expert_id", booking.expert_id)
        .single();

      if (aErr || !acct?.refresh_token) {
        throw new Error("Expert Google account not connected (missing refresh_token)");
      }

      // 3) Load expert email from experts table (more reliable than google userinfo)
      let expertEmail = null;
      try {
        const { data: expert, error: eErr } = await sb
          .from("experts")
          .select("email")
          .eq("id", booking.expert_id)
          .single();

        if (!eErr && expert?.email) expertEmail = expert.email;
      } catch (_) {
        // If experts table or email doesn't exist, we just won't add expert as attendee.
        expertEmail = null;
      }

      const calendarId = booking.source_calendar_id || acct.calendar_id || "primary";

      // 4) Get access token & create event with Meet
      const accessToken = await getGoogleAccessToken(acct.refresh_token);

      const { eventId, meetLink } = await createCalendarEventWithMeet({
        accessToken,
        calendarId,
        booking,
        expertEmail,
      });

      // 5) Update booking (store payment intent + meet link)
      // Note: session.payment_intent is available on Checkout session completed.
      const patch = {
        status: "confirmed",
        stripe_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent || null,
        google_calendar_id: calendarId,
        google_event_id: eventId,
        meet_link: meetLink,
        paid_at: new Date().toISOString(),
      };

      const { error: uErr } = await sb.from("bookings").update(patch).eq("id", bookingId);

      if (uErr) {
        console.error("Supabase update failed:", uErr);
        // We still don't want webhook to fail hard if Meet is created.
      }

      console.log("✅ Booking confirmed + event created", {
        bookingId,
        eventId,
        meetLink,
        expertEmail: expertEmail || null,
        paymentIntent: session.payment_intent || null,
      });
    }

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ received: true }));
  } catch (e) {
    console.error("❌ Webhook finalize error:", e?.message || e);

    // During testing: returning 200 avoids infinite retries.
    // When stable: you can switch to 500 to let Stripe retry transient failures.
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({ received: true, error: e?.message || "webhook error" })
    );
  }
};
