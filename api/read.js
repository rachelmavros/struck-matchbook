// POST /api/read  { imageBase64, mediaType } (preferred) or { imageUrl } (legacy)
// ->  { items:[{name,address,neighborhood,type,status,bbox}], unreadable:number }
// bbox is [xmin,ymin,xmax,ymax], normalized 0..1 within the image actually sent.
// Keeps ANTHROPIC_API_KEY server-side. Model is configurable via MATCHBOOK_MODEL.

const MODEL = process.env.MATCHBOOK_MODEL || 'claude-sonnet-5'

const PROMPT = `Photo of one or more Chicago matchbooks/matchboxes, possibly a dense collage of many.
For each legible one, report its cover details AND a tight bounding box around just that single
matchbook's cover (not the whole photo). bbox is [xmin,ymin,xmax,ymax] as fractions of this image's
width/height (0 = left/top edge, 1 = right/bottom edge).

Return ONLY JSON, no prose, no code fences:
{"items":[{"name":string,"address":string|null,"neighborhood":string|null,"type":"bar"|"restaurant"|"hotel"|"theater"|"other","status":"open"|"closed"|"unknown","bbox":[number,number,number,number]}],"unreadable":number}

Prefer any street address or phone actually printed on the box. "unreadable" = number of matchbooks
visible but whose name you cannot read (these don't need a bbox). If there are more than 16 legible
matchbooks, report the 16 clearest ones and count the rest toward "unreadable". If none are readable,
use items:[].`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })

  const { imageUrl, imageBase64, mediaType } = req.body || {}
  let imageBlock
  if (imageBase64) {
    imageBlock = { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } }
  } else if (imageUrl) {
    imageBlock = { type: 'image', source: { type: 'url', url: imageUrl } }
  } else {
    return res.status(400).json({ error: 'imageBase64 or imageUrl required' })
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        messages: [{ role: 'user', content: [imageBlock, { type: 'text', text: PROMPT }] }],
      }),
    })
    const data = await r.json()
    if (!r.ok) return res.status(502).json({ error: 'anthropic error', detail: data })

    let txt = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    txt = txt.replace(/```json|```/g, '').trim()
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}')
    if (s >= 0) txt = txt.slice(s, e + 1)
    const parsed = JSON.parse(txt)
    const items = (parsed.items || []).map((it) => ({
      ...it,
      bbox: Array.isArray(it.bbox) && it.bbox.length === 4 ? it.bbox.map(Number) : null,
    }))
    return res.status(200).json({ items, unreadable: parsed.unreadable || 0 })
  } catch (err) {
    return res.status(500).json({ error: String(err) })
  }
}
