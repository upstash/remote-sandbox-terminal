import { readFileSync } from "node:fs"
import { Box } from "@upstash/box"
import { openTerminal, show, sleep } from "./harness.mjs"

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
}

const box = await Box.get(process.env.OC_BOX_ID)
const dir = "/workspace/home/.opencode-remote"

const a = openTerminal({}, { name: "A" })
await a.waitFor((text) => /Ask anything/.test(text), 40_000, "opencode UI")
await a.settle()
console.log("PASS  attached before the pause")
a.kill()
await sleep(1000)

let startedAt = performance.now()
await box.pause()
console.log(`paused the box in ${Math.round(performance.now() - startedAt)} ms, status: ${(await box.getStatus()).status}`)

startedAt = performance.now()
const b = openTerminal({}, { name: "B" })
const tookMs = await b.waitFor((text) => /Ask anything|ctrl\+p/.test(text), 90_000, "opencode UI after wake")
await b.settle()
show("B: after waking the box", await b.screen())
console.log(`PASS  a new client woke the box and got opencode back  (${Math.round(tookMs)} ms from launch to UI)`)

const log = String((await box.exec.command(`tail -n 6 ${dir}/host.log; echo; ls -la ${dir}/data/opencode 2>&1 | head -5`)).result)
console.log(log)
console.log(`${log.includes("--continue") ? "PASS" : "FAIL"}  the interrupted session was resumed with --continue`)

b.type("\x1d")
await b.waitExit()
process.exit(0)
