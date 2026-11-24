import { Realtime } from "@upstash/realtime"
import { Redis } from "@upstash/redis"
import * as z from "zod/v4"

const lane = { l: z.string().max(32), s: z.number().int().positive() }
const size = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }
const envValue = z.string().regex(/^[\w.+:@/-]{1,64}$/)

export const down = z.discriminatedUnion("t", [
  z.object({ ...lane, t: z.literal("o"), d: z.string() }),
  z.object({ ...lane, t: z.literal("sync"), c: z.string(), pre: z.string(), fresh: z.boolean() }),
  z.object({ ...lane, t: z.literal("exit"), code: z.number().int() }),
  z.object({ ...lane, t: z.literal("hb") }),
  z.object({ ...lane, t: z.literal("reattach"), c: z.string() }),
])

export const up = z.discriminatedUnion("t", [
  z.object({ ...lane, t: z.literal("i"), d: z.string() }),
  z.object({
    ...lane,
    t: z.literal("attach"),
    ...size,
    env: z.record(z.string(), envValue).optional(),
  }),
  z.object({ ...lane, t: z.literal("resize"), ...size }),
  z.object({ ...lane, t: z.literal("detach") }),
  z.object({ ...lane, t: z.literal("beat") }),
])

export type Down = z.infer<typeof down>
export type Up = z.infer<typeof up>

export const schema = { term: { down, up } }

export type Config = { url: string; token: string; session: string }

const HISTORY = 512

export function connect(config: Config) {
  if (!/^[\w.-]{1,64}$/.test(config.session)) {
    throw new Error(`Session name ${JSON.stringify(config.session)} may only contain letters, digits, ".", "_" and "-".`)
  }

  const redis = new Redis({ url: config.url, token: config.token })
  const realtime = new Realtime({ schema, redis, history: { maxLength: HISTORY } })
  const names = { down: `oc:${config.session}:down`, up: `oc:${config.session}:up` }

  return {
    redis,
    names,
    down: realtime.channel(names.down),
    up: realtime.channel(names.up),
  }
}

export type Link = ReturnType<typeof connect>

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.UPSTASH_REDIS_REST_URL
  const token = env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set.")

  return { url, token, session: env.OC_SESSION || "main" }
}

export const newId = () => Math.random().toString(36).slice(2, 10)
