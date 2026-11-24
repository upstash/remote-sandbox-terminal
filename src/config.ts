import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Config } from "./protocol.js"

export type ClientConfig = Config & { boxKey?: string; boxId?: string }

export const CONFIG_FILE = join(homedir(), ".config", "opencode-remote", "config.json")

const LINK_PREFIX = "oc1."

export function loadDotEnv(file = join(process.cwd(), ".env")) {
  if (!existsSync(file)) return

  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const [, name = "", raw = ""] = match
    if (process.env[name] !== undefined) continue
    process.env[name] = raw.replace(/^(['"])(.*)\1$/, "$2")
  }
}

export function encodeLink(config: ClientConfig): string {
  return LINK_PREFIX + Buffer.from(JSON.stringify(config)).toString("base64url")
}

export function decodeLink(link: string): ClientConfig {
  if (!link.startsWith(LINK_PREFIX)) throw new Error("That is not an opencode-remote link.")

  const config = JSON.parse(Buffer.from(link.slice(LINK_PREFIX.length), "base64url").toString("utf8"))
  if (typeof config?.url !== "string" || typeof config?.token !== "string") {
    throw new Error("The link is missing its Redis URL or token.")
  }

  return { session: "main", ...config }
}

export function saveClientConfig(config: ClientConfig) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 })
}

export function loadClientConfig(): ClientConfig | null {
  loadDotEnv()

  const env = process.env
  if (env.OC_LINK) return decodeLink(env.OC_LINK)

  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
      session: env.OC_SESSION || "main",
      ...(env.UPSTASH_BOX_API_KEY && env.OC_BOX_ID ? { boxKey: env.UPSTASH_BOX_API_KEY, boxId: env.OC_BOX_ID } : {}),
    }
  }

  if (existsSync(CONFIG_FILE)) return JSON.parse(readFileSync(CONFIG_FILE, "utf8"))

  return null
}
