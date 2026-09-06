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

// Where magic links should land. Never localhost: a link created on a dev machine has
// to be clickable from a phone, and localhost isn't reachable from another device.
const PROD_URL = 'https://struck-matchbook.vercel.app'
function signInRedirectTo() {
  const configured = import.meta.env.VITE_SITE_URL
  if (configured) return configured
  if (typeof window === 'undefined') return PROD_URL
  const { hostname, origin } = window.location
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostname)) return PROD_URL
  return origin
}

// Send a magic-link sign-in email. No password to manage — click the link to finish signing in.
export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: signInRedirectTo() },
  })
  if (error) throw error
}

// Password sign-in. Unlike magic links this sends no email at all, so it isn't subject
// to the auth email rate limit — which is what makes it usable for the admin account.
// Users are created directly in the Supabase dashboard (Authentication → Users).
//
// An anonymous session is already active by this point; signing in with a password from
// that state errors, so drop the anonymous session first.
export async function signInWithPassword(email, password) {
  const { data: sess } = await supabase.auth.getSession()
  if (sess?.session?.user?.is_anonymous) await supabase.auth.signOut()
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data.user
}

// Send a password-reset email. The link brings the user back to the site with
// a recovery session active; the app then shows a "set a new password" form.
export async function sendPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: signInRedirectTo() + '?recover=1',
  })
  if (error) throw error
}

// Set a new password for the currently signed-in user. Called after arriving via
// the recovery link, and can also be used for a normal password change later.
export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
}

// Create a new account with email + password. Whether Supabase demands email
// confirmation depends on the "Confirm email" setting in the dashboard.
export async function signUpWithPassword(email, password) {
  const { data: sess } = await supabase.auth.getSession()
  if (sess?.session?.user?.is_anonymous) await supabase.auth.signOut()
  const { data, error } = await supabase.auth.signUp({
    email, password,
    options: { emailRedirectTo: signInRedirectTo() },
  })
  if (error) throw error
  return data.user
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
