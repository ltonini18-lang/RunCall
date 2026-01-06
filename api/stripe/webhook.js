// /api/stripe/webhook.js
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const { supabaseAdmin } = require("../_lib/supabase");
const { getGoogleAccessToken } = require("../_lib/google");

// Needed on Vercel for Stripe signature verification
module.exports.config = {
  api: { bodyParser: false }
};

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function sendResendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM;

  if (!apiKey || !from) {
    console.log("⚠️ Email not sent: missing RESEND_API_KEY or RESEND_FROM");
    return { skipped: true };
  }

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
    }),
  });

  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("❌ Resend error:", d);
    throw new Error(d?.message || "Resend failed");
  }
  return d;
}

async function createCalendarEventWithMeet({ accessToken, calendarId, booking, expertEmail }) {
  const endpoint = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calendarId
  )}/events?conferenceDataVersion=1`;

  const startISO = new Date(booking.slot_start).toISOString();
  const endISO = new Date(booking.slot_end).toISOString();

  const summary = booking.user_name ? `RunCall — ${booking.user_name}` : "RunCall — Booking";

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

    // IMPORTANT:
    // Google often doesn't "email the organizer" (the calendar owner).
    // We still include the client as attendee so they receive the invite.
    attendees: [
      booking.user_email ? { email: booking.user_email } : null,
    ].filter(Boolean),

    conferenceData: {
      createRequest: {
        requestId: `runcall-${booking.id}-${Date.now()}`,
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
      const paymentIntentId = session?.payment_intent || null;

      if (!bookingId) {
        console.log("⚠️ Missing booking_id in metadata", { sessionId: session?.id });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      const sb = supabaseAdmin();

      // 1) Load booking
      const { data: booking, error: bErr } = await sb
        .from("bookings")
        .select("id,status,expert_id,slot_start,slot_end,timezone,user_name,user_email,user_note,source_calendar_id,meet_link,stripe_payment_intent_id")
        .eq("id", bookingId)
        .single();

      if (bErr || !booking) throw new Error("Booking not found in DB");

      // Idempotency: if already confirmed AND has meet_link + payment_intent, do nothing
      if (booking.status === "confirmed" && booking.meet_link && booking.stripe_payment_intent_id) {
        console.log("ℹ️ Booking already confirmed (idempotent)", { bookingId });
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

      // 3) Load expert email from experts table (THIS is what we'll use to email the expert)
      const { data: expert, error: eErr } = await sb
        .from("experts")
        .select("email,name")
        .eq("id", booking.expert_id)
        .single();

      const expertEmail = expert?.email || acct.google_email || null;
      const expertName = expert?.name || "RunCall expert";

      const calendarId = booking.source_calendar_id || acct.calendar_id || "primary";

      // 4) Create event with Meet
      const accessToken = await getGoogleAccessToken(acct.refresh_token);

      const { eventId, meetLink } = await createCalendarEventWithMeet({
        accessToken,
        calendarId,
        booking,
        expertEmail,
      });

      // 5) Update booking in DB
      const updatePayload = {
        status: "confirmed",
        stripe_session_id: session.id,
        stripe_payment_intent_id: paymentIntentId || booking.stripe_payment_intent_id || null,
        google_calendar_id: calendarId,
        google_event_id: eventId,
        meet_link: meetLink,
        paid_at: new Date().toISOString(),
      };

      const { error: uErr } = await sb
        .from("bookings")
        .update(updatePayload)
        .eq("id", bookingId);

      if (uErr) {
        console.error("Supabase update failed:", uErr);
        // We still proceed (Meet already created)
      }

      // 6) Email the expert ourselves (solves your "expert gets nothing" issue)
      if (expertEmail) {
        const start = new Date(booking.slot_start);
        const end = new Date(booking.slot_end);

        const subject =
          `RunCall — New booking confirmed (${start.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })})`;

        const html = `
          <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;">
            <h2 style="margin:0 0 10px;">New RunCall booking confirmed ✅</h2>
            <p style="margin:0 0 10px;color:#334155;">
              Expert: <b>${escapeHtml(expertName)}</b><br/>
              Client: <b>${escapeHtml(booking.user_name || "")}</b> (${escapeHtml(booking.user_email || "")})
            </p>

            <p style="margin:0 0 12px;color:#334155;">
              When: <b>${escapeHtml(start.toString())}</b> → <b>${escapeHtml(end.toString())}</b><br/>
              Timezone: <b>${escapeHtml(booking.timezone || "")}</b>
            </p>

            <p style="margin:0 0 12px;">
              Google Meet link:<br/>
              <a href="${meetLink || "#"}" style="font-weight:700;">${meetLink || "Meet link unavailable"}</a>
            </p>

            ${
              booking.user_note
                ? `<p style="margin:0 0 12px;color:#475569;"><b>Client note:</b><br/>${escapeHtml(booking.user_note)}</p>`
                : ""
            }

            <p style="margin-top:18px;color:#64748b;font-size:12px;">
              Booking ID: ${escapeHtml(bookingId)}<br/>
              Payment Intent: ${escapeHtml(paymentIntentId || "")}
            </p>
          </div>
        `;

        try {
          await sendResendEmail({
            to: expertEmail,
            subject,
            html,
          });
          console.log("✅ Expert email sent", { bookingId, expertEmail });
        } catch (mailErr) {
          console.error("❌ Failed to send expert email:", mailErr?.message || mailErr);
        }
      } else {
        console.log("⚠️ No expert email found; skipping email", { bookingId });
      }

      console.log("✅ Booking confirmed + event created", { bookingId, eventId, meetLink });
    }

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ received: true }));
  } catch (e) {
    console.error("❌ Webhook finalize error:", e?.message || e);

    // Return 200 to avoid endless retries while you're iterating.
    // Once stable, you can switch to 500 for true retry behavior.
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ received: true, error: e?.message || "webhook error" }));
  }
};

// tiny helper to avoid breaking HTML emails
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
