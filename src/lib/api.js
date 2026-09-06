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

// Goes through the upsert_spot RPC so a repeat upload of an existing spot can't
// overwrite that spot's original submitter or un-approve it.
export async function upsertSpot(s) {
  const { data, error } = await supabase.rpc('upsert_spot', {
    p_name: s.name, p_name_key: norm(s.name),
    p_address: s.address || '', p_neighborhood: s.neighborhood || '',
    p_type: s.type || 'bar', p_status: s.status || 'unknown',
    p_lat: s.lat, p_lng: s.lng, p_approx: !!s.approx,
  })
  if (!error) return Array.isArray(data) ? data[0] : data

  // Moderation migration not run yet — fall back to the plain upsert so uploads
  // still work (without the submitter/approved protections the RPC provides).
  console.warn('upsert_spot RPC unavailable, falling back to upsert:', error.message)
  const row = {
    name: s.name, name_key: norm(s.name),
    address: s.address || null, neighborhood: s.neighborhood || null,
    type: s.type || 'bar', status: s.status || 'unknown',
    lat: s.lat, lng: s.lng, approx: !!s.approx,
  }
  const fb = await supabase
    .from('spots').upsert(row, { onConflict: 'name_key', ignoreDuplicates: false })
    .select().single()
  if (fb.error) throw fb.error
  return fb.data
}

export async function linkSpotPhoto(spotId, photoId) {
  const { error } = await supabase
    .from('spot_photos')
    .upsert({ spot_id: spotId, photo_id: photoId }, { onConflict: 'spot_id,photo_id', ignoreDuplicates: true })
  if (error) throw error
}

// Admin-only in practice: RLS on the "spots" table now requires profiles.is_admin = true for
// updates/deletes, so these will silently no-op (or error) for non-admins even if called.
export async function adminUpdateSpot(spotId, patch) {
  const row = {}
  for (const k of ['name', 'address', 'neighborhood', 'type', 'status']) {
    if (patch[k] !== undefined) row[k] = patch[k]
  }
  if (row.name) row.name_key = norm(row.name)
  const { data, error } = await supabase.from('spots').update(row).eq('id', spotId).select().single()
  if (error) throw error
  return data
}
// Soft-delete: mark deleted_at instead of hard-deleting so admin can restore.
// If deleted_at column isn't present (trash migration not run), falls back to
// a real delete so nothing breaks.
export async function adminDeleteSpot(spotId) {
  const { error } = await supabase.from('spots').update({ deleted_at: new Date().toISOString() }).eq('id', spotId)
  if (!error) return
  if (/deleted_at/i.test(error.message)) {
    const fb = await supabase.from('spots').delete().eq('id', spotId)
    if (fb.error) throw fb.error
    return
  }
  throw error
}

export async function adminRestoreSpot(spotId) {
  const { error } = await supabase.from('spots').update({ deleted_at: null }).eq('id', spotId)
  if (error) throw error
}

export async function adminPurgeSpot(spotId) {
  const { error } = await supabase.from('spots').delete().eq('id', spotId)
  if (error) throw error
}

// Admin-only: replace an existing photo in place by uploading a new file, linking it
// to the same spot, and removing the old one. Used by the "re-crop existing photo"
// flow so re-cropping doesn't leave dead storage objects behind.
export async function adminReplacePhoto({ oldPhotoId, oldStoragePath, spotId, newFile, userId }) {
  const up = await uploadPhoto(newFile, userId)
  const inserted = await insertPhoto({ path: up.path, publicUrl: up.publicUrl, userId })
  await linkSpotPhoto(spotId, inserted.id)
  await adminDeletePhoto(oldPhotoId, oldStoragePath)
  return inserted
}

// Soft-delete: keeps storage intact so restore stays possible; purge is what
// actually removes the storage object.
export async function adminDeletePhoto(photoId /*, storagePath */) {
  const { error } = await supabase.from('photos').update({ deleted_at: new Date().toISOString() }).eq('id', photoId)
  if (!error) return
  if (/deleted_at/i.test(error.message)) {
    const fb = await supabase.from('photos').delete().eq('id', photoId)
    if (fb.error) throw fb.error
    return
  }
  throw error
}

export async function adminRestorePhoto(photoId) {
  const { error } = await supabase.from('photos').update({ deleted_at: null }).eq('id', photoId)
  if (error) throw error
}

export async function adminPurgePhoto(photoId, storagePath) {
  if (storagePath) {
    const { error: sErr } = await supabase.storage.from(BUCKET).remove([storagePath])
    if (sErr) console.warn('storage remove failed:', sErr.message)
  }
  const { error } = await supabase.from('photos').delete().eq('id', photoId)
  if (error) throw error
}

