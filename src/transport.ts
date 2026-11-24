import { Agent, fetch as undiciFetch } from "undici"

export function installTransport() {
  if (process.env.OC_HTTP1 === "1") return

  const agent = new Agent({
    allowH2: true,
    keepAliveTimeout: 10 * 60_000,
    keepAliveMaxTimeout: 10 * 60_000,
  })

  const viaAgent = (input: unknown, init?: Record<string, unknown>) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], { ...init, dispatcher: agent })

  globalThis.fetch = viaAgent as unknown as typeof fetch
}
