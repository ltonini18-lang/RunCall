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
                status: res.statusCode
            }));
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
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

        // 1. DATES & CONFIG
        const now = new Date();
        const safeNow = new Date(now.getTime() + 5 * 60000); // Marge 5 min
        
        const fromParam = req.query.from || now.toISOString();
        const from = new Date(fromParam);
        const to = req.query.to || new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000).toISOString();

        // 2. SUPABASE
        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        const accRes = await simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}&limit=1`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
        });
        const rows = accRes.json();
        
        if (!rows || !rows.length) return res.status(200).json([]);
        
        const account = rows[0];
        let { access_token, refresh_token, expiry_date } = account;

        // 3. REFRESH TOKEN (Si nécessaire)
        if (!access_token || (expiry_date && Date.now() > Number(expiry_date) - 60000)) {
            if (refresh_token) {
                const clientId = process.env.GOOGLE_CLIENT_ID;
                const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
                const postData = new URLSearchParams({
                    client_id: clientId, client_secret: clientSecret, refresh_token: refresh_token, grant_type: "refresh_token"
                }).toString();
                const refRes = await simpleRequest("https://oauth2.googleapis.com/token", {
                    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: postData
                });
                const refData = refRes.json();
                if (refData && refData.access_token) {
                    access_token = refData.access_token;
                    // Mise à jour DB silencieuse
                    const newExpiry = Date.now() + (refData.expires_in * 1000);
                    simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json", 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Prefer': 'return=minimal' },
                        body: JSON.stringify({ access_token, expiry_date: newExpiry })
                    });
                }
            }
        }

        // 4. SCAN GOOGLE CALENDAR (VERSION CORRIGÉE : UNIQUEMENT 'PRIMARY')
        // On ne liste plus tous les calendriers, on tape directement dans le principal.
        // Cela fonctionne avec le scope "calendar.events"
        
        const availRanges = [];
        const busyRanges = [];

        // On cible uniquement le calendrier 'primary'
        const evUrl = `https://www.googleapis.com/calendar/v3/calendars/primary/events?` + 
            `timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to)}` +
            `&singleEvents=true&orderBy=startTime&showDeleted=false`; 

        const evRes = await simpleRequest(evUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
        const evData = evRes.json();
        const events = evData.items || [];

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
                // Créneau de disponibilité
                availRanges.push({ start, end });
            } else if (ev.transparency !== 'transparent') {
                // Conflit (RDV perso, Pro...)
                busyRanges.push({ start, end });
            }
        }

        // 5. SLICING (Découpage en tranches de 30 min)
        const SLOT_MIN = 30;
        const slots = [];

        for (const range of availRanges) {
            let cursor = new Date(range.start.getTime());
            const endMs = range.end.getTime();

            while (cursor.getTime() + SLOT_MIN * 60000 <= endMs) {
                const sStart = new Date(cursor);
                const sEnd = new Date(cursor.getTime() + SLOT_MIN * 60000);
                
                if (sStart < safeNow) {
                    cursor = new Date(cursor.getTime() + SLOT_MIN * 60000);
                    continue;
                }

                // Vérification conflits
                let conflict = false;
                for (const busy of busyRanges) {
                    if (sStart < busy.end && busy.start < sEnd) {
                        conflict = true; break;
                    }
                }

                if (!conflict) {
                    slots.push({ start: sStart.toISOString(), end: sEnd.toISOString() });
                }
                
                cursor = new Date(cursor.getTime() + SLOT_MIN * 60000);
            }
        }

        // Tri et Nettoyage
        slots.sort((a, b) => new Date(a.start) - new Date(b.start));
        
        const unique = [];
        const seen = new Set();
        for (const s of slots) {
            const k = s.start + "|" + s.end;
            if (!seen.has(k)) { seen.add(k); unique.push(s); }
        }

        return res.status(200).json(unique);

    } catch (e) {
        return res.status(500).json({ error: "Server Error", message: e.message });
    }
};
