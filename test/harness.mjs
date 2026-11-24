import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as pty from "@lydell/node-pty"
import xterm from "@xterm/headless"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = process.env.OC_DIST || "dist"

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function startHost(env) {
  const child = spawn("node", [join(root, dist, "host.mjs")], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const lines = []
  const onChunk = (chunk) => {
    for (const line of String(chunk).split("\n")) if (line.trim()) lines.push(line)
  }
  child.stdout.on("data", onChunk)
  child.stderr.on("data", onChunk)

  return {
    child,
    lines,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      child.once("exit", resolve)
      child.kill("SIGTERM")
    }),
  }
}

export function openTerminal(env, { cols = 110, rows = 34, name = "client" } = {}) {
  const term = new xterm.Terminal({ cols, rows, allowProposedApi: true, scrollback: 200 })
  const child = pty.spawn("node", [join(root, dist, "oc.mjs")], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: root,
    env: { ...process.env, ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  })

  const state = { exit: null, bytes: 0, raw: "", lastOutputAt: 0 }

  child.onData((data) => {
    state.bytes += data.length
    state.raw += data
    state.lastOutputAt = performance.now()
    term.write(data)
  })
  term.onData((data) => child.write(data))
  child.onExit(({ exitCode }) => {
    state.exit = exitCode
  })

  const flush = () => new Promise((resolve) => term.write("", resolve))

  const screen = async () => {
    await flush()
    const buffer = term.buffer.active
    const lines = []
    for (let y = 0; y < term.rows; y++) {
      lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? "")
    }
    return lines
  }

  const cells = async () => {
    await flush()
    const buffer = term.buffer.active
    const rows = []
    for (let y = 0; y < term.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y)
      let row = ""
      for (let x = 0; x < term.cols; x++) {
        const cell = line?.getCell(x)
        if (!cell) continue
        const chars = cell.getChars() || " "
        row += `${chars}|${cell.getFgColorMode()}:${cell.getFgColor()}|${cell.getBgColorMode()}:${cell.getBgColor()}|${cell.isBold()}${cell.isDim()}${cell.isItalic()}${cell.isUnderline()}${cell.isInverse()};`
      }
      rows.push(row)
    }
    return rows
  }

  const waitFor = async (test, timeoutMs = 20_000, label = "condition") => {
    const startedAt = performance.now()
    while (performance.now() - startedAt < timeoutMs) {
      const lines = await screen()
      if (test(lines.join("\n"), lines)) return performance.now() - startedAt
      await sleep(15)
    }
    throw new Error(`${name}: timed out waiting for ${label}.\n${(await screen()).join("\n")}`)
  }

  const settle = async (quietMs = 700, timeoutMs = 20_000) => {
    const startedAt = performance.now()
    while (performance.now() - startedAt < timeoutMs) {
      if (state.lastOutputAt && performance.now() - state.lastOutputAt > quietMs) return
      await sleep(50)
    }
  }

  return {
    name,
    term,
    child,
    state,
    screen,
    cells,
    waitFor,
    settle,
    type: (text) => child.write(text),
    resize: (c, r) => {
      term.resize(c, r)
      child.resize(c, r)
    },
    modes: async () => {
      await flush()
      return { ...term.modes, buffer: term.buffer.active.type }
    },
    waitExit: async (timeoutMs = 10_000) => {
      const startedAt = performance.now()
      while (state.exit === null && performance.now() - startedAt < timeoutMs) await sleep(20)
      return state.exit
    },
    kill: () => {
      try {
        child.kill()
      } catch {}
    },
  }
}

export const show = (title, lines) => {
  if (process.env.E2E_QUIET) return
  console.log(`\n┌── ${title} ${"─".repeat(Math.max(0, 100 - title.length))}`)
  for (const line of lines) console.log(`│${line}`)
  console.log(`└${"─".repeat(104)}`)
}