// Load trashed spots + photos for the admin Trash view. RLS restricts SELECT
// to admins; the filter narrows to rows that are soft-deleted.
export async function loadTrash() {
  const trashCols = SPOT_COLS + ',approved,submitted_by,deleted_at'
  const spots = await supabase.from('spots').select(trashCols).not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
  const photos = await supabase.from('photos').select('id,public_url,storage_path,created_at,deleted_at').not('deleted_at', 'is', null).order('deleted_at', { ascending: false })
  if (spots.error && !/deleted_at/i.test(spots.error.message)) throw spots.error
  if (photos.error && !/deleted_at/i.test(photos.error.message)) throw photos.error
  return { spots: spots.data || [], photos: photos.data || [] }
}

const PHOTO_COLS = 'spot_photos(photos(id,public_url,storage_path,created_at))'
const SPOT_COLS = 'id,name,address,neighborhood,type,status,lat,lng,approx'

// Load every spot with its linked photo URLs. RLS decides what comes back:
// approved spots for everyone, plus your own pending ones, plus everything for admins.
//
// Falls back to the pre-moderation column set if the moderation migration hasn't been
// run yet — otherwise Postgres rejects the whole query and the map goes blank.
export async function loadSpots() {
  let { data, error } = await supabase
    .from('spots')
    .select(`${SPOT_COLS},approved,submitted_by,${PHOTO_COLS}`)
    .is('deleted_at', null)

  if (error) {
    console.warn('spots query failed, retrying without moderation columns:', error.message)
    const fallback = await supabase.from('spots').select(`${SPOT_COLS},${PHOTO_COLS}`)
    if (fallback.error) throw fallback.error
    // Without the migration there is no review queue — treat everything as live.
    data = (fallback.data || []).map((s) => ({ ...s, approved: true, submitted_by: null }))
  }

  return (data || []).map((s) => ({
    ...s,
    // Newest photo first, so the most recently uploaded matchbook is the spot's icon.
    photos: (s.spot_photos || []).map((sp) => sp.photos).filter(Boolean)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
  }))
}

/* ---------- moderation ---------- */

export async function approveSpot(spotId) {
  const { error } = await supabase.from('spots').update({ approved: true }).eq('id', spotId)
  if (error) throw error
}

// Edit a spot you submitted yourself. RLS forces approved=false on this path, so
// editing an already-approved spot sends it back to the review queue.
export async function updateOwnSpot(spotId, patch) {
  const row = { approved: false }
  for (const k of ['name', 'address', 'neighborhood', 'type', 'status']) {
    if (patch[k] !== undefined) row[k] = patch[k]
  }
  if (row.name) row.name_key = norm(row.name)
  const { data, error } = await supabase.from('spots').update(row).eq('id', spotId).select().single()
  if (error) throw error
  return data
}

/* ---------- favorite / visit counts (public aggregate, no per-user identity) ---------- */

export async function loadFavoriteCounts() {
  const { data, error } = await supabase.from('spot_favorite_counts').select('spot_id,favorites,visits')
  if (error) { console.warn(error.message); return {} }
  const map = {}
  for (const r of data || []) map[r.spot_id] = { favorites: r.favorites || 0, visits: r.visits || 0 }
  return map
}

/* ---------- comments ---------- */

export async function loadComments(spotId) {
  const { data, error } = await supabase
    .from('spot_comments').select('id,body,created_at,user_id').eq('spot_id', spotId)
    .order('created_at', { ascending: false })
  if (error) { console.warn(error.message); return [] }
  return data || []
}
export async function addComment(spotId, userId, body) {
  const { data, error } = await supabase
    .from('spot_comments').insert({ spot_id: spotId, user_id: userId, body }).select().single()
  if (error) throw error
  return data
}
export async function deleteComment(commentId) {
  const { error } = await supabase.from('spot_comments').delete().eq('id', commentId)
  if (error) throw error
}

/* ---------- "my submissions": photos I uploaded, with the spot(s) they're linked to ---------- */

export async function loadMySubmissions(userId) {
  if (!userId) return []
  const { data, error } = await supabase
    .from('photos')
    .select('id,public_url,created_at,spot_photos(spots(id,name,type,neighborhood))')
    .eq('uploaded_by', userId)
    .order('created_at', { ascending: false })
  if (error) { console.warn(error.message); return [] }
  return (data || []).map((p) => ({
    photoId: p.id, publicUrl: p.public_url, createdAt: p.created_at,
    spots: (p.spot_photos || []).map((sp) => sp.spots).filter(Boolean),
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
