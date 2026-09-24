export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return env.API.fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
