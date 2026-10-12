/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@advance-academy/contracts'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Browser → career-hub's FastAPI service (backend-python) on our own origin,
  // so its URL stays server-only and it needs no CORS entry for this app.
  // Runs after app/api/* routes (afterFiles), so it can't shadow them.
  async rewrites() {
    const api = process.env.BACKEND_PYTHON_URL?.trim().replace(/\/+$/, '')
    if (!api) console.warn('[next.config] BACKEND_PYTHON_URL is not set — /api/careerhub/* (Career Hub, coach crawler) will 404.')
    return api ? [{ source: '/api/careerhub/:path*', destination: `${api}/:path*` }] : []
  },
  experimental: {
    // Default is 30s; a sponsor recheck is a model call with a 30s timeout and
    // one retry, plus the register lookup, so it can outlast that.
    proxyTimeout: 120_000,
  },
}

export default nextConfig
