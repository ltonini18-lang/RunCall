const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
    // 1. CORS Permissif (Pour que tes previews Vercel fonctionnent)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { expert_id } = req.query;
        
        if (!expert_id) {
            return res.status(400).json({ error: "Expert ID is required" });
        }

        // 2. Connexion Supabase
        // On utilise createClient direct pour être sûr que ça marche sans dépendance externe
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

        // 3. Récupération (On prend photo_url, PAS photo_path)
        const { data: expert, error } = await supabase
            .from('experts')
            .select('id, name, presentation, photo_url') 
            .eq('id', expert_id)
            .single();

        if (error || !expert) {
            return res.status(404).json({ error: "Expert not found" });
        }

        // 4. Renvoi
        return res.status(200).json(expert);

    } catch (e) {
        console.error("API Error:", e);
        return res.status(500).json({ error: e.message });
    }
};
