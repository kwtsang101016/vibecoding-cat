# Vibe Coding Workshop CAT

Class Attending Table for the CUHK Vibe Coding Workshop 2026.

Deployed as a Render Web Service from repo root **Root Directory = `cat`**.

Redis keys (safe to share one Upstash DB with DDA1000 / STA2002):

- `vibecoding:classroom-state`
- `vibecoding:study-plans`

## Local

```bash
npm install
npm run dev
```

## Render env

- `INSTRUCTOR_PIN`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `NODE_VERSION=22`
