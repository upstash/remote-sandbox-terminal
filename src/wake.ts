const KEEP_AWAKE_MS = 10 * 60_000

async function getBox(apiKey: string, boxId: string) {
  const { Box } = await import("@upstash/box")
  return Box.get(boxId, { apiKey })
}

export async function wake(apiKey: string, boxId: string, notice: (text: string) => void) {
  const box = await getBox(apiKey, boxId)
  const { status } = await box.getStatus()

  if (status === "paused") {
    notice("The box was asleep. Waking it…")
    await box.resume()
  }
}

export async function startHost(apiKey: string, boxId: string) {
  const box = await getBox(apiKey, boxId)
  const { status } = await box.getStatus()
  if (status === "paused") return

  const init = await box.getInitCommand()
  if (init) await box.exec.command(init)
}

export function keepAwake(apiKey: string, boxId: string, isInUse: () => boolean) {
  const timer = setInterval(async () => {
    if (!isInUse()) return
    try {
      const box = await getBox(apiKey, boxId)
      await box.exec.command("true")
    } catch {}
  }, KEEP_AWAKE_MS)

  timer.unref()
}
