import { useEffect, useRef, useState } from 'react'

const MIN_SIZE = 0.04

function clamp01(n) { return Math.min(1, Math.max(0, n)) }

// A small draggable/resizable crop rectangle over a canvas — lets the reviewer fix a
// matchbook's bounding box before it's saved. Coordinates in/out are normalized (0..1),
// matching the same format cropNormalized() in lib/vision.js expects.
export default function CropEditor({ canvas, bbox, onCancel, onConfirm }) {
  const previewRef = useRef(null)
  const stageRef = useRef(null)
  const dragRef = useRef(null) // { mode, startClient: {x,y}, startRect }
  const [rect, setRect] = useState(() => {
    if (!Array.isArray(bbox) || bbox.length !== 4) return { x0: 0, y0: 0, x1: 1, y1: 1 }
    const [x0, y0, x1, y1] = bbox
    return { x0, y0, x1, y1 }
  })

  useEffect(() => {
    const el = previewRef.current
    if (!el || !canvas) return
    el.width = canvas.width
    el.height = canvas.height
    el.getContext('2d').drawImage(canvas, 0, 0)
  }, [canvas])

  useEffect(() => {
    function onMove(e) {
      const d = dragRef.current
      if (!d) return
      const box = stageRef.current.getBoundingClientRect()
      const dx = (e.clientX - d.startClient.x) / box.width
      const dy = (e.clientY - d.startClient.y) / box.height
      let { x0, y0, x1, y1 } = d.startRect

      if (d.mode === 'move') {
        const w = x1 - x0, h = y1 - y0
        x0 = clamp01(x0 + dx); x1 = x0 + w
        if (x1 > 1) { x1 = 1; x0 = 1 - w }
        y0 = clamp01(y0 + dy); y1 = y0 + h
        if (y1 > 1) { y1 = 1; y0 = 1 - h }
      } else {
        if (d.mode.includes('w')) x0 = clamp01(x0 + dx)
        if (d.mode.includes('e')) x1 = clamp01(x1 + dx)
        if (d.mode.includes('n')) y0 = clamp01(y0 + dy)
        if (d.mode.includes('s')) y1 = clamp01(y1 + dy)
        if (x1 - x0 < MIN_SIZE) { if (d.mode.includes('w')) x0 = x1 - MIN_SIZE; else x1 = x0 + MIN_SIZE }
        if (y1 - y0 < MIN_SIZE) { if (d.mode.includes('n')) y0 = y1 - MIN_SIZE; else y1 = y0 + MIN_SIZE }
      }
      setRect({ x0, y0, x1, y1 })
    }
    function onUp() { dragRef.current = null }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  function startDrag(mode) {
    return (e) => {
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = { mode, startClient: { x: e.clientX, y: e.clientY }, startRect: rect }
    }
  }

  return (
    <div className="overlay cropoverlay" onClick={(e) => { if (e.target.classList.contains('overlay')) onCancel() }}>
      <div className="modal cropmodal">
        <div className="mhead">
          <button className="mclose" onClick={onCancel}>×</button>
          <div className="mname">Adjust crop</div>
          <div className="mmeta">Drag the rectangle or its corners, then confirm.</div>
        </div>
        <div className="crop-stage" ref={stageRef}>
          <canvas ref={previewRef} className="crop-canvas" />
          <div
            className="crop-rect"
            style={{
              left: (rect.x0 * 100) + '%', top: (rect.y0 * 100) + '%',
              width: ((rect.x1 - rect.x0) * 100) + '%', height: ((rect.y1 - rect.y0) * 100) + '%',
            }}
            onPointerDown={startDrag('move')}
          >
            {['nw', 'ne', 'sw', 'se'].map((h) => (
              <span key={h} className={'crop-handle ' + h} onPointerDown={startDrag(h)} />
            ))}
          </div>
        </div>
        <div className="stage-actions crop-actions">
          <button className="go save" onClick={() => onConfirm([rect.x0, rect.y0, rect.x1, rect.y1])}>Use this crop</button>
          <button className="ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
