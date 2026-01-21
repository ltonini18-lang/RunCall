// api/experts/slots.js - MODE DEBUG / MOUCHARD

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
    // On force le JSON pour lecture facile dans le navigateur
    res.setHeader('Content-Type', 'application/json'); 
    
    const logs = [];
    const log = (msg, data) => logs.push({ msg, data: data || null });

    try {
        const expertId = req.query.expert_id;
        log("1. Start", { expertId, time: new Date().toISOString() });

        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        
        // Récup compte
        const accRes = await simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}&limit=1`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
        });
        const rows = accRes.json();
        
        if (!rows || !rows.length) {
            return res.json({ error: "Aucun compte Google trouvé pour cet expert", logs });
        }
        
        const account = rows[0];
        log("2. Compte Google trouvé", { email: account.google_email });

        // On saute le refresh token pour ce test (on suppose que le token est valide ou on verra l'erreur)
        const token = account.access_token;

        // Lister calendriers
        const calRes = await simpleRequest("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const calData = calRes.json();
        
        if (!calData.items) {
            return res.json({ error: "Impossible de lister les calendriers (Token expiré ?)", logs, googleResponse: calData });
        }

        const calendars = calData.items.filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');
        log("3. Calendriers analysés", calendars.map(c => c.summary));

        const foundEvents = [];
        const rejectedEvents = [];

        // Scan des events (sur 7 jours pour aller vite)
        const now = new Date();
        const max = new Date(); max.setDate(max.getDate() + 7);
        
        for (const cal of calendars) {
            const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?singleEvents=true&timeMin=${now.toISOString()}&timeMax=${max.toISOString()}`;
            const evRes = await simpleRequest(url, { headers: { 'Authorization': `Bearer ${token}` } });
            const evData = evRes.json();
            
            if (evData.items) {
                evData.items.forEach(ev => {
                    const title = ev.summary || "Sans titre";
                    const isRunCall = /run[\s-]?call/i.test(title + (ev.description || ""));
                    
                    if (isRunCall) {
                        foundEvents.push({ 
                            summary: ev.summary, 
                            start: ev.start,
                            isAllDay: !ev.start.dateTime, // Vrai si c'est toute la journée
                            status: "Trouvé !" 
                        });
                    } else {
                        // On loggue juste quelques rejetés pour vérifier
                        if (rejectedEvents.length < 5) rejectedEvents.push(ev.summary);
                    }
                });
            }
        }

        log("4. Bilan", { runCallEventsFound: foundEvents, otherEventsSample: rejectedEvents });

        // On renvoie le rapport complet
        return res.json({ 
            status: "DEBUG REPORT",
            message: foundEvents.length ? "Événements trouvés !" : "Aucun événement RunCall vu.",
            details: foundEvents,
            full_logs: logs
        });

    } catch (e) {
        return res.json({ error: "Crash", msg: e.message, stack: e.stack, logs });
    }
};
