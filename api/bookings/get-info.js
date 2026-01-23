const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
    // Headers pour autoriser la page publique à lire ça
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const { booking_id } = req.query;
        if (!booking_id) throw new Error("ID manquant");

        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

        // On va chercher l'expert lié à la réservation pour connaître son tarif
        const { data: booking, error } = await supabase
            .from('bookings')
            .select(`id, experts ( price, currency )`)
            .eq('id', booking_id)
            .single();

        if (error || !booking) throw new Error("Réservation introuvable");

        const expert = booking.experts;
        
        // On renvoie la config
        return res.json({
            hasFixedPrice: !!expert.price, // Vrai si un prix est défini
            fixedPrice: expert.price,
            currency: expert.currency || 'usd' // Par défaut USD
        });

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};
