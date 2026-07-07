// GET /api/geocode?q=...  ->  { results:[{name,address,neighborhood,type,lat,lng}] }
// Uses Google Places Text Search when GOOGLE_PLACES_KEY is set (great for business names),
// otherwise falls back to OpenStreetMap Nominatim (address-oriented, weaker on venues).

const CHICAGO = { lat: 41.8781, lng: -87.6298 }

function mapGoogleType(types = []) {
  if (types.some((t) => /bar|pub|night_club|brewery/.test(t))) return 'bar'
  if (types.some((t) => /restaurant|cafe|meal|food|bakery/.test(t))) return 'restaurant'
  if (types.some((t) => /lodging|hotel|motel|hostel/.test(t))) return 'hotel'
  if (types.some((t) => /theater|theatre|movie|performing_arts|cinema/.test(t))) return 'theater'
  return 'other'
}
function hoodFromGoogle(components = []) {
  const find = (type) => components.find((c) => (c.types || []).includes(type))?.longText
  return find('neighborhood') || find('sublocality') || find('sublocality_level_1') || null
}

async function google(q, key) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask':
        'places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.types,places.addressComponents',
    },
    body: JSON.stringify({
      textQuery: q,
      maxResultCount: 5,
      locationBias: { circle: { center: { latitude: CHICAGO.lat, longitude: CHICAGO.lng }, radius: 40000 } },
    }),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(data))
  return (data.places || []).map((p) => ({
    name: p.displayName?.text || q,
    // shortFormattedAddress is like "100 W Randolph St" — much cleaner than the full one
    address: p.shortFormattedAddress || p.formattedAddress || null,
    neighborhood: hoodFromGoogle(p.addressComponents),
    type: mapGoogleType(p.types),
    lat: p.location?.latitude,
    lng: p.location?.longitude,
  }))
}

function nominatimType(res) {
  const t = (res.type || '') + (res.class || '')
  if (/pub|bar|nightclub/.test(t)) return 'bar'
  if (/restaurant|cafe|food|fast_food/.test(t)) return 'restaurant'
  if (/hotel|hostel|motel|guest_house/.test(t)) return 'hotel'
  if (/theatre|theater|cinema/.test(t)) return 'theater'
  return 'other'
}
function nominatimShortAddress(res) {
  const a = res.address || {}
  const line1 = [a.house_number, a.road].filter(Boolean).join(' ')
  const parts = [line1 || a.pedestrian || a.neighbourhood, a.suburb || a.city_district].filter(Boolean)
  return parts.join(', ') || (res.display_name || '').split(',').slice(0, 2).join(',').trim()
}
function nominatimName(res, q) {
  const n = res.namedetails?.name || (res.display_name || '').split(',')[0]
  return (n || '').replace(/^[A-Z0-9]{2,6}-/, '').trim() || q  // strip stray leading codes
}

async function nominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&namedetails=1&q=' +
    encodeURIComponent(q + ', Chicago, IL')
  const r = await fetch(url, { headers: { 'User-Agent': 'struck-matchbook-map' } })
  if (!r.ok) return []
  const j = await r.json()
  return (j || []).map((res) => ({
    name: nominatimName(res, q),
    address: nominatimShortAddress(res),
    neighborhood: (res.address || {}).neighbourhood || (res.address || {}).suburb || (res.address || {}).city_district || null,
    type: nominatimType(res),
    lat: parseFloat(res.lat),
    lng: parseFloat(res.lon),
  }))
}

export default async function handler(req, res) {
  const q = (req.query?.q || '').toString().trim()
  if (!q) return res.status(400).json({ error: 'q required' })
  const key = process.env.GOOGLE_PLACES_KEY
  try {
    const results = key ? await google(q, key) : await nominatim(q)
    return res.status(200).json({ results, provider: key ? 'google' : 'nominatim' })
  } catch (err) {
    try { return res.status(200).json({ results: await nominatim(q), provider: 'nominatim-fallback' }) }
    catch { return res.status(500).json({ error: String(err) }) }
  }
}
