import { useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import { ensureUser } from './lib/supabase'
import {
  readMatchbooks, searchPlaces, uploadPhoto, insertPhoto,
  upsertSpot, linkSpotPhoto, updateSpotType, loadSpots,
  loadUserLists, setUserList,
} from './lib/api'

const CHI = [41.8781, -87.6298]

export default function App() {
  const [user, setUser] = useState(null)
  const [spots, setSpots] = useState([])
  const [lists, setLists] = useState({})           // spotId -> {wishlist, visited}
  const [pending, setPending] = useState([])        // {id, photoId, photoUrl, prefill}
  const [candidates, setCandidates] = useState({})  // pendingId -> [results]
  const [filters, setFilters] = useState({ view: 'all', type: 'all', hood: 'all' })
  const [status, setStatus] = useState('')
  const [staged, setStaged] = useState(null)        // {file, url}
  const [modalId, setModalId] = useState(null)
  const [gIndex, setGIndex] = useState(0)

  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)

  /* ----- boot ----- */
  useEffect(() => {
    mapRef.current = L.map(mapEl.current, { scrollWheelZoom: false }).setView(CHI, 12)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap',
    }).addTo(mapRef.current)
    layerRef.current = L.layerGroup().addTo(mapRef.current)

    window.__openSpot = (id) => { setModalId(id); setGIndex(0) }
    ;(async () => {
      const u = await ensureUser()
      setUser(u)
      await refresh(u?.id)
    })()
    return () => { mapRef.current?.remove() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function refresh(userId) {
    try {
      const [sp, ul] = await Promise.all([loadSpots(), loadUserLists(userId)])
      setSpots(sp)
      setLists(ul)
    } catch (e) {
      console.warn(e)
      setStatus('Could not load the map yet — check the Supabase setup in the README.')
    }
  }

  /* ----- merge user lists onto spots ----- */
  const enriched = useMemo(() => spots.map((s) => ({
    ...s,
    wishlist: lists[s.id]?.wishlist || false,
    visited: lists[s.id]?.visited || false,
  })), [spots, lists])

  const hoods = useMemo(
    () => [...new Set(enriched.map((s) => s.neighborhood).filter(Boolean))].sort(),
    [enriched]
  )

  const visible = useMemo(() => enriched.filter((s) => {
    if (filters.view === 'wishlist' && !s.wishlist) return false
    if (filters.view === 'visited' && !s.visited) return false
    if (filters.type !== 'all' && s.type !== filters.type) return false
    if (filters.hood !== 'all' && (s.neighborhood || '') !== filters.hood) return false
    return true
  }), [enriched, filters])

  /* ----- draw markers when visible set changes ----- */
  useEffect(() => {
    const layer = layerRef.current
    if (!layer) return
    layer.clearLayers()
    const ms = []
    visible.forEach((s) => {
      if (s.lat == null || s.lng == null) return
      const cls = s.wishlist ? 'wish' : (s.approx ? 'approx' : '')
      const icon = L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [16, 16], iconAnchor: [8, 16] })
      const m = L.marker([s.lat, s.lng], { icon })
      const meta = [s.neighborhood, s.address].filter(Boolean).join(' · ')
      m.bindPopup(
        `<b>${esc(s.name)}</b><br>` +
        `<span class="pop-meta">${s.type}${s.status === 'closed' ? ' · closed' : ''}${meta ? '<br>' + esc(meta) : ''}</span><br>` +
        `<button class="popbtn" onclick="window.__openSpot('${s.id}')">View photos (${s.photos.length})</button>`
      )
      layer.addLayer(m)
      ms.push(m)
    })
    if (ms.length) {
      const g = L.featureGroup(ms)
      mapRef.current.fitBounds(g.getBounds().pad(0.25))
    }
  }, [visible])

  /* ----- upload + read ----- */
  function onFile(e) {
    const f = e.target.files[0]
    if (!f) return
    const url = URL.createObjectURL(f)
    setStaged({ file: f, url })
  }

  async function handleUpload() {
    if (!staged || !user) return
    setStatus('Uploading photo…')
    let photo
    try {
      const up = await uploadPhoto(staged.file, user.id)
      photo = await insertPhoto({ path: up.path, publicUrl: up.publicUrl, userId: user.id })
    } catch (e) {
      setStatus('Upload failed — check the storage bucket in the README.')
      return
    }

    setStatus('Reading the covers…')
    let items = [], unreadable = 0
    try {
      const res = await readMatchbooks(photo.public_url)
      items = res.items || []; unreadable = res.unreadable || 0
    } catch (e) {
      setStatus('Couldn’t read that photo — try a sharper, closer shot.')
      return
    }

    const newPending = []
    let placed = 0
    for (let i = 0; i < items.length && i < 12; i++) {
      const it = items[i]
      setStatus(`Placing ${i + 1}/${Math.min(items.length, 12)}: ${it.name}`)
      const query = it.address ? `${it.name} ${it.address}` : `${it.name}, Chicago`
      const cands = await searchPlaces(query)
      if (cands.length) {
        const c = cands[0]
        const spot = await upsertSpot({
          name: it.name, address: c.address || it.address, neighborhood: c.neighborhood || it.neighborhood,
          type: it.type || c.type || 'bar', status: it.status || 'unknown',
          lat: c.lat, lng: c.lng, approx: false,
        })
        await linkSpotPhoto(spot.id, photo.id)
        placed++
      } else {
        newPending.push({ id: crypto.randomUUID(), photoId: photo.id, photoUrl: photo.public_url, prefill: it.name || '' })
      }
    }
    for (let k = 0; k < unreadable; k++) {
      newPending.push({ id: crypto.randomUUID(), photoId: photo.id, photoUrl: photo.public_url, prefill: '' })
    }

    setPending((p) => [...newPending, ...p])
    setStaged(null)
    setStatus(`Added ${placed} spot${placed === 1 ? '' : 's'}${newPending.length ? ` · ${newPending.length} need placing below` : ''}.`)
    await refresh(user.id)
    // auto-run search for pending items that came with a name
    newPending.filter((p) => p.prefill).forEach((p) => runSearch(p.id, p.prefill))
  }

  /* ----- manual assignment ----- */
  async function runSearch(pendId, query) {
    if (!query.trim()) return
    setCandidates((c) => ({ ...c, [pendId]: 'loading' }))
    const res = await searchPlaces(query)
    setCandidates((c) => ({ ...c, [pendId]: res }))
  }

  async function assign(pend, cand) {
    const spot = await upsertSpot({
      name: cand.name, address: cand.address, neighborhood: cand.neighborhood,
      type: cand.type || 'bar', status: 'unknown', lat: cand.lat, lng: cand.lng, approx: false,
    })
    await linkSpotPhoto(spot.id, pend.photoId)
    setPending((p) => p.filter((x) => x.id !== pend.id))
    setCandidates((c) => { const n = { ...c }; delete n[pend.id]; return n })
    await refresh(user.id)
  }

  /* ----- wishlist / visited ----- */
  async function toggle(spotId, key) {
    const cur = lists[spotId] || { wishlist: false, visited: false }
    const next = { ...cur, [key]: !cur[key] }
    setLists((l) => ({ ...l, [spotId]: next }))          // optimistic
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
        <p className="lede">Add a photo of a matchbook. It reads the covers and maps each spot. Can’t read one? Search and pin it yourself. Every photo of a place stacks up in its gallery.</p>
        <p className="who">{user ? 'Your wishlist and been-there are saved to this browser.' : 'Connecting…'}</p>
      </header>

      <div className="strip" />

      <div className="cols">
        <div className="panel">
          <h2>Add matchbooks</h2>
          <label className={'drop' + (staged ? ' has' : '')}>
            <input type="file" accept="image/*" hidden onChange={onFile} />
            {staged
              ? <img src={staged.url} alt="staged matchbook" />
              : <div className="hint"><b>Tap to add a photo</b><br />a single cover or a full spread</div>}
          </label>
          <button className="go" onClick={handleUpload} disabled={!staged}>Map these matchbooks</button>
          <div className="status">{status}</div>

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
                  <option value="bar">Bar</option>
                  <option value="restaurant">Restaurant</option>
                  <option value="other">Other</option>
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

          {/* assignment queue */}
          {pending.map((p) => (
            <div className="assign" key={p.id}>
              <img src={p.photoUrl} alt="unplaced matchbook" />
              <div className="body">
                <div className="lbl">Couldn’t place this one</div>
                <input defaultValue={p.prefill} placeholder="Search a bar or restaurant…"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(p.id, e.currentTarget.value) } }} />
                <div>
                  {candidates[p.id] === 'loading' && <div style={{ fontSize: 12, color: '#8a7c63', marginTop: 6 }}>searching…</div>}
                  {Array.isArray(candidates[p.id]) && candidates[p.id].length === 0 &&
                    <div style={{ fontSize: 12, color: '#8a7c63', marginTop: 6 }}>no matches — try another name</div>}
                  {Array.isArray(candidates[p.id]) && candidates[p.id].map((c, i) => (
                    <button className="cand" key={i} onClick={() => assign(p, c)}>
                      {c.name}<br /><small>{c.address}</small>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ))}

          {/* results list */}
          {enriched.length > 0 && <div className="results-h">{visible.length} spot{visible.length === 1 ? '' : 's'}</div>}
          {visible.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
            <div className="spot" key={s.id} onClick={() => { setModalId(s.id); setGIndex(0) }}>
              <div className="top">
                <div>
                  <div className="nm">{s.name}</div>
                  <div className="meta">
                    <span className={'tag ' + s.type}>{s.type}</span>
                    {s.status === 'closed' && <span className="tag closed">closed</span>}
                    {s.approx && <span className="tag approx">approx</span>}
                    {s.neighborhood || s.address}
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

        <div id="map" ref={mapEl} />
      </div>

      <footer>
        Placed spots come from geocoding cover art, so vintage or renamed places may sit approximately (orange pins) — search and re-pin any that look off. Gold pins are on your wishlist.
      </footer>

      {modalSpot && (
        <Modal spot={modalSpot} gIndex={gIndex} setGIndex={setGIndex}
          onClose={() => setModalId(null)} onToggle={toggle} onType={changeType} />
      )}
    </div>
  )
}

function Modal({ spot, gIndex, setGIndex, onClose, onToggle, onType }) {
  const photos = spot.photos || []
  const meta = [spot.neighborhood, spot.address].filter(Boolean).join(' · ')
  const idx = photos.length ? ((gIndex % photos.length) + photos.length) % photos.length : 0
  return (
    <div className="overlay" onClick={(e) => { if (e.target.classList.contains('overlay')) onClose() }}>
      <div className="modal">
        <div className="mhead">
          <button className="mclose" onClick={onClose}>×</button>
          <div className="mname">{spot.name}</div>
          <div className="mmeta">{meta}{spot.status === 'closed' ? ' · closed' : ''}</div>
        </div>
        <div className="gallery">
          {photos.length === 0
            ? <div className="gempty">No photos yet.</div>
            : <>
                <img src={photos[idx].public_url} alt={spot.name} />
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
        <div className="mtype">Type
          <select value={spot.type} onChange={(e) => onType(spot.id, e.target.value)}>
            <option value="bar">Bar</option>
            <option value="restaurant">Restaurant</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
    </div>
  )
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
