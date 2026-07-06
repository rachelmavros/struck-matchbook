import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anon) {
  console.warn('Supabase env vars missing — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
}

export const supabase = createClient(url || 'http://localhost', anon || 'anon', {
  auth: { persistSession: true, autoRefreshToken: true },
})

// Ensure there is a (possibly anonymous) user so wishlist/visited can persist.
export async function ensureUser() {
  const { data } = await supabase.auth.getSession()
  if (data?.session?.user) return data.session.user
  const { data: signed, error } = await supabase.auth.signInAnonymously()
  if (error) { console.warn('Anonymous sign-in failed:', error.message); return null }
  return signed?.user || null
}
