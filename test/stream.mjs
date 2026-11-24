import { readFileSync } from "node:fs"
import { Box } from "@upstash/box"
import { openTerminal, sleep } from "./harness.mjs"

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
}
const box = await Box.get(process.env.OC_BOX_ID)
const a = openTerminal({}, { name: "A" })
await a.waitFor((text) => /17 times 3|Ask anything/.test(text), 40_000, "opencode UI")
await a.settle()
a.type("\x1d")
await a.waitExit()
await sleep(1200)

const b = openTerminal({}, { name: "B" })
await b.waitFor((text) => /17 times 3|Ask anything/.test(text), 40_000, "opencode UI")
await b.settle()
b.type("Write the numbers from 1 to 120 as words, one per line, nothing else.")
await sleep(500)
b.type("\r")
const startedAt = performance.now()
await b.waitFor((text) => /one hundred (and )?twenty/i.test(text), 180_000, "the end of the answer")
await b.settle(3000, 30_000)
const seconds = (performance.now() - startedAt) / 1000
b.type("\x1d")
await b.waitExit()
await sleep(1500)
const log = String((await box.exec.command("tail -n 2 /workspace/home/.opencode-remote/host.log")).result)
console.log(log.trim())
const messages = Number(/Sent (\d+) messages/.exec(log)?.[1] ?? 0)
console.log(`answer took ${seconds.toFixed(1)} s on screen; ${messages} messages, ${(messages / seconds).toFixed(1)} per second, about ${Math.round((messages / seconds) * 3 * 3600 / 1000)}k Redis commands per hour at that pace`)
process.exit(0)
