// POST /api/read  { imageUrl }  ->  { items:[...], unreadable:number }
// Keeps ANTHROPIC_API_KEY server-side. Model is configurable via MATCHBOOK_MODEL.

const MODEL = process.env.MATCHBOOK_MODEL || 'claude-sonnet-5'

const PROMPT = `Photo of one or more Chicago matchbooks/matchboxes. Read each legible one.
Return ONLY JSON, no prose, no code fences:
{"items":[{"name":string,"address":string|null,"neighborhood":string|null,"type":"bar"|"restaurant"|"hotel"|"theater"|"other","status":"open"|"closed"|"unknown"}],"unreadable":number}
Prefer any street address or phone actually printed on the box. "type" is the kind of venue. "unreadable" = number of matchbooks visible but whose name you cannot read. If none are readable, use items:[].`

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' })

  const { imageUrl } = req.body || {}
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' })

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
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: imageUrl } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    })
    const data = await r.json()
    if (!r.ok) return res.status(502).json({ error: 'anthropic error', detail: data })

    let txt = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    txt = txt.replace(/```json|```/g, '').trim()
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}')
    if (s >= 0) txt = txt.slice(s, e + 1)
    const parsed = JSON.parse(txt)
    return res.status(200).json({ items: parsed.items || [], unreadable: parsed.unreadable || 0 })
  } catch (err) {
    return res.status(500).json({ error: String(err) })
  }
}
