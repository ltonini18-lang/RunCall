// /api/google/login.js
export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

  // ✅ Callback stable (prod)
  const REDIRECT_URI = "https://www.run-call.com/api/google/callback";

  if (!CLIENT_ID) {
    return res.status(500).send("Server not configured");
  }

  const scope = encodeURIComponent(
    [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/calendar.events"
    ].join(" ")
  );

  // ✅ On renverra l’utilisateur vers l’environnement qui a initié le login (preview ou prod)
  const baseUrl = `https://${req.headers.host}`;
  const next = `${baseUrl}/dashboard.html`;

  const state = encodeURIComponent(JSON.stringify({ flow: "login", next }));

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${scope}` +
    `&access_type=offline` +
    `&include_granted_scopes=true` +
    `&prompt=select_account` + // ✅ évite de redemander les scopes inutilement
    `&state=${state}`;

  return res.redirect(302, authUrl);
}
