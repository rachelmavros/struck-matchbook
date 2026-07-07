// Canvas helpers for reading + cropping matchbook photos.
// Strategy: keep one high-resolution working canvas per upload. A "simple" photo (few items)
// is read in a single pass. A "dense" collage (many tiny covers) is split into four overlapping
// quadrants so each cover gets more effective resolution in the model's eyes. Either way, the
// model returns a normalized bounding box per item, which we use to crop that exact matchbook
// out of the working canvas — that crop becomes the photo stored for that specific spot.

export function loadFileToCanvas(file, maxLongEdge = 2800) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      const scale = Math.min(1, maxLongEdge / Math.max(width, height))
      width = Math.round(width * scale); height = Math.round(height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      resolve(canvas)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}

// A lightly-downscaled copy of a canvas, base64-encoded, for sending to Vision.
export function canvasToBase64(canvas, maxLongEdge = 1568, quality = 0.85) {
  const scale = Math.min(1, maxLongEdge / Math.max(canvas.width, canvas.height))
  let source = canvas
  if (scale < 1) {
    const w = Math.round(canvas.width * scale), h = Math.round(canvas.height * scale)
    const small = document.createElement('canvas')
    small.width = w; small.height = h
    small.getContext('2d').drawImage(canvas, 0, 0, w, h)
    source = small
  }
  const dataUrl = source.toDataURL('image/jpeg', quality)
  return { base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' }
}

// Crop a normalized [xmin,ymin,xmax,ymax] region (0..1) out of a canvas, with a little padding.
export function cropNormalized(canvas, bbox, padFrac = 0.06) {
  const [x0, y0, x1, y1] = bbox
  const w = canvas.width, h = canvas.height
  const padX = (x1 - x0) * padFrac * w, padY = (y1 - y0) * padFrac * h
  const left = Math.max(0, Math.round(x0 * w - padX))
  const top = Math.max(0, Math.round(y0 * h - padY))
  const right = Math.min(w, Math.round(x1 * w + padX))
  const bottom = Math.min(h, Math.round(y1 * h + padY))
  const cw = Math.max(1, right - left), ch = Math.max(1, bottom - top)
  const out = document.createElement('canvas')
  out.width = cw; out.height = ch
  out.getContext('2d').drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch)
  return out
}

// Four overlapping quadrants (normalized rects) for splitting a dense collage.
export function tileRects(overlap = 0.12) {
  const w = 0.5 + overlap, h = 0.5 + overlap
  const x2 = 0.5 - overlap, y2 = 0.5 - overlap
  return [
    { x: 0, y: 0, w, h }, { x: x2, y: 0, w, h },
    { x: 0, y: y2, w, h }, { x: x2, y: y2, w, h },
  ]
}

export function isValidBbox(b) {
  return Array.isArray(b) && b.length === 4 && b.every((n) => typeof n === 'number' && n >= 0 && n <= 1)
}

// Final export used for storage — capped smaller than the working canvas so uploads stay light.
export function canvasToFile(canvas, filename = 'matchbook.jpg', maxLongEdge = 1400, quality = 0.88) {
  return new Promise((resolve) => {
    const scale = Math.min(1, maxLongEdge / Math.max(canvas.width, canvas.height))
    let source = canvas
    if (scale < 1) {
      const w = Math.round(canvas.width * scale), h = Math.round(canvas.height * scale)
      const small = document.createElement('canvas')
      small.width = w; small.height = h
      small.getContext('2d').drawImage(canvas, 0, 0, w, h)
      source = small
    }
    source.toBlob((blob) => resolve(new File([blob], filename, { type: 'image/jpeg' })), 'image/jpeg', quality)
  })
}
