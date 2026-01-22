// /api/stripe/connect.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
    // 1. Init & Sécurité
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
            .select('stripe_account_id, email, name') // On récupère l'email pour pré-remplir Stripe
            .eq('id', expertId)
            .single();

        if (dbError || !expert) throw new Error("Expert introuvable");

        let accountId = expert.stripe_account_id;

        // 4. Si pas de compte Stripe, on le crée
        if (!accountId) {
            const account = await stripe.accounts.create({
                type: 'express',
                country: 'FR', // Tu peux rendre ça dynamique si besoin
                email: expert.email,
                capabilities: {
                    card_payments: { requested: true },
                    transfers: { requested: true },
                },
                settings: {
                    payouts: {
                        schedule: { interval: 'manual' } // Tu gères quand tu paies (optionnel)
                    }
                }
            });

            accountId = account.id;

            // On sauvegarde l'ID tout de suite dans la base
            await supabase
                .from('experts')
                .update({ stripe_account_id: accountId })
                .eq('id', expertId);
        }

        // 5. Générer le lien d'Onboarding (Lien magique)
        const origin = req.headers.origin || 'https://ton-site.vercel.app'; // Fallback
        const accountLink = await stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${origin}/dashboard.html?expert_id=${expertId}`, // S'il annule ou bug
            return_url: `${origin}/dashboard.html?expert_id=${expertId}`,  // Quand il a fini
            type: 'account_onboarding',
        });

        // 6. On renvoie l'URL au Dashboard
        res.status(200).json({ url: accountLink.url });

    } catch (e) {
        console.error("Stripe Connect Error:", e);
        res.status(500).json({ error: e.message });
    }
};
