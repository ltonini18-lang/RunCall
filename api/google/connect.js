// /api/google/connect.js
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const expertId = String(req.query.expert_id || "").trim();
  if (!expertId) return res.status(400).send("Missing expert_id");

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  if (!CLIENT_ID) return res.status(500).send("Server not configured");

  // ✅ Build redirect URI from current host (preview vs prod)
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const REDIRECT_URI = `${proto}://${host}/api/google/callback`;

  const scope = encodeURIComponent(
    [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/userinfo.email"
    ].join(" ")
  );

  // ✅ Return to the correct environment after onboarding connect
  const baseUrl = `${proto}://${host}`;
  const next = `${baseUrl}/dashboard.html`;

  const state = encodeURIComponent(JSON.stringify({ expert_id: expertId, next }));

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +          // ✅ onboarding wants refresh_token
    `&prompt=consent` +               // ✅ only onboarding forces consent
    `&include_granted_scopes=true` +
    `&state=${state}`;

  return res.redirect(302, authUrl);
}
