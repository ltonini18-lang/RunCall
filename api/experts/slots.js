// /api/experts/slots.js

// ------------------------------------------------------------------
// 1. HELPERS
// ------------------------------------------------------------------

function overlaps(aStart, aEnd, bStart, bEnd) {
  // Vérifie si deux plages horaires se chevauchent
  return aStart < bEnd && bStart < aEnd;
}

function parseGoogleEventTime(t) {
  if (!t) return null;
  // On ignore les événements "toute la journée" (qui n'ont que 'date' et pas 'dateTime')
  // car ils servent souvent à marquer des vacances ou des infos globales, pas des créneaux précis.
  if (t.dateTime) return new Date(t.dateTime);
  return null;
}

// Détection intelligente du mot clé (Regex)
function isRunCallAvailability(text) {
  if (!text) return false;
  // Regex : cherche "run" suivi optionnellement d'un tiret ou espace, suivi de "call"
  // Flag 'i' = insensible à la casse (majuscule/minuscule)
  // Matche : "RunCall", "run-call", "Run Call", "runcall", "Dispo RunCall", etc.
  return /run[\s-]?call/i.test(text);
}

// Détection des réservations officielles (taggées par le système)
function isRunCallBookingEvent(ev) {
  const t = ev?.extendedProperties?.private?.runcall_type;
  return String(t || "").toLowerCase() === "booking";
}

// ------------------------------------------------------------------
// 2. GOOGLE & SUPABASE LOGIC
// ------------------------------------------------------------------

async function refreshAccessToken(refreshToken) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Missing GOOGLE_CLIENT_ID/SECRET");

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
  if (!r.ok) throw new Error("Google refresh_token failed: " + text);
  const data = JSON.parse(text);

  return {
    access_token: data.access_token,
    expires_in: data.expires_in || null,
    token_type: data.token_type || "Bearer",
    scope: data.scope || null,
  };
}

async function supabaseGetGoogleAccount(expertId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error("Missing SUPABASE env vars");

  // On récupère les infos Google de l'expert
  const url =
    `${SUPABASE_URL}/rest/v1/expert_google_accounts?` +
    `select=expert_id,google_email,access_token,refresh_token,scope,expiry_date&` +
    `expert_id=eq.${encodeURIComponent(expertId)}&limit=1`;

  const r = await fetch(url, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });

  if (!r.ok) throw new Error("Supabase get google account failed");
  const rows = await r.json();
  return rows[0] || null;
}

async function supabaseUpdateGoogleAccount(expertId, patch) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  
  const url = `${SUPABASE_URL}/rest/v1/expert_google_accounts?expert_id=eq.${encodeURIComponent(expertId)}`;

  await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(patch),
  });
}

// ------------------------------------------------------------------
// 3. GOOGLE API CALLS
// ------------------------------------------------------------------

async function googleListCalendars(accessToken) {
  const url = "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250";
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) return []; // Fail soft
  const data = await r.json();
  return Array.isArray(data.items) ? data.items : [];
}

async function googleListEvents({ accessToken, calendarId, timeMin, timeMax }) {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
  );
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "2500");
  url.searchParams.set("showDeleted", "false"); // On ne veut pas les événements supprimés

  // On demande explicitement les champs nécessaires
  url.searchParams.set(
    "fields",
    "items(id,status,summary,description,transparency,start,end,extendedProperties)"
  );

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!r.ok) throw new Error(`Google events list failed: ${r.status}`);
  const data = await r.json();
  return Array.isArray(data.items) ? data.items : [];
}

// ------------------------------------------------------------------
// 4. MAIN HANDLER
// ------------------------------------------------------------------

