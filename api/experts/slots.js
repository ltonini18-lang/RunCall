// /api/experts/slots.js

// --- 1. FONCTIONS UTILITAIRES ---

// Vérifie si deux intervalles se chevauchent
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Convertit la date Google (ignore les événements journée entière)
function parseGoogleEventTime(t) {
  if (!t) return null;
  if (t.dateTime) return new Date(t.dateTime);
  return null;
}

// ✅ RÈGLE 1 : Détection souple du titre (Regex)
// Matche : "RunCall", "run-call", "runcall", "Run Call", "Dispo RunCall", etc.
function isRunCallAvailability(text) {
  if (!text) return false;
  // Regex : "run" + séparateur optionnel + "call" (flag i = insensible à la casse)
  return /run[\s-]?call/i.test(text);
}

// Détecte si c'est une réservation RunCall (pour ne pas la compter comme dispo)
function isRunCallBookingEvent(ev) {
  const t = ev?.extendedProperties?.private?.runcall_type;
  return String(t || "").toLowerCase() === "booking";
}

// Normalise le texte (enlève accents et caractères spéciaux) pour comparaison basique si besoin
function normalizeText(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
}


// --- 2. GESTION GOOGLE & SUPABASE ---

async function refreshAccessToken(refreshToken) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const text = await r.text();
  if (!r.ok) throw new Error("Google refresh failed: " + text);
  return JSON.parse(text);
}

async function supabaseGetGoogleAccount(expertId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  const url = `${SUPABASE_URL}/rest/v1/expert_google_accounts?expert_id=eq.${encodeURIComponent(expertId)}&limit=1`;
  const r = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}

async function supabaseUpdateGoogleAccount(expertId, patch) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = `${SUPABASE_URL}/rest/v1/expert_google_accounts?expert_id=eq.${encodeURIComponent(expertId)}`;
  
  await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}

// --- 3. APPELS GOOGLE CALENDAR ---

async function googleListCalendars(accessToken) {
  const r = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=20", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return [];
  const data = await r.json();
  return data.items || [];
}

async function googleListEvents({ accessToken, calendarId, timeMin, timeMax }) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("showDeleted", "false");
  // Optimisation : on demande juste les champs utiles
  url.searchParams.set("fields", "items(id,status,summary,description,transparency,start,end,extendedProperties)");

  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return []; // On ignore les erreurs de calendrier (ex: non partagé)
  const data = await r.json();
  return data.items || [];
}


// --- 4. LE MOTEUR (Handler) ---

// ⚠️ SYNTAXE UNIVERSELLE (module.exports) POUR ÉVITER LE 404 SUR VERCEL
module.exports = async (req, res) => {
  // CORS (Pour que ton frontend puisse appeler l'API)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const expertId = req.query.expert_id;
    if (!expertId) return res.status(400).json({ error: "Missing expert_id" });

    // Dates
    const now = new Date();
    const from = req.query.from || now.toISOString();
    // Par défaut 2 semaines si pas précisé
    const to = req.query.to || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Récupérer Tokens
    const account = await supabaseGetGoogleAccount(expertId);
    if (!account) return res.status(404).json({ error: "Expert not connected" });

    let { access_token, refresh_token, expiry_date } = account;

    // 2. Refresh Token si besoin
    if (!access_token || (expiry_date && Date.now() > Number(expiry_date) - 60000)) {
        if (!refresh_token) return res.status(401).json({ error: "Refresh token missing" });
        
        try {
            const refreshed = await refreshAccessToken(refresh_token);
            access_token = refreshed.access_token;
            const newExpiry = Date.now() + (refreshed.expires_in * 1000);
            
            await supabaseUpdateGoogleAccount(expertId, { 
                access_token, 
                expiry_date: newExpiry 
            });
        } catch (e) {
            console.error("Refresh failed", e);
            return res.status(401).json({ error: "Google auth failed" });
        }
    }

    // 3. Scanner les calendriers
    const calendars = await googleListCalendars(access_token);
    // On garde Owner et Writer (ceux où l'expert a le contrôle)
    const targets = calendars
        .filter(c => c.accessRole === 'owner' || c.accessRole === 'writer')
        .map(c => c.id);

    const availabilityRanges = []; // Plages "RunCall"
    const busyRanges = [];         // Plages "Occupé"

    // Scan des événements
    for (const calId of targets) {
        const events = await googleListEvents({ accessToken: access_token, calendarId: calId, timeMin: from, timeMax: to });
        
        for (const ev of events) {
            if (ev.status === 'cancelled') continue;
            
            const start = parseGoogleEventTime(ev.start);
            const end = parseGoogleEventTime(ev.end);
            if (!start || !end) continue;

            // Logique de tri
            const title = ev.summary || "";
            const desc = ev.description || "";
            const text = title + " " + desc;

            if (isRunCallBookingEvent(ev)) {
                // C'est une réservation RunCall -> C'est occupé
                busyRanges.push({ start, end });
            } else if (isRunCallAvailability(text)) {
                // ✅ C'est un créneau d'ouverture !
                availabilityRanges.push({ start, end });
            } else if (ev.transparency !== 'transparent') {
                // C'est un événement standard Google (ex: Dentiste) -> C'est occupé
                busyRanges.push({ start, end });
            }
        }
    }

    // ✅ RÈGLE 2 : LA DÉCOUPE EN 30 MIN (Slicing)
    const SLOT_MIN = 30;
    const finalSlots = [];

    for (const range of availabilityRanges) {
        const rangeEndMs = range.end.getTime();
        let cursor = new Date(range.start.getTime());

        // On cale le curseur sur une minute "propre" si besoin (optionnel)
        // Ici on respecte l'heure de début exacte de l'événement
        
        // Boucle tant qu'une tranche de 30min rentre
        while (cursor.getTime() + SLOT_MIN * 60000 <= rangeEndMs) {
            const slotStart = new Date(cursor);
            const slotEnd = new Date(cursor.getTime() + SLOT_MIN * 60000);

            // Vérif conflit
            let isConflict = false;
            for (const busy of busyRanges) {
                if (overlaps(slotStart, slotEnd, busy.start, busy.end)) {
                    isConflict = true;
                    break;
                }
            }

            if (!isConflict) {
                finalSlots.push({
                    start: slotStart.toISOString(),
                    end: slotEnd.toISOString()
                });
            }

            // On avance de 30 min
            cursor = new Date(cursor.getTime() + SLOT_MIN * 60000);
        }
    }

    // Tri final
    finalSlots.sort((a, b) => new Date(a.start) - new Date(b.start));

    // Dédoublonnage (si l'expert a mis 2 events RunCall identiques)
    const uniqueSlots = [];
    const seen = new Set();
    for (const s of finalSlots) {
        const k = s.start + s.end;
        if (!seen.has(k)) {
            seen.add(k);
            uniqueSlots.push(s);
        }
    }

    return res.status(200).json(uniqueSlots);

  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message });
  }
};
