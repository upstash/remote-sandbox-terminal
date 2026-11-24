import { readFileSync } from "node:fs"
import { openTerminal, sleep } from "./harness.mjs"

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
}

const pauses = (process.env.PAUSES || "0.15,0.15,2,5,5,8,15,30").split(",").map(Number)
const a = openTerminal({}, { name: "A" })
await a.waitFor((text) => /Ask anything|ctrl\+p/.test(text), 40_000, "opencode UI")
await a.settle()
await sleep(3000)
if (/Update Available/.test((await a.screen()).join("\n"))) {
  a.type("\x1b")
  await sleep(800)
}
a.type("\x15")
await sleep(500)

const key = async (char) => {
  const before = a.state.bytes
  const sentAt = performance.now()
  a.type(char)
  while (a.state.bytes === before && performance.now() - sentAt < 3000) await sleep(1)
  return Math.round(performance.now() - sentAt)
}

for (const char of "warm") {
  if ((await key(char)) >= 3000) {
    console.log("Keys are not echoing. The prompt does not have the keyboard.")
    console.log((await a.screen()).join("\n"))
    process.exit(1)
  }
  await sleep(150)
}

const rows = []
for (const pause of pauses) {
  await sleep(pause * 1000)
  const first = await key("x")
  const next = []
  for (const char of "yz") {
    await sleep(70)
    next.push(await key(char))
  }
  rows.push({ pause, first, next })
  console.log(`after ${String(pause).padStart(5)} s quiet: first key ${String(first).padStart(4)} ms, the two after it ${next.join(" / ")} ms`)
}

a.type("\x15")
await sleep(300)
a.type("\x1d")
await a.waitExit()
process.exit(0)
