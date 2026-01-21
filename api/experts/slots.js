// /api/experts/slots.js - VERSION NATIVE (Zéro Dépendance Externe)

const https = require('https');

// --- 1. OUTILS NATIFS (Pour remplacer fetch/googleapis) ---
function simpleRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const reqOpts = {
            method: options.method || 'GET',
            headers: options.headers || {}
        };

        const req = https.request(urlObj, reqOpts, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const result = {
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json: () => {
                        try { return JSON.parse(data); } 
                        catch (e) { return null; }
                    },
                    text: () => data
                };
                resolve(result);
            });
        });

        req.on('error', (err) => reject(err));
        if (options.body) req.write(options.body);
        req.end();
    });
}

// --- 2. LOGIQUE MÉTIER ---

function parseTime(t) {
    if (!t) return null;
    if (t.dateTime) return new Date(t.dateTime);
    return null; // On ignore les événements journée entière
}

function isRunCallAvailability(text) {
    if (!text) return false;
    // Regex flexible : runcall, run-call, run call, etc.
    return /run[\s-]?call/i.test(text);
}

function isBooking(ev) {
    const t = ev?.extendedProperties?.private?.runcall_type;
    return String(t || "").toLowerCase() === "booking";
}

function overlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}

// --- 3. LE MOTEUR (Handler) ---

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    
    if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
    }

    try {
        const expertId = req.query.expert_id;
        if (!expertId) throw new Error("Missing expert_id");

        const now = new Date();
        const from = req.query.from || now.toISOString();
        const to = req.query.to || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

        // A. Récupérer le compte Google via Supabase
        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        const accRes = await simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}&limit=1`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
        });
        
        const accRows = accRes.json();
        const account = accRows ? accRows[0] : null;

        if (!account) {
            res.statusCode = 404;
            return res.json({ error: "Expert not connected" });
        }

        let { access_token, refresh_token, expiry_date } = account;

        // B. Refresh Token si nécessaire
        if (!access_token || (expiry_date && Date.now() > Number(expiry_date) - 60000)) {
            if (!refresh_token) throw new Error("No refresh token");

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
            if (!refData || !refData.access_token) throw new Error("Google Refresh Failed");
            
            access_token = refData.access_token;
            const newExpiry = Date.now() + (refData.expires_in * 1000);
            
            // Mise à jour DB (sans attendre la réponse pour aller vite)
            simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Prefer': 'return=minimal' },
                body: JSON.stringify({ access_token, expiry_date: newExpiry })
            });
        }

        // C. Lister les calendriers
        const calRes = await simpleRequest("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=20", {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });
        const calData = calRes.json() || {};
        const calendars = (calData.items || []).filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');

        const availRanges = [];
        const busyRanges = [];

        // D. Scanner les événements
        for (const cal of calendars) {
            const evUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` + 
                `timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}` +
                `&singleEvents=true&orderBy=startTime&showDeleted=false` +
                `&fields=items(id,status,summary,description,transparency,start,end,extendedProperties)`;
            
            const evRes = await simpleRequest(evUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
            const evData = evRes.json() || {};
            const events = evData.items || [];

            for (const ev of events) {
                if (ev.status === 'cancelled') continue;
                const start = parseTime(ev.start);
                const end = parseTime(ev.end);
                if (!start || !end) continue;

                const text = (ev.summary || "") + " " + (ev.description || "");
                
                if (isBooking(ev)) {
                    busyRanges.push({ start, end });
                } else if (isRunCallAvailability(text)) {
                    availRanges.push({ start, end });
                } else if (ev.transparency !== 'transparent') {
                    busyRanges.push({ start, end });
                }
            }
        }

        // E. Découpage en tranches de 30 min (Slicing)
        const SLOT_MIN = 30;
        const slots = [];

        for (const range of availRanges) {
            const endMs = range.end.getTime();
            let cursor = new Date(range.start.getTime());

            while (cursor.getTime() + SLOT_MIN * 60000 <= endMs) {
                const sStart = new Date(cursor);
                const sEnd = new Date(cursor.getTime() + SLOT_MIN * 60000);

                let conflict = false;
                for (const busy of busyRanges) {
                    if (overlaps(sStart, sEnd, busy.start, busy.end)) {
                        conflict = true; break;
                    }
                }

                if (!conflict) {
                    slots.push({ start: sStart.toISOString(), end: sEnd.toISOString() });
                }
                cursor = new Date(cursor.getTime() + SLOT_MIN * 60000);
            }
        }

        // F. Tri et Dédoublonnage
        slots.sort((a, b) => new Date(a.start) - new Date(b.start));
        const unique = [];
        const seen = new Set();
        for (const s of slots) {
            const k = s.start + s.end;
            if (!seen.has(k)) { seen.add(k); unique.push(s); }
        }

        // Réponse finale (Tableau JSON)
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(unique));

    } catch (e) {
        console.error("API Error", e);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
    }
};
