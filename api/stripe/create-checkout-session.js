// /api/stripe/create-checkout-session.js
const Stripe = require("stripe");
const { supabaseAdmin } = require("../_lib/supabase");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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
    const tier = body.price_tier ? Number(body.price_tier) : null; 

    if (!booking_id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Invalid booking_id" }));
    }

    const sb = supabaseAdmin();

    // ÉTAPE 1 : Récupérer la RÉSERVATION
    const { data: booking, error: bookingErr } = await sb
      .from("bookings")
      .select("*")
      .eq("id", booking_id)
      .single();

    if (bookingErr || !booking) {
      console.error("Booking Error:", bookingErr);
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "Booking not found" }));
    }

    // ÉTAPE 2 : Récupérer l'EXPERT (Avec son NOM)
    const { data: expert, error: expertErr } = await sb
        .from("experts")
        .select("id, stripe_account_id, price, currency, name") 
        .eq("id", booking.expert_id)
        .single();

    if (expertErr || !expert) {
        console.error("Expert Error:", expertErr);
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: "Expert not found linked to this booking" }));
    }

    if (!expert.stripe_account_id) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "Cet expert n'a pas configuré ses paiements (Stripe manquants)." }));
    }

    // ÉTAPE 3 : Vérifs logiques
    const expiresAt = new Date(booking.expires_at).getTime();
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now() - 120000) { 
      res.statusCode = 410;
      return res.end(JSON.stringify({ error: "This hold expired. Please pick another slot." }));
    }

    if (booking.status !== "hold") {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: `Booking is not payable (status: ${booking.status})` }));
    }

    // ÉTAPE 4 : Calculs Prix & Devise
    const currency = expert.currency || 'usd'; 
    let finalAmount = expert.price; 
    
    if (!finalAmount) {
        finalAmount = tier || 49; 
    }

    const amountCents = Math.round(finalAmount * 100);
    const platformFee = Math.round(amountCents * 0.20); 

    // ÉTAPE 5 : Session Stripe
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: booking_id,
      customer_email: booking.user_email || undefined,
      
      line_items: [
        {
          price_data: {
            currency: currency,
            product_data: { 
                // ✅ TES NOUVEAUX TEXTES ICI :
                name: "Échange vidéo RunCall", 
                description: `Avec ${expert.name || 'un membre RunCall'}` 
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

    // ÉTAPE 6 : Sauvegarde
    await sb
      .from("bookings")
      .update({
        price_tier: finalAmount,
        stripe_session_id: session.id,
        status: "pending_payment",
      })
      .eq("id", booking_id);

    return res.json({ checkout_url: session.url, session_id: session.id });

  } catch (e) {
    console.error("Stripe Handler Error:", e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e?.message || "Stripe error" }));
  }
};
