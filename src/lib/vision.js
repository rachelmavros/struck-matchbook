import { supabase } from './supabase'

export const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const BUCKET = 'matchbooks'

/* ---------- serverless endpoints ---------- */

// Ask Claude to read the covers from an in-memory image. Returns { items, unreadable }.
// Each item may include a bbox (normalized [xmin,ymin,xmax,ymax]) for cropping.
export async function readMatchbooksImage({ base64, mediaType }) {
  const r = await fetch('/api/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageBase64: base64, mediaType }),
  })
  if (!r.ok) throw new Error('read failed: ' + r.status)
  return r.json()
}

// Place-search / geocode via server (Google Places if configured, else Nominatim).
// Returns an array of candidates: { name, address, neighborhood, type, lat, lng }.
export async function searchPlaces(query) {
  const r = await fetch('/api/geocode?q=' + encodeURIComponent(query))
  if (!r.ok) return []
  const j = await r.json()
  return j.results || []
}

/* ---------- storage ---------- */

export async function uploadPhoto(file, userId) {
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
  const path = `${userId || 'anon'}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type, upsert: false,
  })
  if (error) throw error
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return { path, publicUrl: data.publicUrl }
}

export async function insertPhoto({ path, publicUrl, userId }) {
  const { data, error } = await supabase
    .from('photos')
    .insert({ storage_path: path, public_url: publicUrl, uploaded_by: userId })
    .select().single()
  if (error) throw error
  return data
}

/* ---------- spots ---------- */

export async function upsertSpot(s) {
  const row = {
    name: s.name, name_key: norm(s.name),
    address: s.address || null, neighborhood: s.neighborhood || null,
    type: s.type || 'bar', status: s.status || 'unknown',
    lat: s.lat, lng: s.lng, approx: !!s.approx,
  }
  const { data, error } = await supabase
    .from('spots')
    .upsert(row, { onConflict: 'name_key', ignoreDuplicates: false })
    .select().single()
  if (error) throw error
  return data
}

export async function linkSpotPhoto(spotId, photoId) {
  const { error } = await supabase
    .from('spot_photos')
    .upsert({ spot_id: spotId, photo_id: photoId }, { onConflict: 'spot_id,photo_id', ignoreDuplicates: true })
  if (error) throw error
}

export async function updateSpotType(spotId, type) {
  await supabase.from('spots').update({ type }).eq('id', spotId)
}

// Load every spot with its linked photo URLs.
export async function loadSpots() {
  const { data, error } = await supabase
    .from('spots')
    .select('id,name,address,neighborhood,type,status,lat,lng,approx,spot_photos(photos(id,public_url))')
  if (error) throw error
  return (data || []).map((s) => ({
    ...s,
    photos: (s.spot_photos || []).map((sp) => sp.photos).filter(Boolean),
  }))
}

/* ---------- per-user wishlist / visited ---------- */

export async function loadUserLists(userId) {
  if (!userId) return {}
  const { data, error } = await supabase
    .from('user_lists').select('spot_id,wishlist,visited').eq('user_id', userId)
  if (error) { console.warn(error.message); return {} }
  const map = {}
  for (const r of data || []) map[r.spot_id] = { wishlist: r.wishlist, visited: r.visited }
  return map
}

export async function setUserList(userId, spotId, patch) {
  const { data } = await supabase
    .from('user_lists').select('wishlist,visited').eq('user_id', userId).eq('spot_id', spotId).maybeSingle()
  const row = {
    user_id: userId, spot_id: spotId,
    wishlist: patch.wishlist ?? data?.wishlist ?? false,
    visited: patch.visited ?? data?.visited ?? false,
  }
  await supabase.from('user_lists').upsert(row, { onConflict: 'user_id,spot_id' })
  return row
}
