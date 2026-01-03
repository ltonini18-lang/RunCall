// /api/experts/slots.js

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function parseGoogleEventTime(t) {
  if (!t) return null;
  if (t.dateTime) return new Date(t.dateTime);
  if (t.date) return new Date(t.date + "T00:00:00.000Z"); // all-day
  return null;
}

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
      grant_type: "refresh_token"
    })
  });

  const text = await r.text();
  if (!r.ok) throw new Error("Google refresh_token failed: " + text);
  const data = JSON.parse(text);

  return {
    access_token: data.access_token,
    expires_in: data.expires_in || null,
    token_type: data.token_type || "Bearer",
    scope: data.scope || null
  };
}

async function supabaseGetGoogleAccount(expertId) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error("Missing SUPABASE env vars");

  const url =
    `${SUPABASE_URL}/rest/v1/expert_google_accounts?` +
    `select=expert_id,google_email,access_token,refresh_token,scope,expiry_date&` +
    `expert_id=eq.${encodeURIComponent(expertId)}&limit=1`;

  const r = await fetch(url, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }
  });

  const text = await r.text();
  if (!r.ok) throw new Error("Supabase get google account failed: " + text);
  const rows = JSON.parse(text || "[]");
  return rows[0] || null;
}

async function supabaseUpdateGoogleAccount(expertId, patch) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) throw new Error("Missing SUPABASE env vars");

  const url = `${SUPABASE_URL}/rest/v1/expert_google_accounts?expert_id=eq.${encodeURIComponent(expertId)}`;

  const r = await fetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      Prefer: "return=minimal"
    },
    body: JSON.stringify(patch)
  });

  const text = await r.text();
  if (!r.ok) throw new Error("Supabase update google account failed: " + text);
}

async function googleListCalendars(accessToken) {
  const url = "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250";
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const text = await r.text();
  if (!r.ok) throw new Error("Google calendarList.list failed: " + text);

  const data = JSON.parse(text);
  return Array.isArray(data.items) ? data.items : [];
}

async function googleListEvents({ accessToken, calendarId, timeMin, timeMax }) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "2500");
  url.searchParams.set("showDeleted", "false");

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const text = await r.text();
  if (!r.ok) throw new Error(`Google events.list failed (${calendarId}): ` + text);

  const data = JSON.parse(text);
  return Array.isArray(data.items) ? data.items : [];
}

export default async function handler(req, res) {
  try {
    const expertId = String(req.query.expert_id || "").trim();
    if (!expertId) return res.status(400).json({ error: "Missing expert_id" });

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const now = new Date();
    const defaultFrom = now.toISOString();
    const defaultTo = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const timeMin = from || defaultFrom;
    const timeMax = to || defaultTo;

    const account = await supabaseGetGoogleAccount(expertId);
    if (!account) return res.status(404).json({ error: "Google not connected for this expert" });

    let accessToken = account.access_token;
    const refreshToken = account.refresh_token;

    const expiry = account.expiry_date ? Number(account.expiry_date) : null;
    const isExpired = !expiry || Date.now() > (expiry - 60_000);

    if (!accessToken || isExpired) {
      if (!refreshToken) return res.status(401).json({ error: "Missing refresh_token (reconnect Google Calendar)" });
      const refreshed = await refreshAccessToken(refreshToken);
      accessToken = refreshed.access_token;

      const newExpiry = refreshed.expires_in ? (Date.now() + refreshed.expires_in * 1000) : null;

      await supabaseUpdateGoogleAccount(expertId, {
        access_token: accessToken,
        scope: refreshed.scope || account.scope || null,
        expiry_date: newExpiry
      });
    }

const isRunCall = (summary) => {
  const s = String(summary || "")
    .toLowerCase()
    .normalize("NFD")                     // enlève les accents
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");           // enlève espaces, tirets, symboles

  // accepte runcall, run-call, run call, etc.
  return s.includes("run") && s.includes("call") && s.indexOf("run") < s.indexOf("call");
};



    // 1) Get all calendars
    const calendars = await googleListCalendars(accessToken);

    // Only calendars you can read (and that are "selected" typically)
    const readableCalendars = calendars
      .filter(c => c && c.id && (c.accessRole === "owner" || c.accessRole === "writer" || c.accessRole === "reader"))
      .map(c => c.id);

    // 2) Fetch events across calendars (sequential to keep it robust)
    const availabilityIntervals = [];
    const busyIntervals = [];

    for (const calId of readableCalendars) {
      const events = await googleListEvents({ accessToken, calendarId: calId, timeMin, timeMax });

      for (const ev of events) {
        if (ev.status === "cancelled") continue;

        const start = parseGoogleEventTime(ev.start);
        const end = parseGoogleEventTime(ev.end);
        if (!start || !end || end <= start) continue;

        const summary = ev.summary || "";

if (isRunCall(summary)) {
  availabilityIntervals.push({ start, end });
} else {
  // Ne bloque pas les événements marqués "Libre" dans Google Calendar
  if (ev.transparency !== "transparent") {
    busyIntervals.push({ start, end });
  }
}

    // 3) Split availability into 30-min slots and remove conflicts with busy
    const SLOT_MIN = 30;
    const slots = [];

    for (const a of availabilityIntervals) {
      const endMs = a.end.getTime();

      let cursor = new Date(a.start.getTime());
      const m = cursor.getMinutes();
      const mod = m % SLOT_MIN;
      if (mod !== 0) cursor.setMinutes(m + (SLOT_MIN - mod), 0, 0);
      else cursor.setSeconds(0, 0);

      while (cursor.getTime() + SLOT_MIN * 60 * 1000 <= endMs) {
        const slotStart = new Date(cursor);
        const slotEnd = new Date(cursor.getTime() + SLOT_MIN * 60 * 1000);

        let conflict = false;
        for (const b of busyIntervals) {
          if (overlaps(slotStart, slotEnd, b.start, b.end)) {
            conflict = true;
            break;
          }
        }

        if (!conflict) {
          slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
        }

        cursor = new Date(cursor.getTime() + SLOT_MIN * 60 * 1000);
      }
    }

    // Sort + dedupe
    slots.sort((x, y) => new Date(x.start) - new Date(y.start));
    const deduped = [];
    const seen = new Set();
    for (const s of slots) {
      const key = `${s.start}|${s.end}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(s);
      }
    }

    return res.status(200).json({ slots: deduped });
  } catch (e) {
    console.error("slots error:", e);
    return res.status(500).json({ error: "Server error" });
  }
}
