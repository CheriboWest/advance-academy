# Backend

Fastify + TypeScript API (port 4000). The full guide — layout, services, LLM
integration, error handling, adding a feature — is [`docs/BACKEND.md`](../docs/BACKEND.md);
endpoints are in [`docs/API_REFERENCE.md`](../docs/API_REFERENCE.md).

```bash
cp backend/.env.example backend/.env   # LLM_API_KEY, FRONTEND_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm run dev:backend                    # from the repo root; check http://localhost:4000/api/health
npm run test --workspace backend       # node:test, src/**/*.test.ts
npm run typecheck --workspace backend
```
