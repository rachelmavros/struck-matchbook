import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { ensureUser } from './lib/supabase'
import {
  loadFileToCanvas, canvasToBase64, cropNormalized, tileRects, isValidBbox, canvasToFile,
} from './lib/vision'
import {
  readMatchbooksImage, searchPlaces, uploadPhoto, insertPhoto,
  upsertSpot, linkSpotPhoto, updateSpotType, loadSpots,
  loadUserLists, setUserList, norm,
} from './lib/api'

const CHI = [41.8781, -87.6298]
const TYPES = ['bar', 'restaurant', 'coffee_shop', 'hotel', 'theater', 'other']
const TYPE_LABELS = { coffee_shop: 'Coffee Shop', bar: 'Bar', restaurant: 'Restaurant', hotel: 'Hotel', theater: 'Theater', other: 'Other' }
const typeLabel = (t) => TYPE_LABELS[t] || cap(t)

// A few Google/OSM neighborhood labels read oddly, or split up areas locals treat as one — merge them.
const HOOD_ALIASES = {
  'Financial District': 'The Loop',
  'Loop': 'The Loop',
  'Rush Street': 'Gold Coast',
  'West Loop Gate': 'West Loop',
  'Near North Side': 'River North',
}
const hoodLabel = (h) => (h ? (HOOD_ALIASES[h] || h) : h)

// Map popups / list rows want "226 W Kinzie St, River North" — not the full county+zip string.
function shortAddress(address, neighborhood) {
  if (!address) return hoodLabel(neighborhood) || ''
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean)
  const DROP = /^(chicago|cook county|illinois|il|united states|usa|\d{5}(-\d{4})?)$/i
  const kept = parts.filter((p) => !DROP.test(p))
  const street = kept[0] || parts[0] || ''
  const hood = hoodLabel(neighborhood) || kept.find((p) => p !== street) || ''
  return [street, hood].filter(Boolean).join(', ')
}

function mapsUrl(name, address) {
  const q = [name, address, 'Chicago, IL'].filter(Boolean).join(' ')
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q)
}

async function readWholeCanvas(canvas) {
  const { base64, mediaType } = canvasToBase64(canvas)
  const res = await readMatchbooksImage({ base64, mediaType })
  return { items: res.items || [], unreadable: res.unreadable || 0 }
}

// Split a dense collage into four overlapping quadrants and read each separately —
// much more legible per matchbook than asking the model to parse 20-30 tiny covers at once.
async function readTiled(canvas, onProgress) {
  const rects = tileRects(0.12)
  const allItems = []
  let unreadable = 0
  for (let i = 0; i < rects.length; i++) {
    onProgress?.(i + 1, rects.length)
    const rect = rects[i]
    const tile = cropNormalized(canvas, [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h], 0)
    const { base64, mediaType } = canvasToBase64(tile)
    const res = await readMatchbooksImage({ base64, mediaType })
    unreadable += res.unreadable || 0
    for (const it of (res.items || [])) {
      if (isValidBbox(it.bbox)) {
        const [x0, y0, x1, y1] = it.bbox
        allItems.push({
          ...it,
          bbox: [rect.x + x0 * rect.w, rect.y + y0 * rect.h, rect.x + x1 * rect.w, rect.y + y1 * rect.h],
        })
      } else {
        allItems.push({ ...it, bbox: null })
      }
    }
  }
  // De-dupe items that show up in more than one overlapping tile, by normalized name.
  const seen = new Set(), deduped = []
  for (const it of allItems) {
    const key = norm(it.name)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    deduped.push(it)
  }
  return { items: deduped, unreadable }
}

