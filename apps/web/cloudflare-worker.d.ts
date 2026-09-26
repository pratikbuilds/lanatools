// Minimal platform types so the Worker entry typechecks with the DOM lib.
// Binding names come from the generated worker-configuration.d.ts.
interface Fetcher {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

interface ExportedHandler<TEnv = unknown> {
  fetch: (request: Request, env: TEnv) => Response | Promise<Response>
}
