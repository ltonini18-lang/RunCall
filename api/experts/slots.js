// /api/experts/slots.js - MODE DIAGNOSTIC (Ne pas laisser en prod)

const https = require('https');

function simpleRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = https.request(new URL(url), {
            method: options.method || 'GET',
            headers: options.headers || {}
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({
                json: () => { try { return JSON.parse(data) } catch(e) { return null } },
                status: res.statusCode,
                raw: data
            }));
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    try {
        const expertId = req.query.expert_id;
        if (!expertId) return res.json({ error: "No Expert ID" });

        // 1. SUPABASE
        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        const accRes = await simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}&limit=1`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
        });
        const rows = accRes.json();
        
        if (!rows || !rows.length) return res.json({ error: "Compte non trouvé en base (reconnecte-toi !)" });
        
        const account = rows[0];
        let { access_token, refresh_token, expiry_date } = account;

        // 2. DIAGNOSTIC REFRESH
        const isExpired = !access_token || (expiry_date && Date.now() > Number(expiry_date) - 60000);
        
        if (isExpired) {
            if (!refresh_token) return res.json({ error: "Refresh Token absent de la base. Reconnexion nécessaire." });

            const clientId = process.env.GOOGLE_CLIENT_ID;
            const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

            if (!clientId || !clientSecret) return res.json({ error: "Variables Vercel manquantes (ID/Secret)" });

            // On tente le refresh et ON MONTRE L'ERREUR
            const postData = new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refresh_token,
                grant_type: "refresh_token"
            }).toString();

            const refRes = await simpleRequest("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: postData
            });
            const refData = refRes.json();
            
            if (!refData || !refData.access_token) {
                // VOICI L'ERREUR QUE L'ON CHERCHE :
                return res.status(500).json({ 
                    error: "ECHEC REFRESH GOOGLE", 
                    details: refData,
                    sent_client_id: clientId ? "Present (Starts with " + clientId.substring(0,5) + ")" : "Missing"
                });
            }
            
            // Si ça marche, on le dit
            return res.json({ success: "Refresh réussi ! Le token est valide.", new_token: "OK" });
        }

        return res.json({ message: "Token encore valide, pas de refresh nécessaire." });

    } catch (e) {
        return res.status(500).json({ error: "Crash API", stack: e.message });
    }
};
