// /api/stripe/webhook.js
const Stripe = require("stripe");
const { supabaseAdmin } = require("../_lib/supabase");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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

  // Always ACK Stripe quickly (but we still do work here; if it fails we log it and still return 200)
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      const bookingId = session?.metadata?.booking_id || null;
      const sessionId = session?.id || null;

      console.log("✅ checkout.session.completed", { sessionId, bookingId });

      if (!bookingId) {
        console.error("Missing booking_id in session.metadata");
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      const sb = supabaseAdmin();

      // 1) Mark booking as paid (idempotent: ok if already paid/confirmed)
      const { data: booking, error: readErr } = await sb
        .from("bookings")
        .select("id,status")
        .eq("id", bookingId)
        .single();

      if (readErr || !booking) {
        console.error("Booking not found in DB for webhook", { bookingId, readErr });
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ received: true }));
      }

      // Only update to paid if not already confirmed/paid
      if (booking.status !== "confirmed") {
        const { error: updErr } = await sb
          .from("bookings")
          .update({
            status: "paid",
            stripe_session_id: sessionId,
            paid_at: new Date().toISOString(),
          })
          .eq("id", bookingId);

        if (updErr) {
          console.error("Failed to update booking to paid", { bookingId, updErr });
          // continue anyway
        }
      }

      // 2) Confirm booking => create Google Calendar event + Meet (idempotent route)
      const BASE_URL = process.env.BASE_URL || "https://run-call.vercel.app";

      const confirmResp = await fetch(`${BASE_URL}/api/bookings/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ booking_id: bookingId }),
      });

      const confirmJson = await confirmResp.json().catch(() => ({}));

      if (!confirmResp.ok) {
        console.error("Confirm booking failed", {
          bookingId,
          status: confirmResp.status,
          confirmJson,
        });
        // IMPORTANT: still return 200 to Stripe (avoid retries storm)
      } else {
        console.log("✅ Booking confirmed + Meet created", {
          bookingId,
          meet_url: confirmJson?.meet_url,
          google_event_id: confirmJson?.google_event_id,
        });
      }
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
    // still ACK Stripe
  }

  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify({ received: true }));
};
