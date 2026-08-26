import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { ensureUser, ensureProfile, sendMagicLink, signInWithPassword, signOut } from './lib/supabase'
import {
  loadFileToCanvas, canvasToBase64, cropNormalized, tileRects, isValidBbox, canvasToFile,
} from './lib/vision'
import {
  readMatchbooksImage, searchPlaces, uploadPhoto, insertPhoto,
  upsertSpot, linkSpotPhoto, adminUpdateSpot, adminDeleteSpot, adminDeletePhoto, loadSpots,
  loadUserLists, setUserList, loadFavoriteCounts, loadComments, addComment, deleteComment,
  loadMySubmissions, approveSpot, updateOwnSpot, norm,
} from './lib/api'
import CropEditor from './CropEditor'

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
  const [authPassword, setAuthPassword] = useState('')
  const [authStatus, setAuthStatus] = useState('')
  const [spots, setSpots] = useState([])
  const [lists, setLists] = useState({})
  const [favCounts, setFavCounts] = useState({}) // spotId -> { favorites, visits }
  const [accountOpen, setAccountOpen] = useState(false)
  const [mySubs, setMySubs] = useState([])
  const [review, setReview] = useState([])        // proposed matches, not yet saved
  const [pending, setPending] = useState([])       // couldn't place -> manual search
  const [candidates, setCandidates] = useState({}) // pendingId -> results | 'loading'
  const [assigning, setAssigning] = useState(null)  // pendingId currently being saved
  const [filters, setFilters] = useState({ view: 'all', type: 'all', hood: 'all' })
  const [status, setStatus] = useState('')
  const [staged, setStaged] = useState(null)
  const [modalId, setModalId] = useState(null)
  const [gIndex, setGIndex] = useState(0)
  const [cropTarget, setCropTarget] = useState(null) // { kind: 'draft'|'pending', id, canvas, bbox }

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
    try {
      await sendMagicLink(authEmail.trim())
      setAuthStatus('Check your email for a sign-in link.')
    } catch (e) {
      // Show what actually failed — a generic message here made real causes
      // (rate limits, redirect URL not allowlisted) impossible to diagnose.
      console.warn('magic link failed:', e)
      const msg = e?.message || 'Unknown error'
      setAuthStatus(/rate|limit|seconds|too many/i.test(msg)
        ? `Too many sign-in emails just now — wait a few minutes and try again. (${msg})`
        : `Could not send that: ${msg}`)
    }
  }
  // Password sign-in for the admin account — no email involved, so the auth email
  // rate limit can't lock you out of the review queue.
  async function handlePasswordSignIn() {
    if (!authEmail.trim() || !authPassword) return
    setAuthStatus('Signing in…')
    try {
      const u = await signInWithPassword(authEmail.trim(), authPassword)
      setUser(u)
      setProfile(await ensureProfile(u))
      setAuthPassword('')
      setAuthStatus('')
      await refresh(u?.id)
    } catch (e) {
      console.warn('password sign-in failed:', e)
      setAuthStatus(`Could not sign in: ${e?.message || 'Unknown error'}`)
    }
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
    if (accountOpen && user) loadMySubmissions(user.id).then(setMySubs)
  }, [accountOpen, user])

  const hoods = useMemo(
    () => [...new Set(enriched.map((s) => hoodLabel(s.neighborhood)).filter(Boolean))].sort(),
    [enriched]
  )

  // Pending spots come back from the server for their submitter and for admins, but the
  // public map/list only ever shows approved ones — pending lives in My Account.
  const visible = useMemo(() => enriched.filter((s) => {
    if (!s.approved) return false
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
      const bbox = isValidBbox(it.bbox) ? it.bbox : [0, 0, 1, 1]
      const cropFile = await canvasToFile(cropNormalized(canvas, bbox), 'matchbook.jpg')
      const previewUrl = URL.createObjectURL(cropFile)

      const query = it.address ? `${it.name} ${it.address}` : `${it.name}, Chicago`
      const cands = await searchPlaces(query)
      if (cands.length) {
        const c = cands[0]
        drafts.push({
          tempId: crypto.randomUUID(), cropFile, previewUrl, canvas, bbox,
          name: it.name, type: it.type || c.type || 'other',
          address: c.address || it.address || '', neighborhood: c.neighborhood || it.neighborhood || '',
          lat: c.lat, lng: c.lng, status: it.status || 'unknown',
        })
      } else {
        newPending.push({ id: crypto.randomUUID(), cropFile, previewUrl, canvas, bbox, prefill: it.name || '' })
      }
    }
    for (let k = 0; k < unreadable && (drafts.length + newPending.length) < 20; k++) {
      const bbox = [0, 0, 1, 1]
      const cropFile = await canvasToFile(canvas, 'matchbook.jpg')
      newPending.push({ id: crypto.randomUUID(), cropFile, previewUrl: URL.createObjectURL(cropFile), canvas, bbox, prefill: '' })
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
    setPending((p) => [{ id, cropFile: d.cropFile, previewUrl: d.previewUrl, canvas: d.canvas, bbox: d.bbox, prefill: d.name }, ...p])
    setReview((r) => r.filter((x) => x.tempId !== d.tempId))
    runSearch(id, d.name)
  }

  /* ----- manual crop adjustment (review screen, before saving) ----- */
  async function handleCropConfirm(newBbox) {
    const target = cropTarget
    if (!target) return
    const cropped = cropNormalized(target.canvas, newBbox)
    const file = await canvasToFile(cropped, 'matchbook.jpg')
    const url = URL.createObjectURL(file)
    if (target.kind === 'draft') {
      setReview((r) => r.map((d) => {
        if (d.tempId !== target.id) return d
        URL.revokeObjectURL(d.previewUrl)
        return { ...d, cropFile: file, previewUrl: url, bbox: newBbox }
      }))
    } else {
      setPending((p) => p.map((x) => {
        if (x.id !== target.id) return x
        URL.revokeObjectURL(x.previewUrl)
        return { ...x, cropFile: file, previewUrl: url, bbox: newBbox }
      }))
    }
    setCropTarget(null)
  }
  // A draft is only saveable once it carries real coordinates from a Google place pick.
  const unlocated = review.filter((d) => d.lat == null || d.lng == null)

  async function saveReview() {
    if (!review.length || !user) return
    if (unlocated.length) {
      setStatus('Pick a location from the dropdown for every matchbook first.')
      return
    }
    setStatus('Saving…')
    try {
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
      setReview([])
      setStatus(profile?.is_admin
        ? `Saved ${n} spot${n === 1 ? '' : 's'}.`
        : `Submitted ${n} spot${n === 1 ? '' : 's'} for review — you’ll see them in My Account.`)
      await refresh(user.id)
    } catch (e) {
      console.warn(e)
      setStatus('Couldn’t save — try again.')
    }
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
  // Picking a place from the dropdown only stages it as a draft — nothing is written
  // until "Save … to map". That keeps every save behind the one big button.
  function assign(pend, cand) {
    setReview((r) => [...r, {
      tempId: crypto.randomUUID(),
      cropFile: pend.cropFile, previewUrl: pend.previewUrl,
      canvas: pend.canvas, bbox: pend.bbox,
      name: cand.name, type: cand.type || 'other',
      address: cand.address || '', neighborhood: cand.neighborhood || '',
      lat: cand.lat, lng: cand.lng, status: 'unknown',
    }])
    dismissPending(pend.id)
    setStatus('Added to the review list — press “Save to map” when you’re done.')
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
        <div className="headtop">
          <div className="brandrow">
            <div className="match"><div className="stick" /><div className="head flame" /></div>
            <h1>Struck<span className="sub">Chicago matchbook map</span></h1>
          </div>
          <HeaderAccount profile={profile} onOpen={() => setAccountOpen(true)} onSignOut={handleSignOut} />
        </div>
        <p className="lede">Add a photo of a matchbook. It reads the covers, you review the matches, and each spot drops on the map. Dense collages get split into sections and cropped automatically. Can’t read one? Search and pin it yourself.</p>
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
                      <div className="thumb-wrap">
                        <img className="thumb" src={d.previewUrl} alt="" />
                        <button className="cropbtn" title="Adjust crop"
                          onClick={() => setCropTarget({ kind: 'draft', id: d.tempId, canvas: d.canvas, bbox: d.bbox })}>⤢</button>
                      </div>
                      <div className="grow">
                        <input className="draft-name" value={d.name}
                          onChange={(e) => updateDraft(d.tempId, { name: e.target.value })} />
                        <div className={'draft-addr' + (d.lat == null ? ' warn' : '')}>
                          {d.lat == null
                            ? 'No location yet — pick one from the dropdown'
                            : ([d.neighborhood, d.address].filter(Boolean).join(' · ') || 'located')}
                        </div>
                        <div className="draft-row">
                          <select value={d.type} onChange={(e) => updateDraft(d.tempId, { type: e.target.value })}>
                            {TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
                          </select>
                          <button className="linkbtn" onClick={() => draftToPending(d)}>
                            {d.lat == null ? 'Find location' : 'Wrong spot?'}
                          </button>
                        </div>
                      </div>
                      <button className="xbtn" title="Discard" onClick={() => removeDraft(d.tempId)}>×</button>
                    </div>
                  ))}
                  {unlocated.length > 0 && (
                    <div className="hint-sm warn">
                      {unlocated.length} still need{unlocated.length === 1 ? 's' : ''} a location picked from the dropdown.
                    </div>
                  )}
                  <div className="stage-actions">
                    <button className="go save" disabled={unlocated.length > 0} onClick={saveReview}>
                      Save {review.length} to map
                    </button>
                    <button className="ghost" onClick={() => setReview([])}>Discard all</button>
                  </div>
                </>
              )}

              {pending.map((p) => (
                <div className="assign" key={p.id}>
                  <div className="thumb-wrap">
                    <img src={p.previewUrl} alt="unplaced matchbook" />
                    <button className="cropbtn" title="Adjust crop"
                      onClick={() => setCropTarget({ kind: 'pending', id: p.id, canvas: p.canvas, bbox: p.bbox })}>⤢</button>
                  </div>
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
                        <button className="cand" key={i} disabled={assigning === p.id} onClick={() => assign(p, c)}>
                          {assigning === p.id ? 'Saving…' : <>{c.name}<br /><small>{[c.neighborhood, c.address].filter(Boolean).join(' · ')}</small></>}
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

          {/* ---------- results: map list ---------- */}
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
        </div>

        <div id="map" className="map-slot" ref={mapEl} />
      </div>

      <footer>
        Clean map by CARTO. Gold pins are on your wishlist; orange pins are approximate. Zoom in once to see place names on the map.
      </footer>

      <InstallPrompt />

      {accountOpen && (
        <AccountModal
          profile={profile} user={user}
          authEmail={authEmail} setAuthEmail={setAuthEmail} authStatus={authStatus}
          authPassword={authPassword} setAuthPassword={setAuthPassword}
          onSend={handleSendMagicLink} onPasswordSignIn={handlePasswordSignIn} onSignOut={handleSignOut}
          onClose={() => setAccountOpen(false)}
          mySubs={mySubs} enriched={enriched} favCounts={favCounts}
          onToggle={toggle}
          onOpenSpot={(id) => { setAccountOpen(false); setModalId(id); setGIndex(0) }}
          isAdmin={!!profile?.is_admin}
          onApprove={async (id) => { await approveSpot(id); await refresh(user?.id) }}
          onAdminSaveSpot={async (id, patch) => { await adminUpdateSpot(id, patch); await refresh(user?.id) }}
          onOwnSaveSpot={async (id, patch) => { await updateOwnSpot(id, patch); await refresh(user?.id) }}
          onDeleteSpot={async (id) => { await adminDeleteSpot(id); await refresh(user?.id) }}
        />
      )}

      {modalSpot && (
        <Modal spot={modalSpot} gIndex={gIndex} setGIndex={setGIndex}
          onClose={() => setModalId(null)} onToggle={toggle}
          user={user} isAdmin={!!profile?.is_admin}
          onAdminSave={async (patch) => { await adminUpdateSpot(modalSpot.id, patch); await refresh(user?.id) }}
          onAdminDelete={async () => { await adminDeleteSpot(modalSpot.id); setModalId(null); await refresh(user?.id) }}
          onAdminDeletePhoto={async (photoId, storagePath) => { await adminDeletePhoto(photoId, storagePath); await refresh(user?.id) }}
        />
      )}

      {cropTarget && (
        <CropEditor canvas={cropTarget.canvas} bbox={cropTarget.bbox}
          onCancel={() => setCropTarget(null)} onConfirm={handleCropConfirm} />
      )}
    </div>
  )
}

function Modal({ spot, gIndex, setGIndex, onClose, onToggle, user, isAdmin, onAdminSave, onAdminDelete, onAdminDeletePhoto }) {
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
                {isAdmin && (
                  <button className="gdelete" title="Delete this photo"
                    onClick={() => { if (confirm('Delete this photo? This can’t be undone.')) onAdminDeletePhoto(photos[idx].id, photos[idx].storage_path) }}>
                    Delete photo
                  </button>
                )}
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

// Compact account control in the header: a "Sign in" button when signed out, or a small
// "Signed in as …" line (clickable → My Account) with a sign-out link once signed in.
function HeaderAccount({ profile, onOpen, onSignOut }) {
  if (profile?.email) {
    return (
      <div className="acct">
        <button className="acct-who" onClick={onOpen} title="My Account">
          Signed in as {profile.email}{profile.is_admin ? ' · Admin' : ''}
        </button>
        <button className="linkbtn" onClick={onSignOut}>Sign out</button>
      </div>
    )
  }
  return (
    <div className="acct">
      <button className="acct-btn" onClick={onOpen}>Sign in</button>
    </div>
  )
}

// Compact row for a spot inside the account modal's Wishlist / Been tabs.
function AcctSpotRow({ s, favCounts, onToggle, onOpenSpot }) {
  return (
    <div className="acct-spot">
      <div className="top" onClick={() => onOpenSpot(s.id)}>
        {s.photos[0] ? <img className="thumb" src={s.photos[0].public_url} alt="" /> : <div className="thumb ph" />}
        <div className="grow">
          <div className="nm">{s.name}</div>
          <div className="meta">
            <span className={'tag ' + s.type}>{typeLabel(s.type)}</span>
            {[hoodLabel(s.neighborhood)].filter(Boolean)}
            {favCounts[s.id]?.favorites ? ` · ♥ ${favCounts[s.id].favorites}` : ''}
          </div>
        </div>
        <div className="acts">
          <button className={'iact' + (s.wishlist ? ' on-heart' : '')}
            onClick={(e) => { e.stopPropagation(); onToggle(s.id, 'wishlist') }}>♥</button>
          <button className={'iact' + (s.visited ? ' on-check' : '')}
            onClick={(e) => { e.stopPropagation(); onToggle(s.id, 'visited') }}>✓</button>
        </div>
      </div>
    </div>
  )
}

// One submitted spot: shows its review status, and (for the submitter or an admin)
// an inline edit form. A non-admin editing an approved spot sends it back to review.
function SubmissionRow({ s, canEdit, admin, onOpenSpot, onApprove, onSave, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(null)

  function startEdit() {
    setDraft({
      name: s.name, address: s.address || '', neighborhood: s.neighborhood || '',
      type: s.type, status: s.status || 'unknown',
    })
    setEditing(true)
  }
  async function run(fn) {
    setBusy(true)
    try { await fn() } catch (e) { console.warn(e); alert('That didn’t save — try again.') }
    finally { setBusy(false) }
  }

  return (
    <div className="acct-spot subrow">
      <div className="top">
        {s.photos?.[0]
          ? <img className="thumb" src={s.photos[0].public_url} alt="" onClick={() => onOpenSpot(s.id)} />
          : <div className="thumb ph" onClick={() => onOpenSpot(s.id)} />}
        <div className="grow" onClick={() => !editing && onOpenSpot(s.id)}>
          <div className="nm">{s.name}</div>
          <div className="meta">
            <span className={'tag ' + s.type}>{typeLabel(s.type)}</span>
            <span className={'tag ' + (s.approved ? 'approved' : 'pending')}>
              {s.approved ? 'Live' : 'Pending review'}
            </span>
          </div>
          <div className="meta">{shortAddress(s.address, s.neighborhood)}</div>
        </div>
      </div>

      {canEdit && !editing && (
        <div className="subrow-acts">
          {admin && !s.approved && onApprove &&
            <button className="go save tiny" disabled={busy} onClick={() => run(() => onApprove(s.id))}>Approve</button>}
          <button className="ghost tiny" onClick={startEdit}>Edit</button>
          {onDelete && (
            <button className="ghost tiny danger" disabled={busy}
              onClick={() => { if (confirm('Delete this spot entirely? This can’t be undone.')) run(onDelete) }}>
              Delete
            </button>
          )}
        </div>
      )}

      {editing && (
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
          {!admin && s.approved && (
            <div className="hint-sm warn">Saving changes sends this back for review.</div>
          )}
          <div className="admin-row">
            <button className="go save tiny" disabled={busy}
              onClick={() => run(async () => { await onSave(draft); setEditing(false) })}>Save</button>
            <button className="ghost tiny" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

// "My Account" modal: sign-in form when signed out, else tabs for the user's own
// submissions, wishlist, and been-there lists.
function AccountModal({ profile, user, authEmail, setAuthEmail, authStatus,
  authPassword, setAuthPassword, onSend, onPasswordSignIn, onSignOut,
  onClose, mySubs, enriched, favCounts, onToggle, onOpenSpot,
  isAdmin, onApprove, onAdminSaveSpot, onOwnSaveSpot, onDeleteSpot }) {
  const [mode, setMode] = useState('password') // signed-out: 'password' | 'link'
  const [tab, setTab] = useState(isAdmin ? 'queue' : 'subs')
  const signedIn = !!profile?.email

  const wishlist = useMemo(() => enriched.filter((s) => s.wishlist), [enriched])
  const visited = useMemo(() => enriched.filter((s) => s.visited), [enriched])
  const queue = useMemo(() => enriched.filter((s) => !s.approved), [enriched])
  const mySpots = useMemo(
    () => enriched.filter((s) => user && s.submitted_by === user.id),
    [enriched, user]
  )

  return (
    <div className="overlay" onClick={(e) => { if (e.target.classList.contains('overlay')) onClose() }}>
      <div className="modal acct-modal">
        <div className="mhead">
          <button className="mclose" onClick={onClose}>×</button>
          {!signedIn ? (
            <>
              <div className="mname">Sign in</div>
              <div className="mmeta">Track your submissions, wishlist, and been-there list.</div>
            </>
          ) : (
            <>
              <div className="mname">My Account</div>
              <div className="mmeta">Signed in as {profile.email}{profile.is_admin ? ' · Admin' : ''} · <button className="linkbtn" onClick={onSignOut}>Sign out</button></div>
            </>
          )}
        </div>

        {!signedIn ? (
          <div className="acct-body">
            <div className="acct-tabs">
              <button className={'atab' + (mode === 'password' ? ' on' : '')} onClick={() => setMode('password')}>Password</button>
              <button className={'atab' + (mode === 'link' ? ' on' : '')} onClick={() => setMode('link')}>Email link</button>
            </div>
            <input className="acct-input" type="email" placeholder="you@email.com" autoComplete="username"
              value={authEmail} onChange={(e) => setAuthEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && mode === 'link') onSend() }} />
            {mode === 'password' ? (
              <>
                <input className="acct-input" type="password" placeholder="Password" autoComplete="current-password"
                  value={authPassword} onChange={(e) => setAuthPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onPasswordSignIn() }} />
                <button className="go" onClick={onPasswordSignIn}>Sign in</button>
              </>
            ) : (
              <button className="go" onClick={onSend}>Send sign-in link</button>
            )}
            {authStatus && <div className="hint-sm">{authStatus}</div>}
          </div>
        ) : (
          <>
            <div className="acct-tabs">
              {isAdmin && (
                <button className={'atab' + (tab === 'queue' ? ' on' : '')} onClick={() => setTab('queue')}>
                  Pending{queue.length ? ` (${queue.length})` : ''}
                </button>
              )}
              <button className={'atab' + (tab === 'subs' ? ' on' : '')} onClick={() => setTab('subs')}>Mine</button>
              <button className={'atab' + (tab === 'wishlist' ? ' on' : '')} onClick={() => setTab('wishlist')}>♥ Wishlist</button>
              <button className={'atab' + (tab === 'visited' ? ' on' : '')} onClick={() => setTab('visited')}>✓ Been</button>
            </div>
            <div className="acct-body">
              {tab === 'queue' && (
                queue.length === 0
                  ? <div className="hint-sm">Nothing waiting for review — you’re all caught up.</div>
                  : queue.map((s) => (
                    <SubmissionRow key={s.id} s={s} canEdit admin
                      onOpenSpot={onOpenSpot} onApprove={onApprove}
                      onSave={(patch) => onAdminSaveSpot(s.id, patch)}
                      onDelete={() => onDeleteSpot(s.id)} />
                  ))
              )}
              {tab === 'subs' && (
                !user ? <div className="hint-sm">Connecting…</div>
                  : mySpots.length === 0 && mySubs.length === 0
                    ? <div className="hint-sm">Nothing submitted yet from this account.</div>
                    : <>
                        {mySpots.map((s) => (
                          <SubmissionRow key={s.id} s={s} canEdit admin={isAdmin}
                            onOpenSpot={onOpenSpot} onApprove={isAdmin ? onApprove : null}
                            onSave={(patch) => (isAdmin ? onAdminSaveSpot(s.id, patch) : onOwnSaveSpot(s.id, patch))}
                            onDelete={isAdmin ? () => onDeleteSpot(s.id) : null} />
                        ))}
                        {mySpots.length === 0 && mySubs.map((sub) => (
                          <div className="subcard" key={sub.photoId}>
                            <img className="thumb" src={sub.publicUrl} alt="" />
                            <div className="grow">
                              {sub.spots.length === 0
                                ? <div className="nm">Not linked to a spot</div>
                                : sub.spots.map((sp) => (
                                  <div key={sp.id} className="sub-row" onClick={() => onOpenSpot(sp.id)}>
                                    <span className="nm">{sp.name}</span>
                                    <span className="meta">{typeLabel(sp.type)} · {hoodLabel(sp.neighborhood)}</span>
                                  </div>
                                ))}
                            </div>
                          </div>
                        ))}
                      </>
              )}
              {tab === 'wishlist' && (
                wishlist.length === 0 ? <div className="hint-sm">Nothing on your wishlist yet — tap ♥ on a spot to add it.</div>
                  : wishlist.map((s) => <AcctSpotRow key={s.id} s={s} favCounts={favCounts} onToggle={onToggle} onOpenSpot={onOpenSpot} />)
              )}
              {tab === 'visited' && (
                visited.length === 0 ? <div className="hint-sm">No been-there spots yet — tap ✓ on a spot to mark it.</div>
                  : visited.map((s) => <AcctSpotRow key={s.id} s={s} favCounts={favCounts} onToggle={onToggle} onOpenSpot={onOpenSpot} />)
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Prompt to install the site to the home screen. Android/desktop Chrome fire
// beforeinstallprompt and get a real button; iOS Safari has no such API, so it gets
// the manual Share → Add to Home Screen instructions instead.
function InstallPrompt() {
  const [deferred, setDeferred] = useState(null)
  const [showIos, setShowIos] = useState(false)
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('struck-install-dismissed') === '1' } catch { return false }
  })

  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  const standalone = typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone)
  const isIos = typeof navigator !== 'undefined' &&
    /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream

  if (standalone || dismissed) return null
  if (!deferred && !isIos) return null

  function close() {
    setDismissed(true)
    try { localStorage.setItem('struck-install-dismissed', '1') } catch { /* private mode */ }
  }

  return (
    <div className="installbar">
      <div className="grow">
        <b>Add Struck to your home screen</b>
        {showIos || !deferred
          ? <div className="hint-sm">Tap the Share icon, then “Add to Home Screen”.</div>
          : <div className="hint-sm">Get to the map in one tap, like an app.</div>}
      </div>
      {deferred
        ? <button className="go save tiny" onClick={async () => { deferred.prompt(); setDeferred(null) }}>Install</button>
        : <button className="ghost tiny" onClick={() => setShowIos((v) => !v)}>How?</button>}
      <button className="xbtn" title="Dismiss" onClick={close}>×</button>
    </div>
  )
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1) }
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
