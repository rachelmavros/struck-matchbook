import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { ensureUser } from './lib/supabase'
import { resizeImage } from './lib/imageResize'
import {
  readMatchbooks, searchPlaces, uploadPhoto, insertPhoto,
  upsertSpot, linkSpotPhoto, updateSpotType, loadSpots,
  loadUserLists, setUserList,
} from './lib/api'

const CHI = [41.8781, -87.6298]
const TYPES = ['bar', 'restaurant', 'hotel', 'theater', 'other']
const LABEL_ZOOM = 14

// A few Google/OSM neighborhood labels read oddly to locals — rename them for display.
const HOOD_ALIASES = { 'Financial District': 'The Loop' }
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

export default function App() {
  const [user, setUser] = useState(null)
  const [spots, setSpots] = useState([])
  const [lists, setLists] = useState({})
  const [review, setReview] = useState([])       // proposed matches, not yet saved
  const [pending, setPending] = useState([])      // couldn't place -> manual search
  const [candidates, setCandidates] = useState({})// pendingId -> results | 'loading'
  const [filters, setFilters] = useState({ view: 'all', type: 'all', hood: 'all' })
  const [status, setStatus] = useState('')
  const [staged, setStaged] = useState(null)
  const [modalId, setModalId] = useState(null)
  const [gIndex, setGIndex] = useState(0)

  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const timers = useRef({})

  /* ----- boot ----- */
  useEffect(() => {
    const map = L.map(mapEl.current, { scrollWheelZoom: false }).setView(CHI, 12)
    // Clean, low-clutter basemap (CARTO Positron) instead of the busy default tiles
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap © CARTO',
    }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    map.on('zoomend', () => {
      map.getContainer().classList.toggle('labels-on', map.getZoom() >= LABEL_ZOOM)
    })
    mapRef.current = map

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
        `<span class="pop-meta">${s.type}${s.status === 'closed' ? ' · closed' : ''}${meta ? '<br>' + esc(meta) : ''}</span><br>` +
        `<button class="popbtn" onclick="window.__openSpot('${s.id}')">View photos (${s.photos.length})</button>`
      )
      // permanent label, shown only when zoomed in (gated by the .labels-on class via CSS)
      m.bindTooltip(s.name, { permanent: true, direction: 'top', offset: [0, -14], className: 'mb-label' })
      layer.addLayer(m); ms.push(m)
    })
    map.getContainer().classList.toggle('labels-on', map.getZoom() >= LABEL_ZOOM)
    if (ms.length) map.fitBounds(L.featureGroup(ms).getBounds().pad(0.25))
  }, [visible])

  /* ----- upload + read -> build a review list (nothing saved yet) ----- */
  async function onFile(e) {
    const f = e.target.files[0]
    if (!f) return
    const resized = await resizeImage(f)
    setStaged({ file: resized, url: URL.createObjectURL(resized) })
  }

  async function handleUpload() {
    if (!staged || !user) return
    setStatus('Uploading photo…')
    let photo
    try {
      const up = await uploadPhoto(staged.file, user.id)
      photo = await insertPhoto({ path: up.path, publicUrl: up.publicUrl, userId: user.id })
    } catch (e) { setStatus('Upload failed — check the storage bucket in the README.'); return }

    setStatus('Reading the covers…')
    let items = [], unreadable = 0
    try {
      const res = await readMatchbooks(photo.public_url)
      items = res.items || []; unreadable = res.unreadable || 0
    } catch (e) { setStatus('Couldn’t read that photo — try a sharper, closer shot.'); return }

    const drafts = [], newPending = []
    for (let i = 0; i < items.length && i < 12; i++) {
      const it = items[i]
      setStatus(`Placing ${i + 1}/${Math.min(items.length, 12)}: ${it.name}`)
      const query = it.address ? `${it.name} ${it.address}` : `${it.name}, Chicago`
      const cands = await searchPlaces(query)
      if (cands.length) {
        const c = cands[0]
        drafts.push({
          tempId: crypto.randomUUID(), photoId: photo.id, photoUrl: photo.public_url,
          name: it.name, type: it.type || c.type || 'other',
          address: c.address || it.address || '', neighborhood: c.neighborhood || it.neighborhood || '',
          lat: c.lat, lng: c.lng, status: it.status || 'unknown',
        })
      } else {
        newPending.push({ id: crypto.randomUUID(), photoId: photo.id, photoUrl: photo.public_url, prefill: it.name || '' })
      }
    }
    for (let k = 0; k < unreadable; k++)
      newPending.push({ id: crypto.randomUUID(), photoId: photo.id, photoUrl: photo.public_url, prefill: '' })

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
    setPending((p) => [{ id, photoId: d.photoId, photoUrl: d.photoUrl, prefill: d.name }, ...p])
    setReview((r) => r.filter((x) => x.tempId !== d.tempId))
    runSearch(id, d.name)
  }
  async function saveReview() {
    if (!review.length) return
    setStatus('Saving…')
    for (const d of review) {
      const spot = await upsertSpot({
        name: d.name, address: d.address, neighborhood: d.neighborhood,
        type: d.type, status: d.status, lat: d.lat, lng: d.lng, approx: false,
      })
      await linkSpotPhoto(spot.id, d.photoId)
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
    const spot = await upsertSpot({
      name: cand.name, address: cand.address, neighborhood: cand.neighborhood,
      type: cand.type || 'other', status: 'unknown', lat: cand.lat, lng: cand.lng, approx: false,
    })
    await linkSpotPhoto(spot.id, pend.photoId)
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
  async function changeType(spotId, type) {
    setSpots((ss) => ss.map((s) => (s.id === spotId ? { ...s, type } : s)))
    await updateSpotType(spotId, type)
  }

  const modalSpot = enriched.find((s) => s.id === modalId) || null

  return (
    <div className="wrap">
      <header>
        <div className="brandrow">
          <div className="match"><div className="stick" /><div className="head flame" /></div>
          <h1>Struck<span className="sub">Chicago matchbook map</span></h1>
        </div>
        <p className="lede">Add a photo of a matchbook. It reads the covers, you review the matches, and each spot drops on the map. Can’t read one? Search and pin it yourself.</p>
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
                      <img className="thumb" src={d.photoUrl} alt="" />
                      <div className="grow">
                        <input className="draft-name" value={d.name}
                          onChange={(e) => updateDraft(d.tempId, { name: e.target.value })} />
                        <div className="draft-addr">{[d.neighborhood, d.address].filter(Boolean).join(' · ') || 'located'}</div>
                        <div className="draft-row">
                          <select value={d.type} onChange={(e) => updateDraft(d.tempId, { type: e.target.value })}>
                            {TYPES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
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
                  <img src={p.photoUrl} alt="unplaced matchbook" />
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
                  {TYPES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
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
            <div className="spot" key={s.id} onClick={() => { setModalId(s.id); setGIndex(0) }}>
              <div className="top">
                {s.photos[0]
                  ? <img className="thumb" src={s.photos[0].public_url} alt="" />
                  : <div className="thumb ph" />}
                <div className="grow">
                  <div className="nm">{s.name}</div>
                  <div className="meta">
                    <span className={'tag ' + s.type}>{s.type}</span>
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
            </div>
          ))}
        </div>

        <div id="map" className="map-slot" ref={mapEl} />
      </div>

      <footer>
        Clean map by CARTO. Gold pins are on your wishlist; orange pins are approximate. Zoom in to see place names on the map.
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
