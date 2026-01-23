const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
    // Headers pour autoriser la page publique
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { booking_id } = req.query;
        if (!booking_id) throw new Error("ID manquant");

        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

        // ÉTAPE 1 : On récupère l'expert_id via la réservation
        const { data: booking, error: errBooking } = await supabase
            .from('bookings')
            .select('expert_id')
            .eq('id', booking_id)
            .single();

        if (errBooking || !booking) throw new Error("Réservation introuvable");

        // ÉTAPE 2 : On récupère le prix de l'expert directement
        // (Cette méthode séquentielle évite les bugs de relation "JOIN" dans Supabase)
        const { data: expert, error: errExpert } = await supabase
            .from('experts')
            .select('price, currency')
            .eq('id', booking.expert_id)
            .single();

        if (errExpert || !expert) throw new Error("Expert introuvable");
        
        // On vérifie que le prix existe et qu'il est supérieur à 0
        const hasPrice = (expert.price !== null && expert.price !== undefined && expert.price > 0);

        return res.json({
            hasFixedPrice: hasPrice,
            fixedPrice: expert.price,
            currency: expert.currency || 'usd'
        });

    } catch (e) {
        console.error("API Get-Info Error:", e);
        return res.status(500).json({ error: e.message });
    }
};
