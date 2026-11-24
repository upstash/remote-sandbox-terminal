import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openTerminal, show, sleep, startHost } from "./harness.mjs"

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
}

const session = `e2e-${Math.random().toString(36).slice(2, 8)}`
const project = process.env.E2E_PROJECT || join(tmpdir(), "opencode-remote-e2e")
mkdirSync(project, { recursive: true })

const isRemote = Boolean(process.env.E2E_REMOTE)
const env = isRemote
  ? { OC_CMD: "opencode" }
  : { OC_SESSION: session, OC_CWD: project, OC_CMD: process.env.OC_CMD || "opencode", OC_RESUME: "0" }
const results = []
const check = (name, isOk, detail = "") => {
  results.push({ name, isOk })
  console.log(`${isOk ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
}

const host = isRemote ? { lines: [], stop: async () => {} } : startHost(env)
if (!isRemote) await sleep(1500)

const a = openTerminal(env, { name: "A" })
let failure = null

try {
  const upIn = await a.waitFor((text) => /Ask anything|ctrl\+p|tab agents/i.test(text), 30_000, "opencode UI")
  await a.settle()
  show("A: after start", await a.screen())
  check("opencode UI renders through Realtime", true, `${Math.round(upIn)} ms after launch`)

  await sleep(3000)
  if (/Update Available/.test((await a.screen()).join("\n"))) {
    a.type("\x1b")
    await sleep(800)
    await a.settle()
  }

  const startModes = await a.modes()
  check("alternate screen is active", startModes.buffer === "alternate")

  const replies = [
    "\x1b]10;rgb:d0d0/d0d0/d0d0\x07",
    "\x1b]11;rgb:1a1a/1b1b/2626\x07",
    "\x1bP>|ghostty 1.2.0\x1b\\",
    "\x1b[12;40R",
    "\x1bP1+r4d73=5c455b25703125733b25703225735c303037\x1b\\",
    "\x1b[?1016;2$y\x1b[?2027;2$y\x1b[?2031;2$y\x1b[?1004;2$y\x1b[?2004;2$y\x1b[?2026;2$y",
    "\x1b[?0u",
    "\x1b[4;680;1100t",
    "\x1b]4;0;rgb:1d1d/1f1f/2121\x07",
    "\x1b[?62;22;52c",
  ]
  for (const reply of replies) {
    a.type(reply)
    await sleep(60)
  }
  await sleep(1200)
  await a.settle()
  const afterReplies = (await a.screen()).join("\n")
  check("late terminal answers do not end up in the prompt", /Ask anything/.test(afterReplies) && !/rgb:|ghostty|\[\?|;2\$y/.test(afterReplies))
  if (!/Ask anything/.test(afterReplies)) show("A: after late answers", await a.screen())

  const marker = "remote typing works"
  const latencies = []
  for (const char of marker) {
    const before = a.state.bytes
    const sentAt = performance.now()
    a.type(char)
    while (a.state.bytes === before && performance.now() - sentAt < 5000) await sleep(2)
    latencies.push(performance.now() - sentAt)
    await sleep(120)
  }
  await a.waitFor((text) => text.includes(marker), 10_000, "typed text")
  latencies.sort((x, y) => x - y)
  const median = latencies[Math.floor(latencies.length / 2)]
  check("typed text appears in the prompt", true, `key to echo: median ${Math.round(median)} ms, worst ${Math.round(latencies.at(-1))} ms`)

  const burst = " 0123456789abcdefghijklmnopqrstuvwxyz"
  for (const char of burst) {
    a.type(char)
    await sleep(8)
  }
  await a.waitFor((text) => text.includes(marker + burst), 10_000, "burst in order")
  check("fast typing arrives in order", true)

  const b = openTerminal(env, { name: "B" })
  await b.waitFor((text) => text.includes(marker), 20_000, "late attach repaint")
  await Promise.all([a.settle(), b.settle()])
  const [screenA, screenB] = [await a.screen(), await b.screen()]
  show("B: attached late", screenB)
  const differing = screenA.filter((line, index) => line !== screenB[index]).length
  check("late attach shows the same text", differing === 0, `${differing} differing lines`)
  if (differing) show("A at that moment", screenA)
  const [cellsA, cellsB] = [await a.cells(), await b.cells()]
  const offRows = cellsA.map((row, index) => (row === cellsB[index] ? -1 : index)).filter((index) => index >= 0)
  check("late attach shows the same colors and styles", offRows.length === 0, offRows.length ? `rows ${offRows.join(",")}` : "every cell")
  if (offRows.length && !process.env.E2E_QUIET) {
    const y = offRows[0]
    const [ra, rb] = [cellsA[y].split(";"), cellsB[y].split(";")]
    const x = ra.findIndex((cell, index) => cell !== rb[index])
    console.log(`first difference at row ${y} col ${x}: A=${JSON.stringify(ra[x])} B=${JSON.stringify(rb[x])}`)
  }
  const lateModes = await b.modes()
  check("late attach is on the alternate screen", lateModes.buffer === "alternate")
  check(
    "late attach has the same mouse mode",
    lateModes.mouseTrackingMode === (await a.modes()).mouseTrackingMode,
    `${lateModes.mouseTrackingMode}`
  )

  a.resize(90, 28)
  b.resize(90, 28)
  await sleep(1500)
  await a.settle()
  const resized = await a.screen()
  show("A: resized to 90x28", resized)
  check("resize keeps the typed text on screen", resized.join("\n").includes("remote typing works"))

  b.type("\x1d")
  const codeB = await b.waitExit()
  const afterB = await b.modes()
  check("Ctrl+] exits the client", codeB === 0, `exit code ${codeB}`)
  check("detach leaves the alternate screen", afterB.buffer === "normal")
  check("detach turns mouse reporting off", afterB.mouseTrackingMode === "none", afterB.mouseTrackingMode)
  check("detach message is shown", (await b.screen()).join("\n").includes("Detached"))

  a.type("\x1d")
  await a.waitExit()
  await sleep(500)
  if (!isRemote) check("opencode survives with nobody attached", !host.lines.some((line) => line.includes("exited with code")))

  const c = openTerminal(env, { name: "C", cols: 100, rows: 30 })
  await c.waitFor((text) => text.includes("remote typing works"), 20_000, "reattach")
  await c.settle()
  show("C: reattached at 100x30", await c.screen())
  check("reattach restores the session", true)

  if (env.OC_CMD === "opencode") {
    c.type("\x15")
    await sleep(300)
    c.type("/exit")
    await sleep(500)
    c.type("\r")
  } else {
    c.type("\x15exit\r")
  }
  const codeC = await c.waitExit(15_000)
  const afterC = await c.modes()
  check("quitting the program ends the client", codeC !== null, `exit code ${codeC}`)
  check("terminal is back on the normal screen", afterC.buffer === "normal")
  if (!isRemote) check("host saw the exit", host.lines.some((line) => line.includes("exited with code")))
} catch (error) {
  failure = error
  console.error(`\nFAILED: ${error.message}`)
} finally {
  a.kill()
  await host.stop()
  console.log("\n── host log ──")
  for (const line of host.lines) console.log(line)
}

const failed = results.filter((result) => !result.isOk).length
console.log(`\n${results.length - failed}/${results.length} checks passed${failure ? ", and the run stopped early" : ""}.`)
process.exit(failed || failure ? 1 : 0)
