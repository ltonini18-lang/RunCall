// api/_lib/supabase.js

const { createClient } = require("@supabase/supabase-js");

function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing Supabase env vars");
  }

  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

module.exports = { supabaseAdmin };
