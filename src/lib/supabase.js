import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anon) {
  console.warn('Supabase env vars missing — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
}

export const supabase = createClient(url || 'http://localhost', anon || 'anon', {
  auth: { persistSession: true, autoRefreshToken: true },
})

// Ensure there is a user — reuses any existing session (anonymous or a real signed-in
// account) rather than replacing it, so signing in with email doesn't get clobbered.
export async function ensureUser() {
  const { data } = await supabase.auth.getSession()
  if (data?.session?.user) return data.session.user
  const { data: signed, error } = await supabase.auth.signInAnonymously()
  if (error) { console.warn('Anonymous sign-in failed:', error.message); return null }
  return signed?.user || null
}

// Send a magic-link sign-in email. No password to manage — click the link to finish signing in.
export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  })
  if (error) throw error
}

export async function signOut() {
  await supabase.auth.signOut()
}

// Make sure a profiles row exists for this user (is_admin always defaults to false here —
// it can only be granted directly in SQL, never through the app).
export async function ensureProfile(user) {
  if (!user) return null
  const { data: existing } = await supabase.from('profiles').select('id,email,is_admin').eq('id', user.id).maybeSingle()
  if (existing) return existing
  const { data, error } = await supabase
    .from('profiles').insert({ id: user.id, email: user.email || null }).select('id,email,is_admin').single()
  if (error) { console.warn('ensureProfile failed:', error.message); return { id: user.id, email: user.email || null, is_admin: false } }
  return data
}
