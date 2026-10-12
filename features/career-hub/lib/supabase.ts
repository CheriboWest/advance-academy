import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client for the public student portal.
 *
 * Reads are performed with the public anon key against a read-only view and
 * public tables — there is no authentication in this milestone. The client is
 * created lazily so importing this module never throws at build time when the
 * environment variables are absent (pages are rendered dynamically at request
 * time, see `export const dynamic = "force-dynamic"` on the data pages).
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      "Missing Supabase environment variables. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (see .env.local.example)."
    );
  }

  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  return client;
}
