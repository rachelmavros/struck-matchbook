// Shared per-visitor daily quota for the paid endpoints (/api/read, /api/geocode).
// Files starting with "_" in /api are helpers, not routes, on Vercel.
// Only a keyed hash of scope + IP + date is stored (see supabase/migration_rate_limit.sql);
// rows are purged after two days. Fails open if Supabase or the migration isn't available.
import { createHmac } from 'node:crypto'

export async function withinQuota(req, scope, limit) {
  const url = process.env.VITE_SUPABASE_URL, anon = process.env.VITE_SUPABASE_ANON_KEY
  const secret = process.env.RATE_LIMIT_SECRET || process.env.ANTHROPIC_API_KEY
  if (!url || !anon || !secret) return true
  const ip = String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.socket?.remoteAddress || '')
    .split(',')[0].trim()
  if (!ip) return true
  // 'read' keeps the original key format so today's counts carry over.
  const prefix = scope === 'read' ? '' : scope + '|'
  const key = createHmac('sha256', secret).update(prefix + ip + '|' + new Date().toISOString().slice(0, 10)).digest('hex')
  try {
    const r = await fetch(`${url}/rest/v1/rpc/take_read_quota`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: anon, authorization: `Bearer ${anon}` },
      body: JSON.stringify({ p_key: key, p_limit: limit }),
    })
    if (!r.ok) { console.warn('quota check failed:', r.status, await r.text()); return true }
    return (await r.json()) !== false
  } catch (e) {
    console.warn('quota check error:', e)
    return true
  }
}
