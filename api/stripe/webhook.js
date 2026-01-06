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
  // FORCE email invites
  const endpoint =
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}` +
    `/events?conferenceDataVersion=1&sendUpdates=all`;

  const startISO = new Date(booking.slot_start).toISOString();
  const endISO = new Date(booking.slot_end).toISOString();

  // DO NOT include "RunCall" here (otherwise you re-create "availability" by mistake)
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

  const attendees = [
    booking.user_email ? { email: booking.user_email } : null,
    expertEmail ? { email: expertEmail } : null,
  ].filter(Boolean);

  const body = {
    summary,
    description: descriptionLines.join("\n"),
    start: { dateTime: startISO },
    end: { dateTime: endISO },
    transparency: "opaque",
    attendees,
    conferenceData: {
      createRequest: {
        requestId: `runcall-${booking.id}-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  console.log("📅 Creating calendar event", {
    calendarId,
    bookingId: booking.id,
    attendees: attendees.map((a) => a.email),
  });

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
    console.error("❌ Google Calendar create failed", { status: r.status, d });
    throw new Error(d?.error?.message || "Failed to create Google Calendar event");
  }

  const meetLink =
    d?.hangoutLink ||
    d?.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ||
    null;

  console.log("✅ Calendar event created", {
    eventId: d.id,
    meetLink,
    htmlLink: d.htmlLink || null,
    attendees: (d.attendees || []).map((a) => a.email),
  });

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

      console.log("🔔 checkout.session.completed", {
        sessionId: session?.id,
        bookingId,
        paymentIntent: session?.payment_intent || null,
      });

      if (!bookingId) {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      const sb = supabaseAdmin();

      // 1) Load booking
      const { data: booking, error: bErr } = await sb
        .from("bookings")
        .select("id,status,expert_id,slot_start,slot_end,timezone,user_name,user_email,user_note,source_calendar_id")
        .eq("id", bookingId)
        .single();

      if (bErr || !booking) throw new Error("Booking not found in DB");

      if (booking.status === "confirmed") {
        console.log("ℹ️ Booking already confirmed", { bookingId });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      // 2) Load expert Google account
      const { data: acct, error: aErr } = await sb
        .from("expert_google_accounts")
        .select("expert_id,refresh_token,calendar_id")
        .eq("expert_id", booking.expert_id)
        .single();

      if (aErr || !acct?.refresh_token) {
        throw new Error("Expert Google account not connected (missing refresh_token)");
      }

      // 3) Load expert email from experts table
      const { data: expert, error: eErr } = await sb
        .from("experts")
        .select("email")
        .eq("id", booking.expert_id)
        .single();

      const expertEmail = (!eErr && expert?.email) ? expert.email : null;

      console.log("👤 Expert email lookup", {
        expertId: booking.expert_id,
        expertEmail,
        expertsErr: eErr ? (eErr.message || eErr) : null,
      });

      const calendarId = booking.source_calendar_id || acct.calendar_id || "primary";

      // 4) Create event
      const accessToken = await getGoogleAccessToken(acct.refresh_token);

      const { eventId, meetLink } = await createCalendarEventWithMeet({
        accessToken,
        calendarId,
        booking,
        expertEmail,
      });

      // 5) Update booking (try full patch, then fallback minimal patch)
      const fullPatch = {
        status: "confirmed",
        stripe_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent || null,
        google_calendar_id: calendarId,
        google_event_id: eventId,
        meet_link: meetLink,
        paid_at: new Date().toISOString(),
      };

      console.log("🧾 Updating booking with patch keys", {
        bookingId,
        keys: Object.keys(fullPatch),
      });

      let { error: uErr } = await sb.from("bookings").update(fullPatch).eq("id", bookingId);

      if (uErr) {
        console.error("❌ Supabase update failed (fullPatch):", uErr);

        const minimalPatch = {
          status: "confirmed",
          stripe_session_id: session.id,
        };

        console.log("🧾 Retrying booking update with minimal patch", {
          bookingId,
          keys: Object.keys(minimalPatch),
        });

        const retry = await sb.from("bookings").update(minimalPatch).eq("id", bookingId);

        if (retry.error) {
          console.error("❌ Supabase update failed (minimalPatch):", retry.error);
        } else {
          console.log("✅ Supabase update succeeded with minimalPatch", { bookingId });
        }
      } else {
        console.log("✅ Supabase update succeeded (fullPatch)", { bookingId });
      }

      console.log("✅ Booking confirmed + event created", { bookingId, eventId, meetLink });
    }

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ received: true }));
  } catch (e) {
    console.error("❌ Webhook finalize error:", e?.message || e);
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ received: true, error: e?.message || "webhook error" }));
  }
};
