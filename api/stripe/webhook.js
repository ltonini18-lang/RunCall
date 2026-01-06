// /api/stripe/webhook.js
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const { supabaseAdmin } = require("../_lib/supabase");
const { getGoogleAccessToken } = require("../_lib/google");

// IMPORTANT for Stripe signature verification on Vercel
module.exports.config = { api: { bodyParser: false } };

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ✅ MODIF EXACTE ICI : normalise + valide RESEND_FROM (le problème venait de ça)
function normalizeFrom(fromRaw) {
  const from = String(fromRaw || "").trim();

  // enlever d'éventuels guillemets copiés/collés
  const cleaned = from.replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "").trim();

  // formats acceptés :
  // - email@example.com
  // - Name <email@example.com>
  const emailOnly = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
  const nameEmail = /^.+\s<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/;

  if (emailOnly.test(cleaned) || nameEmail.test(cleaned)) return cleaned;

  return null;
}

async function resendSend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromNormalized = normalizeFrom(process.env.RESEND_FROM);

  if (!apiKey || !fromNormalized) {
    console.log("⚠️ Email not sent: missing/invalid RESEND_API_KEY or RESEND_FROM", {
      hasKey: !!apiKey,
      resendFromRaw: process.env.RESEND_FROM || null,
      resendFromNormalized: fromNormalized,
    });
    return { skipped: true };
  }

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ from: fromNormalized, to, subject, html }),
  });

  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("❌ Resend error", d);
    throw new Error(d?.message || "Resend failed");
  }

  console.log("✅ Resend accepted", { id: d?.id || null, to });
  return d;
}

async function createCalendarEventWithMeet({ accessToken, calendarId, booking, expertEmail }) {
  // Google Calendar API: insert event + conferenceData (Meet)
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
    attendees: [
      booking.user_email ? { email: booking.user_email } : null,
      // Optionnel : mettre l'expert en attendee aussi (souvent inutile car c'est son calendrier),
      // mais ça peut aider à déclencher des emails chez certains comptes.
      expertEmail ? { email: expertEmail } : null,
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

  return { eventId: d.id, meetLink };
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
        console.log("⚠️ Missing booking_id metadata", { sessionId: session?.id });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      const sb = supabaseAdmin();

      // 1) Load booking
      const { data: booking, error: bErr } = await sb
        .from("bookings")
        .select(
          "id,status,expert_id,slot_start,slot_end,timezone,user_name,user_email,user_note,source_calendar_id,source_event_id,calendar_event_id,meet_link,stripe_payment_intent_id"
        )
        .eq("id", bookingId)
        .single();

      if (bErr || !booking) throw new Error("Booking not found in DB");

      // Idempotency: if already confirmed, do nothing
      if (booking.status === "confirmed" && booking.meet_link && booking.stripe_payment_intent_id) {
        console.log("ℹ️ Booking already confirmed (idempotent)", { bookingId });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      // 2) Load expert email + google account
      // NOTE: bookings.expert_id est TEXT chez toi, experts.id est UUID.
      // Ça marche si bookings.expert_id contient bien une string UUID.
      const { data: expert, error: eErr } = await sb
        .from("experts")
        .select("id,name,email")
        .eq("id", booking.expert_id)
        .single();

      if (eErr || !expert) throw new Error("Expert not found in DB (experts table)");

      const { data: acct, error: aErr } = await sb
        .from("expert_google_accounts")
        .select("expert_id,refresh_token,calendar_id,google_email")
        .eq("expert_id", expert.id)
        .single();

      if (aErr || !acct?.refresh_token) {
        throw new Error("Expert Google account not connected (missing refresh_token)");
      }

      const calendarId = booking.source_calendar_id || acct.calendar_id || "primary";

      // 3) Create Google Calendar event + Meet link
      const accessToken = await getGoogleAccessToken(acct.refresh_token);

      const { eventId, meetLink } = await createCalendarEventWithMeet({
        accessToken,
        calendarId,
        booking,
        expertEmail: expert.email || acct.google_email || null,
      });

      // 4) Update booking (COLONNES EXACTES de ton schéma)
      const { error: updErr } = await sb
        .from("bookings")
        .update({
          status: "confirmed",
          confirmed_at: new Date().toISOString(),
          stripe_session_id: session.id,
          stripe_payment_intent_id: paymentIntentId || booking.stripe_payment_intent_id || null,
          meet_link: meetLink,
          calendar_event_id: eventId,
          error: null,
        })
        .eq("id", bookingId);

      if (updErr) {
        console.error("❌ Supabase update failed:", updErr);
      } else {
        console.log("✅ Booking updated confirmed", { bookingId });
      }

      // 5) Email expert (RunCall)
      const start = new Date(booking.slot_start);
      const end = new Date(booking.slot_end);

      const subject = "RunCall — New booking confirmed ✅";
      const html = `
        <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;">
          <h2 style="margin:0 0 10px;">New booking confirmed ✅</h2>

          <p style="margin:0 0 10px;color:#334155;">
            Expert: <b>${esc(expert.name)}</b><br/>
            Client: <b>${esc(booking.user_name)}</b> (${esc(booking.user_email)})
          </p>

          <p style="margin:0 0 12px;color:#334155;">
            When: <b>${esc(start.toString())}</b> → <b>${esc(end.toString())}</b><br/>
            Timezone: <b>${esc(booking.timezone)}</b>
          </p>

          <p style="margin:0 0 12px;">
            Google Meet:<br/>
            <a href="${meetLink || "#"}" style="font-weight:700;">${esc(meetLink || "")}</a>
          </p>

          ${
            booking.user_note
              ? `<p style="margin:0 0 12px;color:#475569;"><b>Client note:</b><br/>${esc(
                  booking.user_note
                )}</p>`
              : ""
          }

          <p style="margin-top:18px;color:#64748b;font-size:12px;">
            Booking ID: ${esc(bookingId)}<br/>
            Calendar event ID: ${esc(eventId)}
          </p>
        </div>
      `;

      await resendSend({ to: expert.email, subject, html });
      console.log("✅ Expert email sent", { bookingId, expertEmail: expert.email });

      console.log("✅ Booking confirmed + event created", { bookingId, eventId, meetLink });
    }

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ received: true }));
  } catch (e) {
    console.error("❌ Webhook finalize error:", e?.message || e);
    // On répond 200 pour éviter des retries infinis pendant les tests
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ received: true, error: e?.message || "webhook error" }));
  }
};
