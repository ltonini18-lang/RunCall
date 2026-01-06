// /api/_lib/google.js
async function getGoogleAccessToken(refreshToken) {
  const params = new URLSearchParams();
  params.set("client_id", process.env.GOOGLE_CLIENT_ID);
  params.set("client_secret", process.env.GOOGLE_CLIENT_SECRET);
  params.set("refresh_token", refreshToken);
  params.set("grant_type", "refresh_token");

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const d = await r.json();
  if (!r.ok) {
    throw new Error(d?.error_description || d?.error || "Failed to refresh Google token");
  }
  return d.access_token;
}

module.exports = { getGoogleAccessToken };
