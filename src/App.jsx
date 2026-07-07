import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { ensureUser, ensureProfile, sendMagicLink, signOut } from './lib/supabase'
import {
  loadFileToCanvas, canvasToBase64, cropNormalized, tileRects, isValidBbox, canvasToFile,
} from './lib/vision'
import {
  readMatchbooksImage, searchPlaces, uploadPhoto, insertPhoto,
  upsertSpot, linkSpotPhoto, adminUpdateSpot, adminDeleteSpot, loadSpots,
  loadUserLists, setUserList, loadFavoriteCounts, loadComments, addComment, deleteComment,
  loadMySubmissions, norm,
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
  const [profile, setProfile] = useState(null) // { id, email, is_admin }
  const [authEmail, setAuthEmail] = useState('')
  const [authStatus, setAuthStatus] = useState('')
  const [spots, setSpots] = useState([])
  const [lists, setLists] = useState({})
  const [favCounts, setFavCounts] = useState({}) // spotId -> { favorites, visits }
  const [panelView, setPanelView] = useState('list') // 'list' | 'mine' | 'leaderboard'
  const [mySubs, setMySubs] = useState([])
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
      if (u) setProfile(await ensureProfile(u))
      await refresh(u?.id)
    })()
    return () => { map.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refresh(userId) {
    try {
      const [sp, ul, fc] = await Promise.all([loadSpots(), loadUserLists(userId), loadFavoriteCounts()])
      setSpots(sp); setLists(ul); setFavCounts(fc)
    } catch (e) {
      console.warn(e)
      setStatus('Could not load the map yet — check the Supabase setup in the README.')
    }
  }

  async function handleSendMagicLink() {
    if (!authEmail.trim()) return
    setAuthStatus('Sending…')
    try { await sendMagicLink(authEmail.trim()); setAuthStatus('Check your email for a sign-in link.') }
    catch (e) { setAuthStatus('Could not send that — check the address and try again.') }
  }
  async function handleSignOut() {
    await signOut()
    setProfile(null)
    const u = await ensureUser() // drops back to a fresh anonymous session
    setUser(u)
    await refresh(u?.id)
  }

  const enriched = useMemo(() => spots.map((s) => ({
    ...s,
    wishlist: lists[s.id]?.wishlist || false,
    visited: lists[s.id]?.visited || false,
    favorites: favCounts[s.id]?.favorites || 0,
  })), [spots, lists, favCounts])

  useEffect(() => {
    if (panelView === 'mine' && user) loadMySubmissions(user.id).then(setMySubs)
  }, [panelView, user])

  const leaderboard = useMemo(
    () => enriched.filter((s) => s.favorites > 0).slice().sort((a, b) => b.favorites - a.favorites).slice(0, 15),
    [enriched]
  )

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
        <AuthBar profile={profile} authEmail={authEmail} setAuthEmail={setAuthEmail}
          authStatus={authStatus} onSend={handleSendMagicLink} onSignOut={handleSignOut} />
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

          {/* ---------- panel view tabs ---------- */}
          <div className="panelTabs">
            <button className={'ptab' + (panelView === 'list' ? ' on' : '')} onClick={() => setPanelView('list')}>Map List</button>
            <button className={'ptab' + (panelView === 'mine' ? ' on' : '')} onClick={() => setPanelView('mine')}>My Submissions</button>
            <button className={'ptab' + (panelView === 'leaderboard' ? ' on' : '')} onClick={() => setPanelView('leaderboard')}>♥ Leaderboard</button>
          </div>

          {/* ---------- filters (list view only) ---------- */}
          {panelView === 'list' && (
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
          )}

          {/* ---------- results: list / mine / leaderboard ---------- */}
          {panelView === 'list' && <>
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
                  <div className="count">{s.photos.length} photo{s.photos.length === 1 ? '' : 's'}{s.favorites > 0 ? ` · ♥ ${s.favorites}` : ''}</div>
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
          </>}

          {panelView === 'mine' && (
            <div className="mine">
              {!user ? <div className="hint-sm">Connecting…</div>
                : mySubs.length === 0 ? <div className="hint-sm">Nothing uploaded yet from this account.</div>
                : mySubs.map((sub) => (
                  <div className="subcard" key={sub.photoId}>
                    <img className="thumb" src={sub.publicUrl} alt="" />
                    <div className="grow">
                      {sub.spots.length === 0
                        ? <div className="nm">Not linked to a spot</div>
                        : sub.spots.map((sp) => (
                          <div key={sp.id} className="sub-row" onClick={() => { setModalId(sp.id); setGIndex(0) }}>
                            <span className="nm">{sp.name}</span>
                            <span className="meta">{typeLabel(sp.type)} · {hoodLabel(sp.neighborhood)}
                              {favCounts[sp.id]?.favorites ? ` · ♥ ${favCounts[sp.id].favorites}` : ''}</span>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
            </div>
          )}

          {panelView === 'leaderboard' && (
            <div className="leaderboard">
              {leaderboard.length === 0
                ? <div className="hint-sm">No favorites yet — heart a few spots to get this started.</div>
                : leaderboard.map((s, i) => (
                  <div className="lbrow" key={s.id} onClick={() => { setModalId(s.id); setGIndex(0) }}>
                    <span className="lbrank">{i + 1}</span>
                    {s.photos[0] ? <img className="thumb" src={s.photos[0].public_url} alt="" /> : <div className="thumb ph" />}
                    <div className="grow">
                      <div className="nm">{s.name}</div>
                      <div className="meta"><span className={'tag ' + s.type}>{typeLabel(s.type)}</span>{hoodLabel(s.neighborhood)}</div>
                    </div>
                    <span className="lbcount">♥ {s.favorites}</span>
                  </div>
                ))}
            </div>
          )}
        </div>

        <div id="map" className="map-slot" ref={mapEl} />
      </div>

      <footer>
        Clean map by CARTO. Gold pins are on your wishlist; orange pins are approximate. Zoom in once to see place names on the map.
      </footer>

      {modalSpot && (
        <Modal spot={modalSpot} gIndex={gIndex} setGIndex={setGIndex}
          onClose={() => setModalId(null)} onToggle={toggle}
          user={user} isAdmin={!!profile?.is_admin}
          onAdminSave={async (patch) => { await adminUpdateSpot(modalSpot.id, patch); await refresh(user?.id) }}
          onAdminDelete={async () => { await adminDeleteSpot(modalSpot.id); setModalId(null); await refresh(user?.id) }}
        />
      )}
    </div>
  )
}

function Modal({ spot, gIndex, setGIndex, onClose, onToggle, user, isAdmin, onAdminSave, onAdminDelete }) {
  const photos = spot.photos || []
  const meta = shortAddress(spot.address, spot.neighborhood)
  const idx = photos.length ? ((gIndex % photos.length) + photos.length) % photos.length : 0
  const [zoomed, setZoomed] = useState(false)
  useEffect(() => { setZoomed(false) }, [idx, spot.id])

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)
  useEffect(() => { setEditing(false); setDraft(null) }, [spot.id])
  function startEdit() {
    setDraft({ name: spot.name, address: spot.address || '', neighborhood: spot.neighborhood || '', type: spot.type, status: spot.status || 'unknown' })
    setEditing(true)
  }
  async function saveEdit() { await onAdminSave(draft); setEditing(false) }

  const [comments, setComments] = useState([])
  const [commentText, setCommentText] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  useEffect(() => { loadComments(spot.id).then(setComments) }, [spot.id])
  async function submitComment() {
    if (!commentText.trim() || !user) return
    setCommentBusy(true)
    try {
      const row = await addComment(spot.id, user.id, commentText.trim())
      setComments((c) => [row, ...c])
      setCommentText('')
    } finally { setCommentBusy(false) }
  }

  return (
    <div className="overlay" onClick={(e) => { if (e.target.classList.contains('overlay')) onClose() }}>
      <div className="modal">
        <div className="mhead">
          <button className="mclose" onClick={onClose}>×</button>
          {!editing ? (
            <>
              <div className="mname">{spot.name}</div>
              <div className="mmeta">{meta}{spot.status === 'closed' ? ' · closed' : ''}{spot.favorites ? ` · ♥ ${spot.favorites}` : ''}</div>
              {isAdmin && <button className="linkbtn admin-edit" onClick={startEdit}>Edit details</button>}
            </>
          ) : (
            <div className="admin-form">
              <label>Name<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
              <label>Address<input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} /></label>
              <label>Neighborhood<input value={draft.neighborhood} onChange={(e) => setDraft({ ...draft, neighborhood: e.target.value })} /></label>
              <div className="admin-row">
                <label>Type
                  <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                    {TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                  </select>
                </label>
                <label>Status
                  <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                    <option value="unknown">Unknown</option>
                    <option value="open">Open</option>
                    <option value="closed">Closed</option>
                  </select>
                </label>
              </div>
              <div className="admin-row">
                <button className="go save" onClick={saveEdit}>Save changes</button>
                <button className="ghost" onClick={() => setEditing(false)}>Cancel</button>
                <button className="ghost danger" onClick={() => { if (confirm('Delete this spot entirely? This can’t be undone.')) onAdminDelete() }}>Delete spot</button>
              </div>
            </div>
          )}
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

        <div className="comments">
          <div className="comments-h">Notes &amp; updates</div>
          <p className="hint-sm">Seen this place close, or stop carrying matchbooks? Say so here.</p>
          {user && (
            <div className="comment-form">
              <textarea rows={2} value={commentText} placeholder="Add a note…"
                onChange={(e) => setCommentText(e.target.value)} />
              <button className="go save" disabled={commentBusy || !commentText.trim()} onClick={submitComment}>Post</button>
            </div>
          )}
          {comments.length === 0
            ? <div className="hint-sm">No notes yet.</div>
            : comments.map((c) => (
              <div className="comment" key={c.id}>
                <div className="comment-body">{c.body}</div>
                <div className="comment-meta">{new Date(c.created_at).toLocaleDateString()}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

function AuthBar({ profile, authEmail, setAuthEmail, authStatus, onSend, onSignOut }) {
  if (profile?.email) {
    return (
      <p className="who">
        Signed in as {profile.email}{profile.is_admin ? ' · Admin' : ''} · <button className="linkbtn" onClick={onSignOut}>Sign out</button>
      </p>
    )
  }
  return (
    <div className="authbar">
      <input type="email" placeholder="Sign in with email to track your own submissions"
        value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') onSend() }} />
      <button className="linkbtn" onClick={onSend}>Send link</button>
      {authStatus && <span className="hint-sm">{authStatus}</span>}
    </div>
  )
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
