import { readFileSync } from "node:fs"
import { Box } from "@upstash/box"
import { openTerminal, show, sleep } from "./harness.mjs"

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
}

const box = await Box.get(process.env.OC_BOX_ID)
const dir = "/workspace/home/.opencode-remote"
const hostLog = async (lines) => String((await box.exec.command(`tail -n ${lines} ${dir}/host.log`)).result)

const a = openTerminal({}, { name: "A" })
await a.waitFor((text) => /Ask anything/.test(text), 40_000, "opencode UI")
await a.settle()
show("A: fresh start", await a.screen())
console.log(`${/server error/i.test((await a.screen()).join("\n")) ? "FAIL" : "PASS"}  no error toast on a start with nothing to resume`)

a.type("What is 17 times 3? Reply with just the number.")
await sleep(600)
a.type("\r")
const startedAt = performance.now()
await a.waitFor((text) => /\b51\b/.test(text), 90_000, "the model's answer")
console.log(`PASS  a prompt ran in the box and the answer streamed back  (${Math.round(performance.now() - startedAt)} ms)`)
await a.settle(2500, 30_000)
show("A: after the answer", await a.screen())

a.type("\x1d")
await a.waitExit()
await sleep(1500)
console.log(await hostLog(4))

await box.pause()
console.log(`paused, status: ${(await box.getStatus()).status}`)

const b = openTerminal({}, { name: "B" })
const tookMs = await b.waitFor((text) => /\b51\b/.test(text) && /17 times 3/.test(text), 90_000, "the conversation after wake")
await b.settle()
show("B: woke the box", await b.screen())
console.log(`PASS  waking the box brought the conversation back  (${Math.round(tookMs)} ms from launch)`)
console.log(`${/server error/i.test((await b.screen()).join("\n")) ? "FAIL" : "PASS"}  no error toast after resume`)
console.log(await hostLog(3))

b.type("\x1d")
await b.waitExit()
process.exit(0)