export default function App() {
  const [user, setUser] = useState(null)
  const [spots, setSpots] = useState([])
  const [lists, setLists] = useState({})
  const [review, setReview] = useState([])        // proposed matches, not yet saved
  const [pending, setPending] = useState([])       // couldn't place -> manual search
  const [candidates, setCandidates] = useState({}) // pendingId -> results | 'loading'
  const [filters, setFilters] = useState({ view: 'all', type: 'all', hood: 'all' })
  const [status, setStatus] = useState('')
  const [staged, setStaged] = useState(null)
  const [modalId, setModalId] = useState(null)
  const [gIndex, setGIndex] = useState(0)

  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const timers = useRef({})
  const baseZoomRef = useRef(12) // zoom level right after fitting to the current pins
  const showLabelsNowRef = useRef(false) // true when the current filtered set is small enough to just show names

  /* ----- boot ----- */
  useEffect(() => {
    const map = L.map(mapEl.current, { scrollWheelZoom: false, zoomSnap: 1 }).setView(CHI, 12)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap © CARTO',
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)

    const updateLabels = () => {
      // Labels show immediately for a small filtered set (e.g. one neighborhood), otherwise
      // after one zoom-in step past wherever we last fit the pins.
      const shouldShow = showLabelsNowRef.current || map.getZoom() >= baseZoomRef.current + 1
      map.getContainer().classList.toggle('labels-on', shouldShow)
    }
    map.on('zoomend', updateLabels)
    mapRef.current = map
    map._updateLabels = updateLabels

    window.__openSpot = (id) => { setModalId(id); setGIndex(0) }
    ;(async () => {
      const u = await ensureUser()
      setUser(u)
      await refresh(u?.id)
    })()
    return () => { map.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refresh(userId) {
    try {
      const [sp, ul] = await Promise.all([loadSpots(), loadUserLists(userId)])
      setSpots(sp); setLists(ul)
    } catch (e) {
      console.warn(e)
      setStatus('Could not load the map yet — check the Supabase setup in the README.')
    }
  }

  const enriched = useMemo(() => spots.map((s) => ({
    ...s,
    wishlist: lists[s.id]?.wishlist || false,
    visited: lists[s.id]?.visited || false,
  })), [spots, lists])

  const hoods = useMemo(
    () => [...new Set(enriched.map((s) => hoodLabel(s.neighborhood)).filter(Boolean))].sort(),
    [enriched]
  )

  const visible = useMemo(() => enriched.filter((s) => {
    if (filters.view === 'wishlist' && !s.wishlist) return false
    if (filters.view === 'visited' && !s.visited) return false
    if (filters.type !== 'all' && s.type !== filters.type) return false
    if (filters.hood !== 'all' && hoodLabel(s.neighborhood) !== filters.hood) return false
    return true
  }), [enriched, filters])

  /* ----- markers ----- */
  useEffect(() => {
    const layer = layerRef.current, map = mapRef.current
    if (!layer || !map) return
    layer.clearLayers()
    const ms = []
    visible.forEach((s) => {
      if (s.lat == null || s.lng == null) return
      const cls = s.wishlist ? 'wish' : (s.approx ? 'approx' : '')
      const icon = L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [16, 16], iconAnchor: [8, 16] })
      const m = L.marker([s.lat, s.lng], { icon })
      const meta = shortAddress(s.address, s.neighborhood)
      m.bindPopup(
        `<b>${esc(s.name)}</b><br>` +
        `<span class="pop-meta">${esc(typeLabel(s.type))}${s.status === 'closed' ? ' · closed' : ''}${meta ? '<br>' + esc(meta) : ''}</span><br>` +
        `<button class="popbtn" onclick="window.__openSpot('${s.id}')">View photos (${s.photos.length})</button> ` +
        `<a class="popbtn poplink" href="${mapsUrl(s.name, s.address)}" target="_blank" rel="noopener">Google Maps ↗</a>`
      )
      m.bindTooltip(s.name, { permanent: true, direction: 'top', offset: [0, -14], className: 'mb-label' })
      layer.addLayer(m); ms.push(m)
    })
    if (ms.length) {
      // Small sets (e.g. one neighborhood, or just a couple pins) get names right away and a
      // gentler max zoom so 1-2 spots don't snap in to a jarring street-level close-up.
      showLabelsNowRef.current = ms.length <= 15
      map.fitBounds(L.featureGroup(ms).getBounds().pad(0.3), { animate: false, maxZoom: 16 })
      baseZoomRef.current = map.getZoom()
    }
    map._updateLabels?.()
  }, [visible])

  /* ----- upload + read -> build a review list (nothing saved yet) ----- */
  function onFile(e) {
    const f = e.target.files[0]
    if (!f) return
    setStaged({ file: f, url: URL.createObjectURL(f) })
  }

  async function handleUpload() {
    if (!staged || !user) return

    setStatus('Reading the covers…')
    let canvas, pass1
    try {
      canvas = await loadFileToCanvas(staged.file)
      pass1 = await readWholeCanvas(canvas)
    } catch (e) { setStatus('Couldn’t read that photo — try a sharper, closer shot.'); return }

    let items = pass1.items, unreadable = pass1.unreadable
    const looksDense = pass1.unreadable >= 4 || pass1.items.length >= 8
    if (looksDense) {
      try {
        const tiled = await readTiled(canvas, (i, n) => setStatus(`Dense photo — reading section ${i}/${n}…`))
        const tiledNames = new Set(tiled.items.map((it) => norm(it.name)).filter(Boolean))
        const keepFromPass1 = items.filter((it) => !tiledNames.has(norm(it.name)))
        items = [...tiled.items, ...keepFromPass1]
        unreadable = tiled.unreadable
      } catch (e) {
        // Tiled re-read failed — fall back to whatever pass 1 found rather than losing everything.
      }
    }
    items = items.slice(0, 20)

    const drafts = [], newPending = []
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      setStatus(`Placing ${i + 1}/${items.length}: ${it.name}`)
      const cropFile = await canvasToFile(
        isValidBbox(it.bbox) ? cropNormalized(canvas, it.bbox) : canvas,
        'matchbook.jpg'
      )
      const previewUrl = URL.createObjectURL(cropFile)

      const query = it.address ? `${it.name} ${it.address}` : `${it.name}, Chicago`
      const cands = await searchPlaces(query)
      if (cands.length) {
        const c = cands[0]
        drafts.push({
          tempId: crypto.randomUUID(), cropFile, previewUrl,
          name: it.name, type: it.type || c.type || 'other',
          address: c.address || it.address || '', neighborhood: c.neighborhood || it.neighborhood || '',
          lat: c.lat, lng: c.lng, status: it.status || 'unknown',
        })
      } else {
        newPending.push({ id: crypto.randomUUID(), cropFile, previewUrl, prefill: it.name || '' })
      }
    }
    for (let k = 0; k < unreadable && (drafts.length + newPending.length) < 20; k++) {
      const cropFile = await canvasToFile(canvas, 'matchbook.jpg')
      newPending.push({ id: crypto.randomUUID(), cropFile, previewUrl: URL.createObjectURL(cropFile), prefill: '' })
    }

    setReview((r) => [...drafts, ...r])
    setPending((p) => [...newPending, ...p])
    setStaged(null)
    setStatus(drafts.length
      ? `Review ${drafts.length} match${drafts.length === 1 ? '' : 'es'} below — nothing’s saved yet.`
      : (newPending.length ? 'Couldn’t place these — search for each below.' : 'No readable matchbooks found.'))
    newPending.filter((p) => p.prefill).forEach((p) => runSearch(p.id, p.prefill))
  }

  /* ----- review actions ----- */
  function updateDraft(id, patch) { setReview((r) => r.map((d) => (d.tempId === id ? { ...d, ...patch } : d))) }
  function removeDraft(id) { setReview((r) => r.filter((d) => d.tempId !== id)) }
  function draftToPending(d) {
    const id = crypto.randomUUID()
    setPending((p) => [{ id, cropFile: d.cropFile, previewUrl: d.previewUrl, prefill: d.name }, ...p])
    setReview((r) => r.filter((x) => x.tempId !== d.tempId))
    runSearch(id, d.name)
  }
  async function saveReview() {
    if (!review.length) return
    setStatus('Saving…')
    for (const d of review) {
      const up = await uploadPhoto(d.cropFile, user.id)
      const photo = await insertPhoto({ path: up.path, publicUrl: up.publicUrl, userId: user.id })
      const spot = await upsertSpot({
        name: d.name, address: d.address, neighborhood: d.neighborhood,
        type: d.type, status: d.status, lat: d.lat, lng: d.lng, approx: false,
      })
      await linkSpotPhoto(spot.id, photo.id)
    }
    const n = review.length
    setReview([]); setStatus(`Saved ${n} spot${n === 1 ? '' : 's'}.`)
    await refresh(user.id)
  }

  /* ----- manual assignment (live search dropdown) ----- */
  function onAssignInput(pendId, val) {
    clearTimeout(timers.current[pendId])
    timers.current[pendId] = setTimeout(() => runSearch(pendId, val), 350)
  }
  async function runSearch(pendId, query) {
    if (!query || !query.trim()) { setCandidates((c) => ({ ...c, [pendId]: [] })); return }
    setCandidates((c) => ({ ...c, [pendId]: 'loading' }))
    const res = await searchPlaces(query)
    setCandidates((c) => ({ ...c, [pendId]: res }))
  }
  function dismissPending(id) {
    clearTimeout(timers.current[id])
    setPending((p) => p.filter((x) => x.id !== id))
    setCandidates((c) => { const n = { ...c }; delete n[id]; return n })
  }
  async function assign(pend, cand) {
    const up = await uploadPhoto(pend.cropFile, user.id)
    const photo = await insertPhoto({ path: up.path, publicUrl: up.publicUrl, userId: user.id })
    const spot = await upsertSpot({
      name: cand.name, address: cand.address, neighborhood: cand.neighborhood,
      type: cand.type || 'other', status: 'unknown', lat: cand.lat, lng: cand.lng, approx: false,
    })
    await linkSpotPhoto(spot.id, photo.id)
    dismissPending(pend.id)
    await refresh(user.id)
  }

  /* ----- lists ----- */
  async function toggle(spotId, key) {
    const cur = lists[spotId] || { wishlist: false, visited: false }
    const next = { ...cur, [key]: !cur[key] }
    setLists((l) => ({ ...l, [spotId]: next }))
    if (user) await setUserList(user.id, spotId, { [key]: next[key] })
  }

  const modalSpot = enriched.find((s) => s.id === modalId) || null

  return (
    <div className="wrap">
      <header>
        <div className="brandrow">
          <div className="match"><div className="stick" /><div className="head flame" /></div>
          <h1>Struck<span className="sub">Chicago matchbook map</span></h1>
        </div>
        <p className="lede">Add a photo of a matchbook. It reads the covers, you review the matches, and each spot drops on the map. Dense collages get split into sections and cropped automatically. Can’t read one? Search and pin it yourself.</p>
        <p className="who">{user ? 'Your wishlist and been-there are saved to this browser.' : 'Connecting…'}</p>
      </header>

      <div className="strip" />

      <div className="cols">
        <div className="panel panel-slot">
          <h2>Add matchbooks</h2>
          <label className={'drop' + (staged ? ' has' : '')}>
            <input type="file" accept="image/*" hidden onChange={onFile} />
            {staged
              ? <img src={staged.url} alt="staged matchbook" />
              : <div className="hint"><b>Tap to add a photo</b><br />a single cover or a full spread</div>}
          </label>
          <button className="go" onClick={handleUpload} disabled={!staged}>Read these matchbooks</button>
          <div className="status">{status}</div>

          {/* ---------- staging: review + manual assign (nothing saved until you confirm) ---------- */}
          {(review.length > 0 || pending.length > 0) && (
            <div className="staging">
              {review.length > 0 && (
                <>
                  <div className="stage-h">Review {review.length} match{review.length === 1 ? '' : 'es'} · not saved yet</div>
                  {review.map((d) => (
                    <div className="draft" key={d.tempId}>
                      <img className="thumb" src={d.previewUrl} alt="" />
                      <div className="grow">
                        <input className="draft-name" value={d.name}
                          onChange={(e) => updateDraft(d.tempId, { name: e.target.value })} />
                        <div className="draft-addr">{[d.neighborhood, d.address].filter(Boolean).join(' · ') || 'located'}</div>
                        <div className="draft-row">
                          <select value={d.type} onChange={(e) => updateDraft(d.tempId, { type: e.target.value })}>
                            {TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                          </select>
                          <button className="linkbtn" onClick={() => draftToPending(d)}>Wrong spot?</button>
                        </div>
                      </div>
                      <button className="xbtn" title="Discard" onClick={() => removeDraft(d.tempId)}>×</button>
                    </div>
                  ))}
                  <div className="stage-actions">
                    <button className="go save" onClick={saveReview}>Save {review.length} to map</button>
                    <button className="ghost" onClick={() => setReview([])}>Discard all</button>
                  </div>
                </>
              )}

              {pending.map((p) => (
                <div className="assign" key={p.id}>
                  <img src={p.previewUrl} alt="unplaced matchbook" />
                  <div className="body">
                    <div className="assign-head">
                      <span className="lbl">Couldn’t place — search it</span>
                      <button className="xbtn" title="Dismiss" onClick={() => dismissPending(p.id)}>×</button>
                    </div>
                    <input defaultValue={p.prefill} placeholder="Type a bar, restaurant, hotel…"
                      onChange={(e) => onAssignInput(p.id, e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(p.id, e.currentTarget.value) } }} />
                    <div>
                      {candidates[p.id] === 'loading' && <div className="hint-sm">searching…</div>}
                      {Array.isArray(candidates[p.id]) && candidates[p.id].length === 0 &&
                        <div className="hint-sm">start typing to see matches</div>}
                      {Array.isArray(candidates[p.id]) && candidates[p.id].map((c, i) => (
                        <button className="cand" key={i} onClick={() => assign(p, c)}>
                          {c.name}<br /><small>{[c.neighborhood, c.address].filter(Boolean).join(' · ')}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ---------- filters ---------- */}
          <div className="filters">
            <div className="viewtabs">
              {['all', 'wishlist', 'visited'].map((v) => (
                <button key={v} className={'vtab' + (filters.view === v ? ' on' : '')}
                  onClick={() => setFilters((f) => ({ ...f, view: v }))}>
                  {v === 'all' ? 'All' : v === 'wishlist' ? '♥ Wishlist' : '✓ Been'}
                </button>
              ))}
            </div>
            <div className="selrow">
              <label>Type
                <select value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}>
                  <option value="all">All types</option>
                  {TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                </select>
              </label>
              <label>Neighborhood
                <select value={filters.hood} onChange={(e) => setFilters((f) => ({ ...f, hood: e.target.value }))}>
                  <option value="all">All areas</option>
                  {hoods.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </label>
            </div>
          </div>

          {/* ---------- results ---------- */}
          {enriched.length > 0 && <div className="results-h">{visible.length} spot{visible.length === 1 ? '' : 's'}</div>}
          {visible.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
            <div className="spot" key={s.id}>
              <div className="top" onClick={() => { setModalId(s.id); setGIndex(0) }}>
                {s.photos[0]
                  ? <img className="thumb" src={s.photos[0].public_url} alt="" />
                  : <div className="thumb ph" />}
                <div className="grow">
                  <div className="nm">{s.name}</div>
                  <div className="meta">
                    <span className={'tag ' + s.type}>{typeLabel(s.type)}</span>
                    {s.status === 'closed' && <span className="tag closed">closed</span>}
                    {s.approx && <span className="tag approx">approx</span>}
                    {shortAddress(s.address, s.neighborhood)}
                  </div>
                  <div className="count">{s.photos.length} photo{s.photos.length === 1 ? '' : 's'}</div>
                </div>
                <div className="acts">
                  <button className={'iact' + (s.wishlist ? ' on-heart' : '')}
                    onClick={(e) => { e.stopPropagation(); toggle(s.id, 'wishlist') }}>♥</button>
                  <button className={'iact' + (s.visited ? ' on-check' : '')}
                    onClick={(e) => { e.stopPropagation(); toggle(s.id, 'visited') }}>✓</button>
                </div>
              </div>
              <a className="gmlink" href={mapsUrl(s.name, s.address)} target="_blank" rel="noopener"
                onClick={(e) => e.stopPropagation()}>Open in Google Maps ↗</a>
            </div>
          ))}
        </div>

        <div id="map" className="map-slot" ref={mapEl} />
      </div>

      <footer>
        Clean map by CARTO. Gold pins are on your wishlist; orange pins are approximate. Zoom in once to see place names on the map.
      </footer>

      {modalSpot && (
        <Modal spot={modalSpot} gIndex={gIndex} setGIndex={setGIndex}
          onClose={() => setModalId(null)} onToggle={toggle} />
      )}
    </div>
  )
}

function Modal({ spot, gIndex, setGIndex, onClose, onToggle }) {
  const photos = spot.photos || []
  const meta = shortAddress(spot.address, spot.neighborhood)
  const idx = photos.length ? ((gIndex % photos.length) + photos.length) % photos.length : 0
  const [zoomed, setZoomed] = useState(false)
  useEffect(() => { setZoomed(false) }, [idx, spot.id])
  return (
    <div className="overlay" onClick={(e) => { if (e.target.classList.contains('overlay')) onClose() }}>
      <div className="modal">
        <div className="mhead">
          <button className="mclose" onClick={onClose}>×</button>
          <div className="mname">{spot.name}</div>
          <div className="mmeta">{meta}{spot.status === 'closed' ? ' · closed' : ''}</div>
        </div>
        <div className={'gallery' + (zoomed ? ' zoomed' : '')}>
          {photos.length === 0
            ? <div className="gempty">No photos yet.</div>
            : <>
                <img src={photos[idx].public_url} alt={spot.name}
                  onClick={() => setZoomed((z) => !z)} title={zoomed ? 'Click to zoom out' : 'Click to zoom in'} />
                {photos.length > 1 && <>
                  <button className="gnav prev" onClick={() => setGIndex(idx - 1)}>‹</button>
                  <button className="gnav next" onClick={() => setGIndex(idx + 1)}>›</button>
                </>}
                <div className="gcount">{idx + 1} / {photos.length}</div>
              </>}
        </div>
        <div className="mrow">
          <button className={'mbtn' + (spot.wishlist ? ' on-heart' : '')} onClick={() => onToggle(spot.id, 'wishlist')}>
            ♥ {spot.wishlist ? 'On wishlist' : 'Add to wishlist'}
          </button>
          <button className={'mbtn' + (spot.visited ? ' on-check' : '')} onClick={() => onToggle(spot.id, 'visited')}>
            ✓ {spot.visited ? 'Been there' : 'Mark as been'}
          </button>
        </div>
        <a className="gmlink modal-gmlink" href={mapsUrl(spot.name, spot.address)} target="_blank" rel="noopener">
          Open in Google Maps ↗
        </a>
      </div>
    </div>
  )
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
