# Struck — Chicago Matchbook Map

Upload a photo of a matchbook (or a whole collection). Claude reads the covers, each spot is
geocoded and dropped on a map, and every photo of a place stacks up in its gallery. Save spots
to a wishlist, check off the ones you've been to, and filter by type and neighborhood.

## Stack
- **Vite + React + Leaflet** frontend
- **Supabase** — Postgres (spots/photos/lists), Storage (photo files), anonymous auth
- **Vercel serverless** — `/api/read` (Claude Vision) and `/api/geocode` (Places), so no keys ship to the browser

## One-time setup (all in the browser, no terminal needed)

### 1. Supabase
1. Create a project at supabase.com.
2. **SQL Editor → New query** → paste `supabase/schema.sql` → **Run**. This creates the tables,
   row-level-security policies, and the public `matchbooks` storage bucket.
3. **Authentication → Sign In / Providers → Anonymous** → enable it. (This is what lets wishlist/
   been-there persist per browser without a login screen.)
4. **Project Settings → API** → copy the **Project URL** and the **anon public** key.

### 2. Google Places key (recommended)
Nominatim (the free fallback) doesn't know most bars and restaurants by name — that's why a spot
like *Ciccio Mio* can't be found without this. In Google Cloud, enable the **Places API (New)**,
create an API key, and restrict it to that API.

### 3. Deploy on Vercel
1. Push this folder to a GitHub repo (GitHub web UI is fine — drag the files in).
2. Import the repo in Vercel. It auto-detects Vite.
3. **Settings → Environment Variables** — add everything from `.env.example`:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (browser)
   - `ANTHROPIC_API_KEY`, `MATCHBOOK_MODEL` (server)
   - `GOOGLE_PLACES_KEY` (server, optional)
4. Deploy.

## Costs to know
- **Claude Vision**: ~1¢ per photo on `claude-sonnet-5`; a few tenths of a cent on
  `claude-haiku-4-5-20251001`. Set `MATCHBOOK_MODEL` to switch.
- **Google Places**: Text Search is billed per request; the free monthly credit covers light use.
- **Supabase / Vercel**: free tiers are plenty to start.

## Notes / next steps
- Dedupe is by normalized name (`name_key`), so "Green Mill" and "The Green Mill" would still make
  two pins. A fuzzy match (or a confirm-merge step) is the obvious follow-up.
- Anonymous auth ties lists to a browser session. Add email/OAuth later to sync across devices.
- Community moderation (confirm-a-pin, flag duplicates) is worth adding before opening uploads widely.
