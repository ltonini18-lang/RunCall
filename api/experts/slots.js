// /api/experts/slots.js
// VERSION SAFE MODE : Tout est chargé à la demande pour éviter le crash au démarrage (404)

module.exports = async (req, res) => {
    // 1. Headers CORS (Pour autoriser le Dashboard à lire la réponse)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    // Répondre OK tout de suite aux requêtes de pré-vérification (OPTIONS)
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 2. Bloc de sécurité global
    try {
        // CHARGEMENT DYNAMIQUE (Pour éviter que le fichier plante si une lib manque)
        const https = require('https');
        const urlModule = require('url'); // Souvent utile pour parser proprement

        // --- DÉBUT DES FONCTIONS INTERNES ---
        
        // Fonction simpleRequest (remplace fetch pour être 100% natif Node.js)
        const simpleRequest = (url, options = {}) => {
            return new Promise((resolve, reject) => {
                const reqOpts = {
                    method: options.method || 'GET',
                    headers: options.headers || {}
                };
                
                // Gestion des body pour POST/PATCH
                let bodyData = options.body;
                if (bodyData && typeof bodyData !== 'string') {
                    // Si c'est pas une string, on le stringify (sauf si c'est déjà fait)
                    // Ici on assume que l'appelant gère le stringify si Content-Type est json
                }

                const req = https.request(url, reqOpts, (response) => {
                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => {
                        resolve({
                            ok: response.statusCode >= 200 && response.statusCode < 300,
                            status: response.statusCode,
                            json: () => {
                                try { return JSON.parse(data); } catch (e) { return null; }
                            },
                            text: () => data
                        });
                    });
                });

                req.on('error', (err) => reject(err));
                if (bodyData) req.write(bodyData);
                req.end();
            });
        };

        const parseTime = (t) => {
            if (!t) return null;
            if (t.dateTime) return new Date(t.dateTime);
            return null; 
        };

        const isRunCallAvailability = (text) => {
            if (!text) return false;
            return /run[\s-]?call/i.test(text);
        };

        const isBooking = (ev) => {
            const t = ev?.extendedProperties?.private?.runcall_type;
            return String(t || "").toLowerCase() === "booking";
        };

        const overlaps = (aStart, aEnd, bStart, bEnd) => {
            return aStart < bEnd && bStart < aEnd;
        };

        // --- FIN DES FONCTIONS INTERNES ---


        // 3. VÉRIFICATIONS PRÉLIMINAIRES
        const expertId = req.query.expert_id;
        if (!expertId) {
            // On renvoie un tableau vide plutôt qu'une erreur pour éviter de casser le front
            console.error("Missing expert_id");
            return res.status(200).json([]); 
        }

        const now = new Date();
        const from = req.query.from || now.toISOString();
        const to = req.query.to || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

        // 4. RÉCUPÉRATION DU TOKEN GOOGLE (Via Supabase)
        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!SUPA_URL || !SUPA_KEY) {
            throw new Error("Variables d'environnement SUPABASE manquantes sur Vercel.");
        }
        
        const accRes = await simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}&limit=1`, {
            headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
        });
        
        const accRows = accRes.json();
        const account = accRows ? accRows[0] : null;

        // Si pas de compte connecté, on renvoie une liste vide (pas d'erreur)
        if (!account) return res.status(200).json([]);

        let { access_token, refresh_token, expiry_date } = account;

        // 5. REFRESH TOKEN (Si expiré)
        if (!access_token || (expiry_date && Date.now() > Number(expiry_date) - 60000)) {
            if (!refresh_token) {
                console.error("Refresh token missing");
                return res.status(200).json([]); // Pas de crash
            }

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
                console.error("Google Refresh Failed:", refData);
                return res.status(200).json([]);
            }
            
            access_token = refData.access_token;
            const newExpiry = Date.now() + (refData.expires_in * 1000);
            
            // Mise à jour DB (Fire & Forget via un simpleRequest sans await strict ou avec catch)
            try {
                simpleRequest(`${SUPA_URL}/rest/v1/expert_google_accounts?expert_id=eq.${expertId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}`, 'Prefer': 'return=minimal' },
                    body: JSON.stringify({ access_token, expiry_date: newExpiry })
                });
            } catch(e) { /* On ignore l'erreur de save, tant qu'on a le token */ }
        }

        // 6. LISTER LES CALENDRIERS
        const calRes = await simpleRequest("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=20", {
            headers: { 'Authorization': `Bearer ${access_token}` }
        });
        const calData = calRes.json() || {};
        const calendars = (calData.items || []).filter(c => c.accessRole === 'owner' || c.accessRole === 'writer');

        const availRanges = [];
        const busyRanges = [];

        // 7. SCANNER LES ÉVÉNEMENTS
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

        // 8. DÉCOUPE EN TRANCHES DE 30 MIN
        const SLOT_MIN = 30;
        const finalSlots = [];

        for (const range of availRanges) {
            const rangeEndMs = range.end.getTime();
            let cursor = new Date(range.start.getTime());

            while (cursor.getTime() + SLOT_MIN * 60000 <= rangeEndMs) {
                const sStart = new Date(cursor);
                const sEnd = new Date(cursor.getTime() + SLOT_MIN * 60000);

                let conflict = false;
                for (const busy of busyRanges) {
                    if (overlaps(sStart, sEnd, busy.start, busy.end)) {
                        conflict = true; break;
                    }
                }

                if (!conflict) {
                    finalSlots.push({ start: sStart.toISOString(), end: sEnd.toISOString() });
                }
                cursor = new Date(cursor.getTime() + SLOT_MIN * 60000);
            }
        }

        // 9. TRI ET DÉDOUBLONNAGE
        finalSlots.sort((a, b) => new Date(a.start) - new Date(b.start));
        const unique = [];
        const seen = new Set();
        for (const s of finalSlots) {
            const k = s.start + s.end;
            if (!seen.has(k)) { seen.add(k); unique.push(s); }
        }

        // 10. RÉPONSE FINALE
        res.status(200).json(unique);

    } catch (e) {
        // EN CAS D'ERREUR CRITIQUE
        console.error("API CRASH:", e);
        // On renvoie 500 avec le détail pour comprendre ce qui se passe
        res.status(500).json({ 
            error: "Server Error", 
            message: e.message, 
            stack: e.stack 
        });
    }
};
