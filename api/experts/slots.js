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

    const debugLog = { step: "Start", error: null };

    try {
        const expertId = req.query.expert_id;
        if (!expertId) return res.status(200).json({ slots: [], debug: "No Expert ID" });

        // 1. DATES
        const now = new Date();
        const fromParam = req.query.from || now.toISOString();
        const from = new Date(fromParam);
        const to = req.query.to || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

        // 2. SUPABASE
        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        const accRes = await simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}&limit=1`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
        });
        const rows = accRes.json();
        
        if (!rows || !rows.length) return res.status(200).json({ slots: [], debug: "Not connected in DB (No rows)" });
        
        const account = rows[0];
        let { access_token, refresh_token, expiry_date, google_email } = account;
        debugLog.email_in_db = google_email;

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

        if (calData.error) return res.status(200).json({ slots: [], debug: "Google API Error", google_error: calData.error });

        const calendars = (calData.items || []).filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');
        
        // RAPPORT SUR LES CALENDRIERS TROUVÉS
        debugLog.calendars_found = calendars.map(c => ({ id: c.id, summary: c.summary, primary: c.primary }));

        const availRanges = [];
        debugLog.events_analyzed = 0;
        debugLog.runcall_events_found = 0;

        for (const cal of calendars) {
            // On ne scanne que le calendrier principal pour le test, ou ceux qui s'appellent "RunCall" ou qui contiennent l'email
            // (Pour éviter de scanner 50 calendriers fériés)
            const evUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?` + 
                `timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to)}` +
                `&singleEvents=true&orderBy=startTime&showDeleted=false`;

            const evRes = await simpleRequest(evUrl, { headers: { 'Authorization': `Bearer ${access_token}` } });
            const evData = evRes.json();
            const events = evData.items || [];
            
            debugLog.events_analyzed += events.length;

            for (const ev of events) {
                if (ev.status === 'cancelled') continue;
                const startStr = ev.start.dateTime || ev.start.date;
                const endStr = ev.end.dateTime || ev.end.date;
                if (!startStr || !endStr) continue;

                const start = new Date(startStr);
                const end = new Date(endStr);
                const text = (ev.summary || "") + " " + (ev.description || "");

                const isRunCall = /run[\s-]?call/i.test(text);
                
                if (isRunCall) {
                    debugLog.runcall_events_found++;
                    availRanges.push({ start: start.toISOString(), end: end.toISOString(), calendar: cal.summary });
                }
            }
        }

        // On renvoie directement le rapport brut, sans calcul de slots pour l'instant
        return res.status(200).json({ 
            slots: availRanges, // On renvoie les événements bruts comme slots pour voir si on les attrape
            debug_info: debugLog 
        });

    } catch (e) {
        return res.status(200).json({ slots: [], debug: "CRASH", error: e.message });
    }
};
