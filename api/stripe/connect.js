const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { expertId, country } = req.body; // On récupère le pays choisi
        if (!expertId) throw new Error("ID manquant");

        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

        // 1. Récupérer le RunCaller
        const { data: expert } = await supabase
            .from('experts')
            .select('stripe_account_id, email')
            .eq('id', expertId)
            .single();

        let accountId = expert?.stripe_account_id;
        let accountLinkUrl = null;
        let isComplete = false;

        // 2. Création du compte (Si inexistant)
        if (!accountId) {
            // Si l'utilisateur n'a pas choisi de pays, on bloque ou on met US par défaut
            const selectedCountry = country || 'US'; 
            
            const account = await stripe.accounts.create({
                type: 'express',
                email: expert.email,
                country: selectedCountry, // <--- On force le pays choisi !
                capabilities: {
                    card_payments: { requested: true },
                    transfers: { requested: true },
                },
            });
            accountId = account.id;

            // Sauvegarde DB
            await supabase.from('experts').update({ stripe_account_id: accountId }).eq('id', expertId);
        }

        // 3. Vérification du Statut (Est-ce qu'il a fini ?)
        const accountInfo = await stripe.accounts.retrieve(accountId);
        isComplete = accountInfo.details_submitted; // Vrai si l'onboarding est fini

        // 4. Génération du lien (Login ou Onboarding)
        const origin = req.headers.origin || 'https://run-call.vercel.app';
        
        if (isComplete) {
            // Si fini -> Lien Dashboard
            const loginLink = await stripe.accounts.createLoginLink(accountId);
            accountLinkUrl = loginLink.url;
        } else {
            // Si pas fini -> Lien Inscription
            const accountLink = await stripe.accountLinks.create({
                account: accountId,
                refresh_url: `${origin}/dashboard.html?expert_id=${expertId}`,
                return_url: `${origin}/dashboard.html?expert_id=${expertId}`,
                type: 'account_onboarding',
            });
            accountLinkUrl = accountLink.url;
        }

        // On renvoie l'URL ET le statut
        res.status(200).json({ 
            url: accountLinkUrl,
            isComplete: isComplete 
        });

    } catch (e) {
        console.error("Erreur Stripe:", e);
        res.status(500).json({ error: e.message });
    }
};
