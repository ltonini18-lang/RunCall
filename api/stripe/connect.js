const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
    // 1. Init & Sécurité (CORS)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { expertId } = req.body;
        if (!expertId) throw new Error("Expert ID manquant");

        // 2. Connexion Supabase (Admin)
        const supabase = createClient(
            process.env.SUPABASE_URL,
            process.env.SUPABASE_SERVICE_ROLE_KEY
        );

        // 3. Récupérer l'expert
        const { data: expert, error: dbError } = await supabase
            .from('experts')
            .select('stripe_account_id, email')
            .eq('id', expertId)
            .single();

        if (dbError || !expert) throw new Error("Expert introuvable");

        let accountId = expert.stripe_account_id;

        // --- SCÉNARIO 1 : CRÉATION DU COMPTE (Si pas encore fait) ---
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express',
                email: expert.email,
                // country: 'US', // <--- SUPPRIMÉ : On laisse l'utilisateur choisir son pays (US, FR, UK...)
                capabilities: {
                    card_payments: { requested: true },
                    transfers: { requested: true },
                },
            });

            accountId = account.id;

            // Sauvegarde immédiate dans Supabase
            await supabase
                .from('experts')
                .update({ stripe_account_id: accountId })
                .eq('id', expertId);
        }

        // --- SCÉNARIO 2 : GÉNÉRATION DU LIEN ---
        
        // A. On essaie d'abord de générer un lien de CONNEXION (Dashboard Financier)
        // Cela ne marche que si l'expert a FINI son inscription.
        try {
            const loginLink = await stripe.accounts.createLoginLink(accountId);
            // Si ça marche, on renvoie direct vers le dashboard Stripe
            return res.status(200).json({ url: loginLink.url });
        } catch (err) {
            // Si erreur (ex: inscription pas finie), on ignore et on passe à l'étape B
            console.log("Compte incomplet, génération du lien d'inscription...");
        }

        // B. Fallback : On génère le lien d'ONBOARDING (Inscription)
        const origin = req.headers.origin || 'https://run-call.vercel.app';
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${origin}/dashboard.html?expert_id=${expertId}`, // S'il annule ou bug
            return_url: `${origin}/dashboard.html?expert_id=${expertId}`,  // Quand il a fini
            type: 'account_onboarding',
        });

        res.status(200).json({ url: accountLink.url });

    } catch (e) {
        console.error("Stripe Connect Error:", e);
        res.status(500).json({ error: e.message });
    }
};
