// /api/experts/slots.js

// ------------------------------------------------------------------
// 1. HELPERS
// ------------------------------------------------------------------

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function parseGoogleEventTime(t) {
  if (!t) return null;
  // On ignore les événements "toute la journée"
  if (t.dateTime) return new Date(t.dateTime);
  return null;
}

// Regex souple pour détecter "RunCall"
function isRunCallAvailability(text) {
  if (!text) return false;
  return /run[\s-]?call/i.test(text);
}

function isRunCallBookingEvent(ev) {
  const t = ev?.extendedProperties?.private?.runcall_type;
  return String(t || "").toLowerCase() === "booking";
}

// ------------------------------------------------------------------
// 2. GESTION GOOGLE & SUPABASE
// ------------------------------------------------------------------

async function refreshAccessToken(refreshToken) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  
  // Utilisation de fetch natif (compatible Node 18+)
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

// ------------------------------------------------------------------
// 3. APPELS GOOGLE CALENDAR
// ------------------------------------------------------------------

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
  url.searchParams.set("fields", "items(id,status,summary,description,transparency,start,end,extendedProperties)");

  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return [];
  const data = await r.json();
  return data.items || [];
}

// ------------------------------------------------------------------
// 4. LE HANDLER PRINCIPAL (Syntaxe Universelle)
// ------------------------------------------------------------------

module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const expertId = req.query.expert_id;
    if (!expertId) return res.status(400).json({ error: "Missing expert_id" });

    const now = new Date();
    const from = req.query.from || now.toISOString();
    const to = req.query.to || new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Récupérer Tokens
    const account = await supabaseGetGoogleAccount(expertId);
    if (!account) return res.status(404).json({ error: "Expert not connected" });

    let { access_token, refresh_token, expiry_date } = account;

    // 2. Refresh Token
    if (!access_token || (expiry_date && Date.now() > Number(expiry_date) - 60000)) {
        if (!refresh_token) return res.status(401).json({ error: "Refresh token missing" });
        const refreshed = await refreshAccessToken(refresh_token);
        access_token = refreshed.access_token;
        const newExpiry = Date.now() + (refreshed.expires_in * 1000);
        await supabaseUpdateGoogleAccount(expertId, { access_token, expiry_date: newExpiry });
    }

    // 3. Scanner les calendriers
    const calendars = await googleListCalendars(access_token);
    const targets = calendars.filter(c => c.accessRole === 'owner' || c.accessRole === 'writer').map(c => c.id);

    const availabilityRanges = [];
    const busyRanges = [];

    for (const calId of targets) {
        const events = await googleListEvents({ accessToken: access_token, calendarId: calId, timeMin: from, timeMax: to });
        
        for (const ev of events) {
            if (ev.status === 'cancelled') continue;
            
            const start = parseGoogleEventTime(ev.start);
            const end = parseGoogleEventTime(ev.end);
            if (!start || !end) continue;

            const haystack = `${ev.summary || ""} ${ev.description || ""}`;

            if (isRunCallBookingEvent(ev)) {
                busyRanges.push({ start, end });
            } else if (isRunCallAvailability(haystack)) {
                availabilityRanges.push({ start, end });
            } else if (ev.transparency !== 'transparent') {
                busyRanges.push({ start, end });
            }
        }
    }

    // 4. Découpe en 30 min
    const SLOT_MIN = 30;
    const finalSlots = [];

    for (const range of availabilityRanges) {
        const rangeEndMs = range.end.getTime();
        let cursor = new Date(range.start.getTime());

        while (cursor.getTime() + SLOT_MIN * 60000 <= rangeEndMs) {
            const slotStart = new Date(cursor);
            const slotEnd = new Date(cursor.getTime() + SLOT_MIN * 60000);

            let isConflict = false;
            for (const busy of busyRanges) {
                if (overlaps(slotStart, slotEnd, busy.start, busy.end)) {
                    isConflict = true;
                    break;
                }
            }

            if (!isConflict) {
                finalSlots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
            }
            cursor = new Date(cursor.getTime() + SLOT_MIN * 60000);
        }
    }

    finalSlots.sort((a, b) => new Date(a.start) - new Date(b.start));
    
    // Dédoublonnage
    const uniqueSlots = [];
    const seen = new Set();
    for (const s of finalSlots) {
        const k = s.start + "|" + s.end;
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
