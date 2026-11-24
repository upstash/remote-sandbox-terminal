import { readFileSync } from "node:fs"
import { openTerminal, sleep } from "./harness.mjs"

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
}

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

const lags = []
for (let round = 0; round < Number(process.env.ROUNDS || 5); round++) {
  await sleep(Number(process.env.PAUSE || 6) * 1000)
  const word = `w${round}hello`
  let lastSentAt = 0
  for (const char of word) {
    a.type(char)
    lastSentAt = performance.now()
    await sleep(65)
  }
  await a.waitFor((text) => text.includes(word), 8000, word)
  lags.push(Math.round(performance.now() - lastSentAt))
  a.type(" ")
  await sleep(400)
}
lags.sort((x, y) => x - y)
console.log(`word typed after ${process.env.PAUSE || 6} s quiet: screen caught up ${lags.join(", ")} ms after the last letter (median ${lags[Math.floor(lags.length / 2)]} ms)`)
a.type("\x15")
await sleep(300)
a.type("\x1d")
await a.waitExit()
process.exit(0)
