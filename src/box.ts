import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { Box } from "@upstash/box"
import { CONFIG_FILE, encodeLink, loadDotEnv, saveClientConfig, type ClientConfig } from "./config.js"
import { configFromEnv } from "./protocol.js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
loadDotEnv(join(root, ".env"))

const NAME = process.env.OC_BOX_NAME || "opencode-remote"
const DIR = "/workspace/home/.opencode-remote"
const WORKDIR = process.env.OC_BOX_WORKDIR || "/workspace/home"
const PTY_VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@lydell/node-pty"]

const RUN_SH = `#!/bin/sh
cd ${DIR} || exit 1
if pgrep -f '[n]ode host.mjs' > /dev/null; then
  echo "host already running"
  exit 0
fi
setsid nohup node host.mjs >> host.log 2>&1 < /dev/null &
echo "host started"
`

const apiKey = process.env.UPSTASH_BOX_API_KEY
if (!apiKey) throw new Error("UPSTASH_BOX_API_KEY is not set. Add it to .env.")

async function find() {
  const boxes = await Box.list({ apiKey })
  const match = boxes.find((box) => box.name === NAME)
  return match ? Box.get(match.id, { apiKey }) : null
}

async function awake(box: Box) {
  const { status } = await box.getStatus()
  if (status !== "paused") return
  console.log("The box is paused. Resuming it…")
  await box.resume()
}

async function need() {
  const box = await find()
  if (!box) throw new Error(`There is no box named ${NAME}. Run \`bun box up\` first.`)
  return box
}

async function sh(box: Box, command: string) {
  const run = await box.exec.command(command)
  const output = String(run.result ?? "").trim()
  if (run.status !== "completed") throw new Error(`Command failed in the box: ${command}\n${output}`)
  return output
}

async function up() {
  const redis = configFromEnv()
  const bundle = join(root, "dist/host.mjs")
  if (!existsSync(bundle)) throw new Error("dist/host.mjs is missing. Run `bun run build` first.")

  let box = await find()
  if (box) {
    console.log(`Using box ${box.id}.`)
    await awake(box)
  } else {
    box = await Box.create({ apiKey, runtime: "node", name: NAME })
    console.log(`Created box ${box.id}.`)
  }

  await sh(box, `mkdir -p ${DIR} ${WORKDIR}`)
  await box.files.write({ path: `${DIR}/host.mjs`, content: readFileSync(bundle, "utf8") })
  await box.files.write({
    path: `${DIR}/package.json`,
    content: JSON.stringify({ private: true, type: "module", dependencies: { "@lydell/node-pty": PTY_VERSION } }),
  })
  await box.files.write({ path: `${DIR}/run.sh`, content: RUN_SH })
  await box.files.write({
    path: `${DIR}/.env`,
    content: [
      `UPSTASH_REDIS_REST_URL=${redis.url}`,
      `UPSTASH_REDIS_REST_TOKEN=${redis.token}`,
      `OC_SESSION=${redis.session}`,
      `OC_CWD=${WORKDIR}`,
      `XDG_DATA_HOME=${DIR}/data`,
      `XDG_CONFIG_HOME=${DIR}/config`,
      `XDG_STATE_HOME=${DIR}/state`,
      "",
    ].join("\n"),
  })
  await sh(box, `chmod 600 ${DIR}/.env && chmod +x ${DIR}/run.sh`)
  console.log("Uploaded the host.")

  console.log(await sh(box, `cd ${DIR} && npm install --no-audit --no-fund --loglevel=error 2>&1 | tail -3`))

  await box.setInitCommand(`sh ${DIR}/run.sh`)

  await sh(box, `pkill -f '[n]ode host.mjs'; sleep 0.5; sh ${DIR}/run.sh`)
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const log = await sh(box, `tail -n 3 ${DIR}/host.log`)
  console.log(log)
  if (!log.includes("is listening")) throw new Error("The host did not start. See `bun box logs`.")

  const config: ClientConfig = { ...redis, boxKey: apiKey!, boxId: box.id }
  saveClientConfig(config)

  const envFile = join(root, ".env")
  const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : ""
  const withId = env.replace(/^OC_BOX_ID=.*\n?/m, "").replace(/\n*$/, "\n") + `OC_BOX_ID=${box.id}\n`
  writeFileSync(envFile, withId)

  console.log(`
The host is running in box ${box.id}.
Config saved to ${CONFIG_FILE}.

On this machine:      node dist/oc.mjs
On another machine:   copy dist/oc.mjs there, then
                      node oc.mjs link ${encodeLink(config)}
                      node oc.mjs

The link holds your Redis token and Box API key. Treat it like a password.`)
}

async function status(lines: number) {
  const box = await need()
  const { status } = await box.getStatus()
  console.log(`Box ${box.id}: ${status}`)
  if (status === "paused") {
    console.log("The host starts again when the box is resumed. Running oc does that.")
    return
  }
  console.log(await sh(box, `pgrep -af '[n]ode host.mjs' || echo "host is not running"; echo; tail -n ${lines} ${DIR}/host.log 2>/dev/null`))
}

async function restart() {
  const box = await need()
  console.log(await sh(box, `pkill -f '[n]ode host.mjs'; sleep 0.5; sh ${DIR}/run.sh; sleep 2; tail -n 2 ${DIR}/host.log`))
}

async function down() {
  const box = await need()
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question(`Delete box ${box.id} and everything in it? Type the box id to confirm: `)
  prompt.close()
  if (answer.trim() !== box.id) {
    console.log("Not deleted.")
    return
  }
  await box.delete()
  console.log("Deleted.")
}

const command = process.argv[2]

if (command === "up") await up()
else if (command === "status") await status(8)
else if (command === "logs") await status(80)
else if (command === "restart") await restart()
else if (command === "down") await down()
else console.log("Usage: bun box <up | status | logs | restart | down>")
