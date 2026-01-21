// /api/experts/slots.js - VERSION BAVARDE (DEBUG)

const https = require('https');

// Outil interne pour requêtes HTTPS
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
                text: () => data
            }));
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

module.exports = async (req, res) => {
    // Headers pour le Dashboard
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.statusCode = 200; res.end(); return; }

    try {
        const expertId = req.query.expert_id;
        if (!expertId) throw new Error("ERREUR: ID Expert manquant dans l'URL");

        const now = new Date();
        const from = req.query.from || now.toISOString();
        const to = req.query.to || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

        // 1. VERIFICATION SUPABASE
        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        if (!SUPA_URL || !SUPA_KEY) throw new Error("ERREUR: Variables Supabase manquantes sur Vercel");

        const accRes = await simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}&limit=1`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
        });
        const rows = accRes.json();
        
        // --- LE TEST CRUCIAL ---
        if (!rows || !rows.length) {
            throw new Error("ERREUR: Compte Google introuvable en Base de Données pour cet Expert. La connexion a échoué.");
        }
        
        const account = rows[0];
        let { access_token, refresh_token, expiry_date } = account;

        // 2. VERIFICATION TOKEN
        if (!access_token || (expiry_date && Date.now() > Number(expiry_date) - 60000)) {
            if (!refresh_token) throw new Error("ERREUR: Refresh Token manquant en Base. Reconnexion nécessaire.");

            // Tentative de refresh
            const postData = new URLSearchParams({
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
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
                throw new Error("ERREUR: Le rafraîchissement du token Google a échoué. (Erreur Google: " + JSON.stringify(refData) + ")");
            }
            
            access_token = refData.access_token;
            // Mise à jour silencieuse
            const newExpiry = Date.now() + (refData.expires_in * 1000);
            simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Prefer': 'return=minimal' },
                body: JSON.stringify({ access_token, expiry_date: newExpiry })
            });
        }

        // 3. SCAN CALENDRIERS
        const calRes = await simpleRequest("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });
        const calData = calRes.json();
        if (!calData.items) throw new Error("ERREUR: Impossible de lister les calendriers. Token invalide ?");

        const calendars = (calData.items || []).filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');
        
        const availRanges = [];
        const busyRanges = [];
        let eventCount = 0;
        let runCallCount = 0;

        for (const cal of calendars) {
            const evUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` + 
                `timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}` +
                `&singleEvents=true&orderBy=startTime&showDeleted=false`;

            const evRes = await simpleRequest(evUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
            const evData = evRes.json();
            const events = evData.items || [];
            eventCount += events.length;

            for (const ev of events) {
                if (ev.status === 'cancelled') continue;
                
                // Ignorer 'Toute la journée'
                if (!ev.start.dateTime || !ev.end.dateTime) continue;

                const start = new Date(ev.start.dateTime);
                const end = new Date(ev.end.dateTime);
                const text = (ev.summary || "") + " " + (ev.description || "");

                // Logique RunCall
                const isRunCall = /run[\s-]?call/i.test(text);
                const isBooking = (ev.extendedProperties?.private?.runcall_type === 'booking');
                
                if (isRunCall) runCallCount++;

                if (isBooking) busyRanges.push({ start, end });
                else if (isRunCall) availRanges.push({ start, end });
                else if (ev.transparency !== 'transparent') busyRanges.push({ start, end });
            }
        }

        // SI AUCUN CRÉNEAU DÉTECTÉ, ON LANCE UNE ERREUR POUR AVERTIR
        if (runCallCount === 0) {
            throw new Error(`INFO: 0 événement 'RunCall' trouvé (sur ${eventCount} événements scannés). Vérifie le titre et l'option 'Toute la journée'.`);
        }

        // 4. DECOUPAGE (30 min)
        const SLOT_MIN = 30;
        const slots = [];

        for (const range of availRanges) {
            let cursor = new Date(range.start.getTime());
            const endMs = range.end.getTime();

            while (cursor.getTime() + SLOT_MIN * 60000 <= endMs) {
                const sStart = new Date(cursor);
                const sEnd = new Date(cursor.getTime() + SLOT_MIN * 60000);
                
                let conflict = false;
                for (const busy of busyRanges) {
                    if (sStart < busy.end && busy.start < sEnd) {
                        conflict = true; break;
                    }
                }

                if (!conflict) slots.push({ start: sStart.toISOString(), end: sEnd.toISOString() });
                cursor = new Date(cursor.getTime() + SLOT_MIN * 60000);
            }
        }

        // Tri et Unique
        slots.sort((a, b) => new Date(a.start) - new Date(b.start));
        const unique = [];
        const seen = new Set();
        for (const s of slots) {
            const k = s.start + "|" + s.end;
            if (!seen.has(k)) { seen.add(k); unique.push(s); }
        }

        res.status(200).json(unique);

    } catch (e) {
        // ON RENVOIE L'ERREUR AU DASHBOARD (Code 500)
        console.error("API Error", e);
        res.status(500).json({ error: e.message });
    }
};
