#!/usr/bin/env node
import { StringDecoder } from "node:string_decoder"
import { CONFIG_FILE, decodeLink, encodeLink, loadClientConfig, saveClientConfig, type ClientConfig } from "./config.js"
import { Listener, Reorder, Sender } from "./link.js"
import { ModeTracker } from "./modes.js"
import { connect, down, newId, type Down } from "./protocol.js"
import { installTransport } from "./transport.js"
import { keepAwake, startHost, wake } from "./wake.js"

const ATTACH_RETRY_MS = 3_000
const BEAT_MS = 20_000
const QUIET_RESTART_MS = 40_000
const QUIET_REATTACH_MS = 90_000

const DETACH = /^(?:\x1d|\x1b\[93(?::\d*)*;(?:5|69|133|197)(?::[12])?(?:;[\d:]*)?u|\x1b\[27;5;93~)$/

const HOVER_ONLY = /^(?:\x1b\[<(?:35|39|43|47|51|55|59|63);\d+;\d+M)+$/
const HOVER_MS = 50

function usage(): never {
  console.log(`opencode-remote

  oc                 open the remote opencode in this terminal
  oc link            print a link that carries this machine's config
  oc link <link>     save a config from a link made on another machine

Ctrl+] detaches and leaves opencode running. Quitting opencode ends it.
Config: ${CONFIG_FILE}, or UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.`)
  process.exit(0)
}

const [command, argument] = process.argv.slice(2)

if (command === "help" || command === "--help" || command === "-h") usage()

if (command === "link") {
  if (argument) {
    saveClientConfig(decodeLink(argument))
    console.log(`Saved to ${CONFIG_FILE}. Run oc to connect.`)
  } else {
    const config = loadClientConfig()
    if (!config) throw new Error("There is no config on this machine to make a link from.")
    console.log(encodeLink(config))
  }
  process.exit(0)
}

const loaded = loadClientConfig()

if (!loaded) {
  console.error("No config found. Run `oc link <link>` with a link from the machine that set this up.")
  process.exit(1)
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("oc needs a terminal on both stdin and stdout.")
  process.exit(1)
}

installTransport()

const config: ClientConfig = loaded
const link = connect(config)
const tracker = new ModeTracker()
const out = (text: string) => process.stdout.write(text)

let lane = ""
let hostLane = ""
let isSynced = false
let isQuitting = false
let hasNotice = false
let reorder: Reorder<Down> | null = null
let early: Down[] = []
let attachTimer: ReturnType<typeof setTimeout> | null = null
let attempts = 0
let lastRestartAt = 0

const sender = new Sender({
  lane: "",
  dataType: "i",
  emit: (message) => link.up.emit("term.up", message as never),
  concurrency: 4,
  spacingMs: 0,
  leadMs: 0,
  onError: () => {
  },
})

let pendingHover = ""
let hoverTimer: ReturnType<typeof setTimeout> | null = null

function flushHover() {
  if (!pendingHover) return
  sender.data(pendingHover)
  pendingHover = ""
}

function sendInput(text: string) {
  if (!HOVER_ONLY.test(text)) {
    flushHover()
    sender.data(text)
    return
  }

  pendingHover = text.slice(text.lastIndexOf("\x1b[<"))
  if (hoverTimer) return

  flushHover()
  hoverTimer = setTimeout(() => {
    hoverTimer = null
    flushHover()
  }, HOVER_MS)
}

function notice(text: string) {
  if (isSynced || !tracker.isEmpty) return
  out(`\r\x1b[2K\x1b[2m${text}\x1b[0m`)
  hasNotice = true
}

function clearNotice() {
  if (!hasNotice) return
  out("\r\x1b[2K")
  hasNotice = false
}

function terminalEnv() {
  const env: Record<string, string> = {}
  for (const name of ["COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]) {
    const value = process.env[name]
    if (value && /^[\w.+:@/-]{1,64}$/.test(value)) env[name] = value
  }
  return env
}

function attach() {
  if (isQuitting) return
  if (attachTimer) clearTimeout(attachTimer)

  reorder?.stop()
  reorder = null
  isSynced = false
  early = []
  lane = newId()
  attempts++

  sender.reset(lane)
  sender.send({
    t: "attach",
    cols: process.stdout.columns,
    rows: process.stdout.rows,
    env: terminalEnv(),
  })

  if (attempts === 4) notice(`No answer yet on session "${config.session}". Still trying. Ctrl+C to stop.`)
  if (attempts === 3 && config.boxKey && config.boxId) void startHost(config.boxKey, config.boxId).catch(() => {})
  if (attempts % 3 === 0) void listener.restart()

  attachTimer = setTimeout(attach, ATTACH_RETRY_MS)
}

function begin(sync: Extract<Down, { t: "sync" }>) {
  if (attachTimer) clearTimeout(attachTimer)
  attachTimer = null
  attempts = 0
  hostLane = sync.l
  isSynced = true

  clearNotice()
  if (!tracker.isEmpty) {
    out(tracker.cleanup())
    tracker.reset()
  }
  out(sync.pre)
  tracker.feed(sync.pre)

  const ordered = new Reorder<Down>({
    start: sync.s + 1,
    gapMs: 4_000,
    deliver,
    onGap: () => {
      attach()
      return false
    },
  })
  reorder = ordered

  const held = early
  early = []
  for (const message of held) if (message.l === hostLane) ordered.push(message)
}

function deliver(message: Down) {
  if (message.t === "o") {
    tracker.feed(message.d)
    out(message.d)
  }
  if (message.t === "exit") void quit(message.code, { isHostGone: true })
  if (message.t === "reattach" && message.c === lane) attach()
}

function receive(message: Down) {
  if (isQuitting) return

  if (!isSynced) {
    if (message.t === "sync" && message.c === lane) begin(message)
    else if (early.length < 4096) early.push(message)
    return
  }

  if (message.l !== hostLane) {
    attach()
    return
  }

  reorder?.push(message)
}

const listener = new Listener<Down>({
  channel: link.down,
  event: "term.down",
  parse: (data) => {
    const result = down.safeParse(data)
    return result.success ? result.data : null
  },
  onMessage: receive,
  onLost: () => {
    if (isSynced) attach()
  },
})

function restore() {
  out(tracker.cleanup())
  tracker.reset()
  out("\x1b[23;0t")
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
}

async function quit(code: number, opts: { note?: string; isHostGone?: boolean } = {}) {
  if (isQuitting) return
  isQuitting = true
  if (attachTimer) clearTimeout(attachTimer)

  if (isSynced && !opts.isHostGone) {
    sender.send({ t: "detach" })
    await sender.drain(1_500)
  }

  listener.stop()
  clearNotice()
  restore()
  if (opts.note) process.stderr.write(`${opts.note}\n`)
  process.exit(code)
}

process.on("SIGTERM", () => void quit(143))
process.on("SIGHUP", () => void quit(129))
const crash = (error: unknown) => {
  restore()
  console.error(error)
  process.exit(1)
}
process.on("uncaughtException", crash)
process.on("unhandledRejection", crash)

try {
  await link.redis.ping()
} catch (error) {
  console.error(`Could not reach Redis at ${config.url}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

out("\x1b[22;0t")
notice("Connecting to opencode…")

process.stdin.setRawMode(true)
process.stdin.resume()

const decoder = new StringDecoder("utf8")

process.stdin.on("data", (chunk: Buffer) => {
  const text = decoder.write(chunk)

  if (DETACH.test(text)) {
    void quit(0, { note: "Detached. opencode is still running; run oc to come back." })
    return
  }

  if (!isSynced) {
    if (text.includes("\x03") || text.includes("\x04")) void quit(130)
    return
  }

  sendInput(text)
})

process.stdout.on("resize", () => {
  if (isSynced) sender.send({ t: "resize", cols: process.stdout.columns, rows: process.stdout.rows }, true)
})

if (config.boxKey && config.boxId) {
  void wake(config.boxKey, config.boxId, notice).catch((error) => {
    notice(`Could not wake the box: ${error instanceof Error ? error.message : String(error)}`)
  })
  keepAwake(config.boxKey, config.boxId, () => isSynced)
}

await listener.start()
attach()

setInterval(() => {
  if (isSynced) sender.send({ t: "beat" }, true)
}, BEAT_MS)

setInterval(() => {
  if (!isSynced || isQuitting) return

  const now = performance.now()
  const quietFor = now - listener.lastAt

  if (quietFor > QUIET_REATTACH_MS) {
    attach()
  } else if (quietFor > QUIET_RESTART_MS && now - lastRestartAt > 20_000) {
    lastRestartAt = now
    void listener.restart()
  }
}, 5_000)
