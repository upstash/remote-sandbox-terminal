import { execFileSync } from "node:child_process"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import * as pty from "@lydell/node-pty"
import { SerializeAddon } from "@xterm/addon-serialize"
import xterm from "@xterm/headless"
import { Listener, Reorder, Sender } from "./link.js"
import { ModeTracker } from "./modes.js"
import { loadDotEnv } from "./config.js"
import { configFromEnv, connect, newId, up, type Up } from "./protocol.js"
import { installTransport } from "./transport.js"

loadDotEnv()
installTransport()

const COMMAND = process.env.OC_CMD || "opencode"
const ARGS: string[] = process.env.OC_ARGS ? JSON.parse(process.env.OC_ARGS) : []
const CWD = process.env.OC_CWD || process.cwd()
const FRAME_MS = Number(process.env.OC_FRAME_MS || 33)

const USES_SNAPSHOT = process.env.OC_SNAPSHOT !== "0"
const USES_REPAINT = process.env.OC_REPAINT !== "0"
const REPAINT_HOLD_MS = 250

const OPEN_MARKER = join(dirname(process.argv[1] ?? "."), ".session-open")
const RESUMES = process.env.OC_RESUME !== "0" && basename(COMMAND) === "opencode"

function hasSession(): boolean {
  try {
    const out = execFileSync(COMMAND, ["session", "list", "--format", "json", "-n", "1"], {
      cwd: CWD,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const sessions: unknown = JSON.parse(out.trim() || "[]")
    return Array.isArray(sessions) && sessions.length > 0
  } catch {
    return false
  }
}

const HEARTBEAT_MS = 15_000
const CLIENT_TIMEOUT_MS = 75_000
const STREAM_TTL_SECS = 3600
const TERMINAL_ENV = ["COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"]

const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`)

const link = connect(configFromEnv())
const boot = newId()
const tracker = new ModeTracker()

const mirror = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true })
const serializer = new SerializeAddon()
mirror.loadAddon(serializer)

const inOrder = (data: string, step: () => void) => mirror.write(data, step)

const ALT_MARKER = "\x1b[?1049h\x1b[H"

function snapshot(): string {
  if (!USES_SNAPSHOT) return ""

  const all = serializer.serialize({ scrollback: 0, excludeModes: true })
  if (!tracker.alt) return all

  const at = all.indexOf(ALT_MARKER)
  return at === -1 ? "" : all.slice(at + ALT_MARKER.length)
}

type Client = {
  id: string
  isAttached: boolean
  cols: number
  rows: number
  lastSeenAt: number
  reorder: Reorder<Up>
}

const clients = new Map<string, Client>()
const closed = new Set<string>()
let proc: pty.IPty | null = null
let size = { cols: 0, rows: 0 }

const sender = new Sender({
  lane: boot,
  dataType: "o",
  emit: (message) => link.down.emit("term.down", message as never),
  concurrency: 2,
  spacingMs: FRAME_MS,
  leadMs: 2,
  onError: (error) => log(`Sending failed: ${error instanceof Error ? error.message : String(error)}`),
})

let sentChars = 0
let reportedAt = { messages: 0, chars: 0 }

function reportUsage() {
  const messages = sender.sent - reportedAt.messages
  if (messages === 0) return
  log(`Sent ${messages} messages (${Math.round((sentChars - reportedAt.chars) / 1024)} KB of output) since the last report.`)
  reportedAt = { messages: sender.sent, chars: sentChars }
}

const attachedCount = () => [...clients.values()].filter((client) => client.isAttached).length

function drop(client: Client) {
  client.reorder.stop()
  clients.delete(client.id)
  closed.add(client.id)
  if (closed.size > 1000) closed.delete(closed.values().next().value!)
}

function start(cols: number, rows: number, env: Record<string, string>) {
  tracker.reset()
  mirror.reset()
  mirror.resize(cols, rows)
  size = { cols, rows }

  const args = [...ARGS]
  if (RESUMES) {
    const picksSession = args.some((arg) => ["-c", "--continue", "-s", "--session"].includes(arg))
    if (existsSync(OPEN_MARKER) && !picksSession && hasSession()) args.push("--continue")
    writeFileSync(OPEN_MARKER, new Date().toISOString())
  }

  const child = pty.spawn(COMMAND, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: CWD,
    env: { ...process.env, COLORTERM: "truecolor", ...env, TERM: "xterm-256color" } as Record<string, string>,
  })
  proc = child
  log(`Started ${[COMMAND, ...args].join(" ")} (pid ${child.pid}) at ${cols}x${rows}.`)

  child.onData((data) => {
    inOrder(data, () => {
      tracker.feed(data)
      if (attachedCount() > 0) {
        sentChars += data.length
        sender.data(data)
      }
    })
  })

  child.onExit(({ exitCode }) => {
    if (proc !== child) return
    log(`${COMMAND} exited with code ${exitCode}.`)
    reportUsage()
    if (RESUMES) rmSync(OPEN_MARKER, { force: true })
    proc = null
    tracker.reset()
    sender.send({ t: "exit", code: exitCode })
    for (const client of [...clients.values()]) drop(client)
  })
}

function resize(cols: number, rows: number): boolean {
  if (!proc || (size.cols === cols && size.rows === rows)) return false
  size = { cols, rows }
  mirror.resize(cols, rows)
  proc.resize(cols, rows)
  return true
}

function repaint() {
  if (!proc || !USES_REPAINT) return

  const child = proc
  const { cols, rows } = size
  child.resize(cols, Math.max(1, rows - 1))
  setTimeout(() => {
    if (proc === child && size.cols === cols && size.rows === rows) child.resize(cols, rows)
  }, REPAINT_HOLD_MS)
}

function attach(client: Client, message: Extract<Up, { t: "attach" }>) {
  client.cols = message.cols
  client.rows = message.rows

  if (!proc) {
    const env: Record<string, string> = {}
    for (const name of TERMINAL_ENV) {
      const value = message.env?.[name]
      if (value) env[name] = value
    }
    start(message.cols, message.rows, env)
    client.isAttached = true
    sender.send({ t: "sync", c: client.id, pre: "", fresh: true })
    log(`Client ${client.id} attached at ${message.cols}x${message.rows}.`)
    return
  }

  inOrder("", () => {
    if (!clients.has(client.id)) return
    client.isAttached = true

    const isResized = resize(message.cols, message.rows)
    sender.send({ t: "sync", c: client.id, pre: tracker.preamble(snapshot()), fresh: false })
    if (!isResized) repaint()

    log(`Client ${client.id} attached at ${message.cols}x${message.rows} to the running session.`)
  })
}

function handle(client: Client, message: Up) {
  if (message.t === "attach") {
    attach(client, message)
    return
  }

  if (!client.isAttached) return

  if (message.t === "i") proc?.write(message.d)
  if (message.t === "resize") {
    client.cols = message.cols
    client.rows = message.rows
    inOrder("", () => void resize(message.cols, message.rows))
  }
  if (message.t === "detach") {
    log(`Client ${client.id} detached.`)
    drop(client)
    reportUsage()
  }
}

function receive(message: Up) {
  if (closed.has(message.l)) return

  let client = clients.get(message.l)

  if (!client) {
    const created: Client = {
      id: message.l,
      isAttached: false,
      cols: 0,
      rows: 0,
      lastSeenAt: performance.now(),
      reorder: new Reorder<Up>({
        start: 1,
        gapMs: () => (created.isAttached ? 4_000 : 1_500),
        deliver: (ordered) => handle(created, ordered),
        onGap: () => {
          if (created.isAttached) return true
          log(`Lane ${created.id} is unknown, asking it to attach again.`)
          sender.send({ t: "reattach", c: created.id })
          drop(created)
          return false
        },
      }),
    }
    client = created
    clients.set(created.id, created)
  }

  client.lastSeenAt = performance.now()
  client.reorder.push(message)
}

const listener = new Listener<Up>({
  channel: link.up,
  event: "term.up",
  parse: (data) => {
    const result = up.safeParse(data)
    return result.success ? result.data : null
  },
  onMessage: receive,
  log,
})

async function keepStreams() {
  try {
    await Promise.all([
      link.redis.expire(link.names.down, STREAM_TTL_SECS),
      link.redis.expire(link.names.up, STREAM_TTL_SECS),
    ])
  } catch {}
}

async function shutdown(signal: string) {
  log(`Received ${signal}, shutting down.`)
  listener.stop()
  if (proc) {
    const child = proc
    proc = null
    child.kill()
    sender.send({ t: "exit", code: 0 })
  }
  await sender.drain(3_000)
  process.exit(0)
}

process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))

await link.redis.ping()
await listener.start()
sender.send({ t: "hb" })
void keepStreams()
log(`Host ${boot} is listening on ${link.names.up}. Command: ${COMMAND} ${ARGS.join(" ")} in ${CWD}.`)

setInterval(() => {
  const now = performance.now()

  for (const client of [...clients.values()]) {
    if (now - client.lastSeenAt > CLIENT_TIMEOUT_MS) {
      log(`Client ${client.id} went quiet.`)
      drop(client)
    }
  }

  if (attachedCount() > 0 && now - sender.lastSentAt > HEARTBEAT_MS) sender.send({ t: "hb" })

  const quietFor = now - listener.lastAt
  if (quietFor > (clients.size > 0 ? 45_000 : 600_000)) void listener.restart()
}, 5_000)

setInterval(() => void keepStreams(), 300_000)
