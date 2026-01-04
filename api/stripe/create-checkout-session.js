// /api/stripe/create-checkout-session.js
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_MAP = {
  29: { amount: 2900, label: "RunCall support" },
  49: { amount: 4900, label: "RunCall support" },
  79: { amount: 7900, label: "RunCall support" }
};

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const booking_id = body.booking_id;
    const tier = Number(body.price_tier);

    if (!booking_id || !PRICE_MAP[tier]) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Invalid booking_id or price_tier" }));
    }

    // NOTE: for now we just create the checkout session.
    // We'll attach Supabase validation (hold, expiry, store session_id) right after.
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: PRICE_MAP[tier].label },
            unit_amount: PRICE_MAP[tier].amount
          },
          quantity: 1
        }
      ],
      metadata: { booking_id },
      success_url: `https://run-call.vercel.app/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://run-call.vercel.app/support.html?booking_id=${encodeURIComponent(booking_id)}&canceled=1`
    });

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ checkout_url: session.url, session_id: session.id }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ error: e?.message || "Stripe error" }));
  }
};
