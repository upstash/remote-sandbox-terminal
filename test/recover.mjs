import { mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openTerminal, sleep, startHost } from "./harness.mjs"

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
}

const project = join(tmpdir(), "opencode-remote-e2e")
mkdirSync(project, { recursive: true })
const env = {
  OC_SESSION: `rec-${Math.random().toString(36).slice(2, 8)}`,
  OC_CWD: project,
  OC_RESUME: "0",
  UPSTASH_BOX_API_KEY: "",
  OC_BOX_ID: "",
}
let failed = 0
const check = (name, isOk, detail = "") => {
  if (!isOk) failed++
  console.log(`${isOk ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
}

const a = openTerminal(env, { name: "A" })
await sleep(5000)
check("a client with no host waits and says so", /Connecting|No answer yet/.test((await a.screen()).join("\n")) && a.state.exit === null)

let host = startHost(env)
let took = await a.waitFor((text) => /Ask anything/.test(text), 30_000, "UI once the host is up")
check("it attaches as soon as a host appears", true, `${Math.round(took)} ms after the host started`)
await a.settle()

a.type("before the crash")
await a.waitFor((text) => text.includes("before the crash"), 10_000, "typed text")

host.child.kill("SIGKILL")
await sleep(1500)
host = startHost(env)
const startedAt = performance.now()
await a.waitFor((text) => /Ask anything/.test(text) && !text.includes("before the crash"), 30_000, "a fresh UI from the new host")
check("a replaced host is picked up without restarting the client", true, `${Math.round(performance.now() - startedAt)} ms`)
await a.settle()

a.type("after the crash")
await a.waitFor((text) => text.includes("after the crash"), 10_000, "typing on the new host")
check("typing works on the new host", true)
const modes = await a.modes()
check("still on the alternate screen with the mouse on", modes.buffer === "alternate" && modes.mouseTrackingMode !== "none")

a.type("\x1d")
check("detach still restores the terminal", (await a.waitExit()) === 0 && (await a.modes()).buffer === "normal")
await host.stop()
process.exit(failed ? 1 : 0)
