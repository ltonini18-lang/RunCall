// /api/stripe/webhook.js
const Stripe = require("stripe");
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// IMPORTANT for Stripe signature verification on Vercel
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

  // For now: just confirm we receive it
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const bookingId = session?.metadata?.booking_id || null;
    console.log("✅ checkout.session.completed", { sessionId: session.id, bookingId });
  }

  res.setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify({ received: true }));
};
