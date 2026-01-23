const { createClient } = require('@supabase/supabase-js');
const Stripe = require("stripe");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Prefer env BASE_URL, fallback to prod
const BASE_URL = process.env.BASE_URL || "https://run-call.vercel.app";

module.exports = async function handler(req, res) {
  // Headers CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.statusCode = 200; return res.end(); }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const booking_id = body.booking_id;
    // tier peut être null si l'expert a un prix fixe
    const tier = body.price_tier ? Number(body.price_tier) : null; 

    if (!booking_id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Invalid booking_id" }));
    }

    // --- FIX : CONNEXION DIRECTE ADMIN ---
    // On contourne les sécurités RLS pour être sûr de lire la réservation et l'expert associé
    const sb = createClient(
        process.env.SUPABASE_URL, 
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // 1) Load booking ET l'expert lié
    const { data: booking, error: readErr } = await sb
      .from("bookings")
      .select(`
        *,
        experts ( id, stripe_account_id, price, currency )
      `)
      .eq("id", booking_id)
      .single();

    if (readErr || !booking) {
      console.error("Booking DB Error:", readErr);
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "Booking not found (DB Error)" }));
    }

    const expert = booking.experts;

    // VÉRIFICATION CRITIQUE
    if (!expert || !expert.stripe_account_id) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "Cet expert n'a pas configuré ses paiements (Stripe manquants)." }));
    }

    // 2) Validate status & expiry
    const expiresAt = new Date(booking.expires_at).getTime();
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now() - 120000) { // 2 min buffer
      res.statusCode = 410;
      return res.end(JSON.stringify({ error: "This hold expired. Please pick another slot." }));
    }

    if (booking.status !== "hold") {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: `Booking is not payable (status: ${booking.status})` }));
    }

    // 3) LOGIQUE DE PRIX & DEVISE
    const currency = expert.currency || 'usd'; 
    
    let finalAmount = expert.price; 
    if (!finalAmount) {
        finalAmount = tier || 49; 
    }

    const amountCents = Math.round(finalAmount * 100);
    const platformFee = Math.round(amountCents * 0.20); // 20% com

    // 4) Create Stripe Checkout session (CONNECT)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: booking_id,
      customer_email: booking.user_email || undefined,
      
      line_items: [
        {
          price_data: {
            currency: currency,
            product_data: { 
                name: "Consultation RunCall",
                description: `Expert: ${booking.user_name || 'Coach'}`
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        },
      ],

      payment_intent_data: {
        application_fee_amount: platformFee,
        transfer_data: {
            destination: expert.stripe_account_id,
        },
      },

      metadata: {
        booking_id,
        expert_id: expert.id || "",
        price_tier: String(finalAmount),
      },

      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&booking_id=${booking_id}`,
      cancel_url: `${BASE_URL}/support.html?booking_id=${encodeURIComponent(booking_id)}&canceled=1`,
    });

    // 5) Persist session
    await sb
      .from("bookings")
      .update({
        price_tier: finalAmount,
        stripe_session_id: session.id,
        status: "pending_payment",
      })
      .eq("id", booking_id);

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ checkout_url: session.url, session_id: session.id }));

  } catch (e) {
    console.error("Stripe Handler Error:", e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e?.message || "Stripe error" }));
  }
};
