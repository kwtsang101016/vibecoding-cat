# vibecoding-cat

Class Attending Table (CAT) for the CUHK **Vibe Coding Workshop 2026**.

- Live seating / name cards (self-created: name + PIN)
- Task marks: survey (Task 1), HTML upload (Task 2), GitHub link (Task 3)
- Deployed on **Render** (not GitHub Pages)

Slides: https://kwtsang101016.github.io/activities/vibecoding2026/

## Status

`cat/` app is in the repo (baseline CAT adapted from DDA1000). Workshop-specific features (self-create cards, survey Task 1–3, charts) come next.

## Render setup (do these in order)

### 1. This GitHub repo
Already created as `kwtsang101016/vibecoding-cat`.

### 2. Upstash Redis (free)
1. Sign in at https://upstash.com/
2. Create a Redis database (pick a nearby region)
3. Copy **REST URL** and **REST TOKEN**
4. Keep them for the Render env vars below

Without Redis, name cards and submissions are lost when Render sleeps/redeploys.

### 3. Create the Render Web Service
1. Open https://dashboard.render.com/
2. **New +** → **Web Service**
3. Connect GitHub → select `kwtsang101016/vibecoding-cat`
4. Settings:
   - **Name:** `vibecoding-cat`
   - **Language / Runtime:** Node
   - **Root Directory:** `cat`  (same pattern as `dda1000-cat` / `sta2002-cat`)
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Instance type:** Free
5. **Environment** → add:
   - `NODE_VERSION` = `22`
   - `INSTRUCTOR_PIN` = (your secret PIN for class)
   - `UPSTASH_REDIS_REST_URL` = (from Upstash)
   - `UPSTASH_REDIS_REST_TOKEN` = (from Upstash)
6. Create Web Service and wait for the first deploy

You can also use the root `render.yaml` via **New +** → **Blueprint** if you prefer Infrastructure-as-Code (you will still type the secret env values).

### 4. After first deploy
1. Open `https://vibecoding-cat.onrender.com/health` (or your Render URL + `/health`)
2. Confirm the service is up (and later `durableStore: true` once Redis is wired in the app)
3. Suspend the free service between workshops so it does not stay awake

### 5. Later (after app code lands)
- Point the survey page `Submit to CAT` at this Render URL (`VITE_CAT_API_URL`)
- Wake the service a few minutes before the workshop

## Local development (after `cat/` exists)

```bash
cd cat
npm install
npm run dev
```

