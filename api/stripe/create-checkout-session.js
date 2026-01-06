// /api/stripe/create-checkout-session.js
const Stripe = require("stripe");
const { supabaseAdmin } = require("../_lib/supabase");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Prefer env BASE_URL, fallback to prod
const BASE_URL = process.env.BASE_URL || "https://run-call.vercel.app";

const PRICE_MAP = {
  29: { amount: 2900, label: "RunCall support" },
  49: { amount: 4900, label: "RunCall support" },
  79: { amount: 7900, label: "RunCall support" },
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const booking_id = body.booking_id;
    const tier = Number(body.price_tier);

    if (!booking_id || !PRICE_MAP[tier]) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Invalid booking_id or price_tier" }));
    }

    const sb = supabaseAdmin();

    // 1) Load booking (added expert_id for metadata/debug)
    const { data: booking, error: readErr } = await sb
      .from("bookings")
      .select("id,expert_id,status,expires_at,user_email")
      .eq("id", booking_id)
      .single();

    if (readErr || !booking) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "Booking not found" }));
    }

    // 2) Validate status & expiry
    const expiresAt = new Date(booking.expires_at).getTime();
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      res.statusCode = 410;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: "This hold expired. Please pick another slot." }));
    }

    if (booking.status !== "hold") {
      res.statusCode = 409;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ error: `Booking is not payable (status: ${booking.status})` }));
    }

    // 3) Create Stripe Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",

      // helps in Stripe dashboard search + linking
      client_reference_id: booking_id,

      customer_email: booking.user_email || undefined,

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: PRICE_MAP[tier].label },
            unit_amount: PRICE_MAP[tier].amount,
          },
          quantity: 1,
        },
      ],

      // ✅ IMPORTANT: webhook will use this to reconcile
      metadata: {
        booking_id,
        expert_id: booking.expert_id || "",
        price_tier: String(tier),
      },

      // ✅ use BASE_URL so preview/prod both work
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/support.html?booking_id=${encodeURIComponent(booking_id)}&canceled=1`,
    });

    // 4) Persist session + status
    const { error: updErr } = await sb
      .from("bookings")
      .update({
        price_tier: tier,
        stripe_session_id: session.id,
        status: "pending_payment",
      })
      .eq("id", booking_id);

    if (updErr) {
      // If DB update fails, still return the session URL (user can pay),
      // webhook will finalize using metadata.booking_id anyway.
      console.error("Supabase update failed:", updErr);
    }

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ checkout_url: session.url, session_id: session.id }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: e?.message || "Stripe error" }));
  }
};