export default async function handler(req, res) {
  // Permettre l'accès depuis n'importe où (CORS) car c'est une API publique pour les clients
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const expertId = String(req.query.expert_id || "").trim();
    if (!expertId) return res.status(400).json({ error: "Missing expert_id" });

    // Dates par défaut : Aujourd'hui -> +14 jours
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const now = new Date();
    const defaultFrom = now.toISOString();
    const defaultTo = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const timeMin = from || defaultFrom;
    const timeMax = to || defaultTo;

    // 1. Récupération compte Google
    const account = await supabaseGetGoogleAccount(expertId);
    if (!account) return res.status(404).json({ error: "Expert not connected to Google" });

    // 2. Gestion Refresh Token (si expiré)
    let accessToken = account.access_token;
    const refreshToken = account.refresh_token;
    const expiry = account.expiry_date ? Number(account.expiry_date) : null;
    const isExpired = !expiry || Date.now() > expiry - 60_000; // Marge de 1min

    if (!accessToken || isExpired) {
      if (!refreshToken) {
        return res.status(401).json({ error: "Refresh token missing. Please reconnect." });
      }
      const refreshed = await refreshAccessToken(refreshToken);
      accessToken = refreshed.access_token;
      
      // Sauvegarde du nouveau token
      await supabaseUpdateGoogleAccount(expertId, {
        access_token: accessToken,
        scope: refreshed.scope || account.scope,
        expiry_date: Date.now() + (refreshed.expires_in * 1000),
      });
    }

    // 3. Récupération des Calendriers (Lecture seule ou propriétaire)
    const calendars = await googleListCalendars(accessToken);
    const readableCalendars = calendars
      .filter((c) => c && c.id && (c.accessRole === "owner" || c.accessRole === "writer" || c.accessRole === "reader"))
      .map((c) => c.id);

    // 4. Récupération et Tri des Événements
    const availabilityIntervals = []; // Les plages où l'expert a dit "RunCall"
    const busyIntervals = [];         // Les plages où l'expert est occupé (autre RDV, Dentiste, etc.)

    for (const calId of readableCalendars) {
      const events = await googleListEvents({ accessToken, calendarId: calId, timeMin, timeMax });

      for (const ev of events) {
        if (!ev || ev.status === "cancelled") continue;

        const start = parseGoogleEventTime(ev.start);
        const end = parseGoogleEventTime(ev.end);
        if (!start || !end || end <= start) continue;

        // A. C'est une réservation RunCall confirmée ? -> OCCUPÉ
        if (isRunCallBookingEvent(ev)) {
          busyIntervals.push({ start, end });
          continue;
        }

        // B. Analyse du titre/description pour trouver "RunCall"
        const haystack = `${ev.summary || ""} ${ev.description || ""}`;
        
        if (isRunCallAvailability(haystack)) {
          // C'est un créneau d'ouverture !
          availabilityIntervals.push({ start, end });
        } else {
          // C. Sinon, est-ce un événement "Occupé" ? (Défaut Google)
          // Si l'event est marqué "Disponible" (transparency = 'transparent'), on ne bloque pas.
          if (ev.transparency !== "transparent") {
            busyIntervals.push({ start, end });
          }
        }
      }
    }

    // 5. Découpage en créneaux de 30 min (The Slicer)
    const SLOT_MIN = 30;
    const slots = [];

    for (const range of availabilityIntervals) {
      const endMs = range.end.getTime();
      
      // On commence au début de l'événement
      let cursor = new Date(range.start.getTime());

      // Optionnel : On peut vouloir aligner sur :00 ou :30 pile.
      // Le code ci-dessous aligne le curseur au prochain :00 ou :30 si l'event commence à 14:10
      const m = cursor.getMinutes();
      const mod = m % SLOT_MIN;
      if (mod !== 0) cursor.setMinutes(m + (SLOT_MIN - mod), 0, 0);
      else cursor.setSeconds(0, 0);

      // Boucle tant qu'une tranche complète de 30min rentre avant la fin
      while (cursor.getTime() + SLOT_MIN * 60 * 1000 <= endMs) {
        const slotStart = new Date(cursor);
        const slotEnd = new Date(cursor.getTime() + SLOT_MIN * 60 * 1000);

        // Vérification des conflits (Dentiste, autre RDV...)
        let conflict = false;
        for (const busy of busyIntervals) {
          if (overlaps(slotStart, slotEnd, busy.start, busy.end)) {
            conflict = true;
            break;
          }
        }

        // Si pas de conflit, on ajoute le créneau
        if (!conflict) {
          slots.push({ 
            start: slotStart.toISOString(), 
            end: slotEnd.toISOString(),
            status: 'available' 
          });
        }

        // On avance le curseur de 30 min
        cursor = new Date(cursor.getTime() + SLOT_MIN * 60 * 1000);
      }
    }

    // 6. Nettoyage final (Tri + Dédoublonnage)
    slots.sort((a, b) => new Date(a.start) - new Date(b.start));
    
    const uniqueSlots = [];
    const seen = new Set();
    for (const s of slots) {
      const key = `${s.start}|${s.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueSlots.push(s);
      }
    }

    // Retourne la liste propre
    return res.status(200).json(uniqueSlots);

  } catch (e) {
    console.error("API Slots Error:", e);
    return res.status(500).json({ error: "Server Error", details: e.message });
  }
}
