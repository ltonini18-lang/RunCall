const https = require('https');

// Helper : Promisify https.request
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
                headers: res.headers
            }));
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// Helper : Refresh Token Logic (Factorisée pour être réutilisable)
async function refreshGoogleToken(refreshToken, expertId, supabaseUrl, supabaseKey) {
    if (!refreshToken) return null;
    
    console.log("🔄 Refreshing Token for Expert:", expertId);
    
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    
    const postData = new URLSearchParams({
        client_id: clientId, 
        client_secret: clientSecret, 
        refresh_token: refreshToken, 
        grant_type: "refresh_token"
    }).toString();

    const refRes = await simpleRequest("https://oauth2.googleapis.com/token", {
        method: "POST", 
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, 
        body: postData
    });

    const refData = refRes.json();
    
    if (refData && refData.access_token) {
        const newExpiry = Date.now() + (refData.expires_in * 1000);
        // Mise à jour DB (on attend la réponse pour être sûr)
        await simpleRequest(`${supabaseUrl}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}`, {
            method: "PATCH",
            headers: { 
                "Content-Type": "application/json", 
                'apikey': supabaseKey, 
                'Authorization': `Bearer ${supabaseKey}`, 
                'Prefer': 'return=minimal' 
            },
            body: JSON.stringify({ access_token: refData.access_token, expiry_date: newExpiry })
        });
        console.log("✅ Token Refreshed & Saved");
        return refData.access_token;
    }
    
    console.error("❌ Refresh Failed:", refData);
    return null;
}

module.exports = async (req, res) => {
    // Headers CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

    try {
        const expertId = req.query.expert_id;
        if (!expertId) return res.status(200).json([]);

        // 1. CONFIG ENV
        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

        // 2. RECUPERATION DU COMPTE
        const accRes = await simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}&limit=1`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
        });
        const rows = accRes.json();
        
        if (!rows || !rows.length) return res.status(200).json([]);
        
        const account = rows[0];
        let { access_token, refresh_token, expiry_date } = account;

        // 3. VERIFICATION EXPIRATION (PREVENTIVE)
        // Si expire dans moins de 2 minutes, on refresh avant même d'essayer
        if (!access_token || (expiry_date && Date.now() > Number(expiry_date) - 120000)) {
            const newToken = await refreshGoogleToken(refresh_token, expertId, SUPA_URL, SUPA_KEY);
            if (newToken) access_token = newToken;
        }

        // 4. APPEL GOOGLE CALENDAR (AVEC RETRY AUTOMATIQUE)
        const fromParam = req.query.from || new Date().toISOString();
        const from = new Date(fromParam);
        const to = req.query.to || new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString();

        const evUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` + 
            `timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to)}` +
            `&singleEvents=true&orderBy=startTime&showDeleted=false`; 

        let evRes = await simpleRequest(evUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
        
        // --- LA SECURITE ULTIME : LE RETRY 401 ---
        // Si Google nous jette (401 Unauthorized), c'est que le token est mort, même si expiry_date disait le contraire.
        if (evRes.status === 401 && refresh_token) {
            console.warn("⚠️ 401 from Google. Forcing refresh...");
            const freshToken = await refreshGoogleToken(refresh_token, expertId, SUPA_URL, SUPA_KEY);
            if (freshToken) {
                // On réessaie UNE fois avec le nouveau token
                evRes = await simpleRequest(evUrl, { headers: { 'Authorization': `Bearer ${freshToken}` } });
            }
        }

        if (evRes.status !== 200) {
            // Si ça plante toujours, on renvoie vide plutôt qu'une erreur 500
            console.error("Google Calendar Error:", evRes.status, evRes.json());
            return res.status(200).json([]); 
        }

        const evData = evRes.json();
        const events = evData.items || [];

        // 5. PARSING ET SLICING (Logique identique)
        const availRanges = [];
        const busyRanges = [];

        for (const ev of events) {
            if (ev.status === 'cancelled') continue;
            
            const startStr = ev.start.dateTime || ev.start.date;
            const endStr = ev.end.dateTime || ev.end.date;
            if (!startStr || !endStr) continue;

            const start = new Date(startStr);
            const end = new Date(endStr);
            const text = (ev.summary || "") + " " + (ev.description || "");

            const isRunCall = /run[\s-]?call/i.test(text);
            const isBooking = (ev.extendedProperties?.private?.runcall_type === 'booking');
            
            if (isBooking) {
                busyRanges.push({ start, end });
            } else if (isRunCall) {
                availRanges.push({ start, end });
            } else if (ev.transparency !== 'transparent') {
                busyRanges.push({ start, end });
            }
        }

        const SLOT_MIN = 30;
        const slots = [];
        const safeNow = new Date(Date.now() + 5 * 60000); // Marge 5 min

        for (const range of availRanges) {
            let cursor = new Date(range.start.getTime());
            const endMs = range.end.getTime();

            while (cursor.getTime() + SLOT_MIN * 60000 <= endMs) {
                const sStart = new Date(cursor);
                const sEnd = new Date(cursor.getTime() + SLOT_MIN * 60000);
                
                if (sStart >= safeNow) {
                    let conflict = false;
                    for (const busy of busyRanges) {
                        if (sStart < busy.end && busy.start < sEnd) {
                            conflict = true; break;
                        }
                    }
                    if (!conflict) {
                        slots.push({ start: sStart.toISOString(), end: sEnd.toISOString() });
                    }
                }
                cursor = new Date(cursor.getTime() + SLOT_MIN * 60000);
            }
        }

        slots.sort((a, b) => new Date(a.start) - new Date(b.start));
        
        const unique = [];
        const seen = new Set();
        for (const s of slots) {
            const k = s.start + "|" + s.end;
            if (!seen.has(k)) { seen.add(k); unique.push(s); }
        }

        return res.status(200).json(unique);

    } catch (e) {
        console.error("API Error:", e);
        return res.status(500).json({ error: "Server Error", message: e.message });
    }
};
