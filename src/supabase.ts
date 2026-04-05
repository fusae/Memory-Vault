import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _supabase: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (_supabase) return _supabase;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  _supabase = createClient(url, key, {
    auth: {
      autoRefreshToken: true,
      persistSession: false, // We handle persistence ourselves
    },
  });

  return _supabase;
}

export function createSupabaseClient(url: string, anonKey: string): SupabaseClient {
  _supabase = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: false,
    },
  });
  return _supabase;
}
