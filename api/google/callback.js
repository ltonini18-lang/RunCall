// /api/google/callback.js

async function upsertGoogleAccount({ expertId, tokenData, googleEmail }) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const payload = {
    expert_id: expertId,
    provider: "google",
    google_email: googleEmail || null,
    calendar_id: "primary",
    access_token: tokenData.access_token || null,
    refresh_token: tokenData.refresh_token || null,
    token_type: tokenData.token_type || null,
    scope: tokenData.scope || null,
    expiry_date: tokenData.expires_in
      ? Date.now() + tokenData.expires_in * 1000
      : null
  };

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/expert_google_accounts?on_conflict=expert_id`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify([payload])
    }
  );

  if (!res.ok) {
    throw new Error("Supabase upsert failed");
  }
}

async function fetchGoogleEmail(accessToken) {
  const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.email || null;
}

export default async function handler(req, res) {
  const code = String(req.query.code || "");
  const stateRaw = String(req.query.state || "");

  if (!code || !stateRaw) {
    return res.status(400).send("Missing code or state");
  }

  let expertId;
  try {
    const state = JSON.parse(decodeURIComponent(stateRaw));
    expertId = state.expert_id;
  } catch {
    return res.status(400).send("Invalid state");
  }

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

  if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    return res.status(500).send("Server not configured");
  }

  // Exchange code for tokens
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: "authorization_code"
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    return res.status(500).send("Token exchange failed");
  }

  const googleEmail = tokenData.access_token
    ? await fetchGoogleEmail(tokenData.access_token)
    : null;

  await upsertGoogleAccount({
    expertId,
    tokenData,
    googleEmail
  });

  return res.redirect(
    302,
    `/connect-calendar.html?expert_id=${encodeURIComponent(
      expertId
    )}&connected=1`
  );
}
