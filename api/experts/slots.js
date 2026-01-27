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

    const debugLog = { step: "Init", calendars_found: 0, events_scanned: 0, runcall_matches: 0, busy_events: 0 };

    try {
        const expertId = req.query.expert_id;
        if (!expertId) return res.status(200).json({ slots: [], debug: "No Expert ID" });

        // 1. DATES
        const now = new Date();
        const fromParam = req.query.from || now.toISOString();
        const from = new Date(fromParam);
        const to = req.query.to || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

        debugLog.range = { from: from.toISOString(), to: to };

        // 2. SUPABASE
        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        const accRes = await simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}&limit=1`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
        });
        const rows = accRes.json();
        
        if (!rows || !rows.length) return res.status(200).json({ slots: [], debug: "Not connected in DB" });
        
        const account = rows[0];
        let { access_token, refresh_token, expiry_date } = account;

        // 3. REFRESH TOKEN
        if (!access_token || (expiry_date && Date.now() > Number(expiry_date) - 60000)) {
            if (refresh_token) {
                const clientId = process.env.GOOGLE_CLIENT_ID;
                const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
                if (clientId && clientSecret) {
                    const postData = new URLSearchParams({
                        client_id: clientId, client_secret: clientSecret, refresh_token: refresh_token, grant_type: "refresh_token"
                    }).toString();
                    const refRes = await simpleRequest("https://oauth2.googleapis.com/token", {
                        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: postData
                    });
                    const refData = refRes.json();
                    if (refData && refData.access_token) {
                        access_token = refData.access_token;
                    } else {
                        return res.status(200).json({ slots: [], debug: "Token Refresh Failed", google_error: refData });
                    }
                }
            }
        }

        // 4. SCAN GOOGLE
        const calRes = await simpleRequest("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });
        const calData = calRes.json();

        if (calData.error) return res.status(200).json({ slots: [], debug: "Google List Error", error: calData.error });

        const calendars = (calData.items || []).filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');
        debugLog.calendars_found = calendars.length;
        debugLog.calendar_names = calendars.map(c => c.summary);

        const availRanges = [];
        const busyRanges = [];

        for (const cal of calendars) {
            const evUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` + 
                `timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to)}` +
                `&singleEvents=true&orderBy=startTime&showDeleted=false`;

            const evRes = await simpleRequest(evUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
            const evData = evRes.json();
            const events = evData.items || [];
            
            debugLog.events_scanned += events.length;

            for (const ev of events) {
                if (ev.status === 'cancelled') continue;
                // Important: On gère les événements "Journée entière" (qui n'ont pas de dateTime mais 'date')
                const startStr = ev.start.dateTime || ev.start.date;
                const endStr = ev.end.dateTime || ev.end.date;
                
                if (!startStr || !endStr) continue;

                const start = new Date(startStr);
                const end = new Date(endStr);
                const text = (ev.summary || "") + " " + (ev.description || "");

                const isRunCall = /run[\s-]?call/i.test(text);
                
                if (isRunCall) {
                    debugLog.runcall_matches++;
                    availRanges.push({ start, end });
                } else if (ev.transparency !== 'transparent') {
                    // C'est un événement occupé (pas runcall)
                    debugLog.busy_events++;
                    busyRanges.push({ start, end });
                }
            }
        }

        // 5. SLICING
        const SLOT_MIN = 30;
        const slots = [];
        // On enlève le filtre safeNow pour le test, on veut TOUT voir
        // const safeNow = new Date(now.getTime() + 5 * 60000); 

        for (const range of availRanges) {
            let cursor = new Date(range.start.getTime());
            const endMs = range.end.getTime();

            while (cursor.getTime() + SLOT_MIN * 60000 <= endMs) {
                const sStart = new Date(cursor);
                const sEnd = new Date(cursor.getTime() + SLOT_MIN * 60000);
                
                let conflict = false;
                for (const busy of busyRanges) {
                    // Vérification stricte du conflit
                    if (sStart < busy.end && busy.start < sEnd) {
                        conflict = true; break;
                    }
                }

                if (!conflict) slots.push({ start: sStart.toISOString(), end: sEnd.toISOString() });
                cursor = new Date(cursor.getTime() + SLOT_MIN * 60000);
            }
        }

        const unique = [];
        const seen = new Set();
        for (const s of slots) {
            const k = s.start + "|" + s.end;
            if (!seen.has(k)) { seen.add(k); unique.push(s); }
        }
        
        unique.sort((a, b) => new Date(a.start) - new Date(b.start));

        // ON RENVOIE LE RAPPORT DANS LA RÉPONSE
        return res.status(200).json({ 
            slots: unique, 
            debug_info: debugLog 
        });

    } catch (e) {
        return res.status(200).json({ slots: [], debug: "CRASH", error: e.message });
    }
};
