// GET /api/geocode?q=...  ->  { results:[{name,address,neighborhood,type,lat,lng}] }
// Uses Google Places Text Search when GOOGLE_PLACES_KEY is set (great for business names),
// otherwise falls back to OpenStreetMap Nominatim (address-oriented, weaker on venues).

const CHICAGO = { lat: 41.8781, lng: -87.6298 }

function mapGoogleType(types = []) {
  if (types.some((t) => /bar|pub|night_club|brewery/.test(t))) return 'bar'
  if (types.some((t) => /restaurant|cafe|meal|food|bakery/.test(t))) return 'restaurant'
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
        'places.displayName,places.formattedAddress,places.location,places.types,places.addressComponents',
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
    address: p.formattedAddress || null,
    neighborhood: hoodFromGoogle(p.addressComponents),
    type: mapGoogleType(p.types),
    lat: p.location?.latitude,
    lng: p.location?.longitude,
  }))
}

async function nominatim(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&q=' +
    encodeURIComponent(q + ', Chicago, IL')
  const r = await fetch(url, { headers: { 'User-Agent': 'struck-matchbook-map' } })
  if (!r.ok) return []
  const j = await r.json()
  return (j || []).map((res) => {
    const a = res.address || {}
    const t = (res.type || '') + (res.class || '')
    const type = /pub|bar/.test(t) ? 'bar' : /restaurant|cafe|food/.test(t) ? 'restaurant' : 'other'
    return {
      name: (res.display_name || q).split(',')[0],
      address: res.display_name || null,
      neighborhood: a.neighbourhood || a.suburb || a.city_district || null,
      type,
      lat: parseFloat(res.lat),
      lng: parseFloat(res.lon),
    }
  })
}

export default async function handler(req, res) {
  const q = (req.query?.q || '').toString().trim()
  if (!q) return res.status(400).json({ error: 'q required' })
  const key = process.env.GOOGLE_PLACES_KEY
  try {
    const results = key ? await google(q, key) : await nominatim(q)
    return res.status(200).json({ results, provider: key ? 'google' : 'nominatim' })
  } catch (err) {
    // If Google errors, still try the free fallback so the app keeps working.
    try { return res.status(200).json({ results: await nominatim(q), provider: 'nominatim-fallback' }) }
    catch { return res.status(500).json({ error: String(err) }) }
  }
}
