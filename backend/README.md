# Backend

Fastify + TypeScript API (port 4000). Rules and gotchas: [`CLAUDE.md`](./CLAUDE.md)
and [`src/services/CLAUDE.md`](./src/services/CLAUDE.md).

```bash
cp backend/.env.example backend/.env   # LLM_API_KEY, FRONTEND_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm run dev:backend                    # from the repo root; check http://localhost:4000/api/health
npm run test --workspace backend       # node:test, src/**/*.test.ts
npm run typecheck --workspace backend
```
