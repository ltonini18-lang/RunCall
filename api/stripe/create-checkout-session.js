// /api/stripe/create-checkout-session.js
const Stripe = require("stripe");
const { supabaseAdmin } = require("../_lib/supabase");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Prefer env BASE_URL, fallback to prod
const BASE_URL = process.env.BASE_URL || "https://run-call.vercel.app";

module.exports = async function handler(req, res) {
  // Headers CORS (Au cas où)
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
    // tier peut être null si l'expert a un prix fixe, donc on ne valide pas strictement ici
    const tier = body.price_tier ? Number(body.price_tier) : null; 

    if (!booking_id) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "Invalid booking_id" }));
    }

    const sb = supabaseAdmin();

    // 1) Load booking ET l'expert lié (JOIN)
    // On a besoin de stripe_account_id, price, et currency de l'expert
    const { data: booking, error: readErr } = await sb
      .from("bookings")
      .select(`
        *,
        experts ( id, stripe_account_id, price, currency )
      `)
      .eq("id", booking_id)
      .single();

    if (readErr || !booking) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "Booking not found" }));
    }

    const expert = booking.experts;

    // VÉRIFICATION CRITIQUE : L'expert a-t-il connecté Stripe ?
    if (!expert || !expert.stripe_account_id) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "Cet expert n'a pas configuré ses paiements (Stripe manquants)." }));
    }

    // 2) Validate status & expiry
    const expiresAt = new Date(booking.expires_at).getTime();
    // On ajoute une petite marge de tolérance (ex: 2 min) pour éviter les frustrations de dernière seconde
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now() - 120000) { 
      res.statusCode = 410;
      return res.end(JSON.stringify({ error: "This hold expired. Please pick another slot." }));
    }

    if (booking.status !== "hold") {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: `Booking is not payable (status: ${booking.status})` }));
    }

    // 3) LOGIQUE DE PRIX & DEVISE (La nouveauté) 💰
    
    // A. Quelle devise ? (Défaut USD)
    const currency = expert.currency || 'usd'; 
    
    // B. Quel montant ? (Prix expert > Prix choix client > Fallback 49)
    let finalAmount = expert.price; 
    if (!finalAmount) {
        finalAmount = tier || 49; 
    }

    // Conversion en centimes (Stripe attend des entiers)
    const amountCents = Math.round(finalAmount * 100);
    
    // C. Calcul de ta Commission (20%)
    const platformFee = Math.round(amountCents * 0.20); 

    // 4) Create Stripe Checkout session (CONNECT)
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: booking_id,
      customer_email: booking.user_email || undefined,
      
      line_items: [
        {
          price_data: {
            currency: currency, // Dynamique (eur, usd...)
            product_data: { 
                name: "Consultation RunCall",
                description: `Expert: ${booking.user_name || 'Coach'}` // Affichage pour le client
            },
            unit_amount: amountCents, // Montant total
          },
          quantity: 1,
        },
      ],

      // 🔥 LE CŒUR DE STRIPE CONNECT : LE SPLIT
      payment_intent_data: {
        application_fee_amount: platformFee, // Ce que TU gardes
        transfer_data: {
            destination: expert.stripe_account_id, // Ce que L'EXPERT reçoit
        },
      },

      metadata: {
        booking_id,
        expert_id: expert.id || "",
        price_tier: String(finalAmount), // On stocke le montant final payé
      },

      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}&booking_id=${booking_id}`,
      cancel_url: `${BASE_URL}/support.html?booking_id=${encodeURIComponent(booking_id)}&canceled=1`,
    });

    // 5) Persist session + status
    const { error: updErr } = await sb
      .from("bookings")
      .update({
        price_tier: finalAmount, // On sauvegarde le montant réel payé
        stripe_session_id: session.id,
        status: "pending_payment",
      })
      .eq("id", booking_id);

    if (updErr) {
      console.error("Supabase update failed:", updErr);
    }

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ checkout_url: session.url, session_id: session.id }));

  } catch (e) {
    console.error("Stripe Error:", e);
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: e?.message || "Stripe error" }));
  }
};
