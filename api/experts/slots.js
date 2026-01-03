// /api/experts/slots.js

function overlaps(aStart, aEnd, bStart, bEnd) {
  // true if intervals overlap
  return aStart < bEnd && bStart < aEnd;
}

function toISODateTime(d) {
  return new Date(d).toISOString();
}

function parseGoogleEventTime(t) {
  // Google can return { dateTime, timeZone } or { date } for all-day
  if (!t) return null;
  if (t.dateTime) return new Date(t.dateTime);
  if (t.date) {
    // All-day event: approximate as midnight UTC start
    // (Good enough to block the day; we’ll refine later if needed)
    return new Date(t.date + "T00:00:00.000Z");
  }
  return null;
}

async function refreshAccessToken(refreshToken) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
  }

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
  if (!r.ok) {
    throw new Error("Google refresh_token failed: " + text);
  }

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
    `select=expert_id,calendar_id,access_token,refresh_token,token_type,scope,expiry_date&` +
    `expert_id=eq.${encodeURIComponent(expertId)}&limit=1`;

  const r = await fetch(url, {
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`
    }
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

async function googleListEvents({ accessToken, calendarId, timeMin, timeMax }) {
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "2500");

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const text = await r.text();
  if (!r.ok) throw new Error("Google events.list failed: " + text);

  const data = JSON.parse(text);
  return Array.isArray(data.items) ? data.items : [];
}

export default async function handler(req, res) {
  try {
    const expertId = String(req.query.expert_id || "").trim();
    if (!expertId) return res.status(400).json({ error: "Missing expert_id" });

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    // If UI didn’t pass from/to, default to now -> +14 days
    const now = new Date();
    const defaultFrom = toISODateTime(now);
    const defaultTo = toISODateTime(new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000));

    const timeMin = from || defaultFrom;
    const timeMax = to || defaultTo;

    const account = await supabaseGetGoogleAccount(expertId);
    if (!account) {
      return res.status(404).json({ error: "Google not connected for this expert" });
    }

    let accessToken = account.access_token;
    const refreshToken = account.refresh_token;
    const calendarId = account.calendar_id || "primary";

    // Refresh token if expired (or missing access token)
    const expiry = account.expiry_date ? Number(account.expiry_date) : null;
    const isExpired = !expiry || Date.now() > (expiry - 60_000); // 60s safety
    if (!accessToken || isExpired) {
      if (!refreshToken) {
        return res.status(401).json({ error: "Missing refresh_token (reconnect Google Calendar)" });
      }

      const refreshed = await refreshAccessToken(refreshToken);
      accessToken = refreshed.access_token;

      const newExpiry = refreshed.expires_in ? (Date.now() + refreshed.expires_in * 1000) : null;

      await supabaseUpdateGoogleAccount(expertId, {
        access_token: accessToken,
        token_type: refreshed.token_type || "Bearer",
        scope: refreshed.scope || account.scope || null,
        expiry_date: newExpiry
      });
    }

    // Fetch events
    const events = await googleListEvents({ accessToken, calendarId, timeMin, timeMax });

    // Availability keywords
    const isRunCall = (summary) => {
      const s = String(summary || "");
      return /runcall/i.test(s) || /run-call/i.test(s);
    };

    // Build intervals
    const availabilityIntervals = [];
    const busyIntervals = [];

    for (const ev of events) {
      if (ev.status === "cancelled") continue;

      const start = parseGoogleEventTime(ev.start);
      const end = parseGoogleEventTime(ev.end);
      if (!start || !end) continue;
      if (!(start instanceof Date) || !(end instanceof Date)) continue;
      if (end <= start) continue;

      // Ignore events without title? treat as busy by default
      const summary = ev.summary || "";

      if (isRunCall(summary)) {
        availabilityIntervals.push({ start, end });
      } else {
        // Non-RunCall = busy, blocks availability
        busyIntervals.push({ start, end });
      }
    }

    // Split into 30-min slots, removing conflicts with busy
    const SLOT_MIN = 30;
    const slots = [];

    for (const a of availabilityIntervals) {
      const startMs = a.start.getTime();
      const endMs = a.end.getTime();

      // Round up start to next 30-min boundary (optional, nicer UX)
      let cursor = new Date(startMs);
      const minutes = cursor.getMinutes();
      const mod = minutes % SLOT_MIN;
      if (mod !== 0) cursor.setMinutes(minutes + (SLOT_MIN - mod), 0, 0);
      else cursor.setSeconds(0, 0);

      while (cursor.getTime() + SLOT_MIN * 60 * 1000 <= endMs) {
        const slotStart = new Date(cursor);
        const slotEnd = new Date(cursor.getTime() + SLOT_MIN * 60 * 1000);

        // Conflict check
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

    // Sort & dedupe (just in case multiple availability events overlap)
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
