import { CursorUnavailableError, type RealtimeCursor } from "@upstash/realtime"

const MAX_CHUNK = 96_000

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

type Item = { t: string; d?: string; [key: string]: unknown }

export class Sender {
  private queue: Item[] = []
  private inFlight = 0
  private seq = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private idleWaiters: (() => void)[] = []
  private lane: string
  lastSentAt = 0
  sent = 0

  constructor(
    private opts: {
      lane: string
      dataType: string
      emit: (message: Item & { l: string; s: number }) => Promise<unknown>
      concurrency: number
      spacingMs: number
      leadMs: number
      onError: (error: unknown) => void
    }
  ) {
    this.lane = opts.lane
  }

  reset(lane: string) {
    this.lane = lane
    this.seq = 0
    this.queue = []
  }

  send(item: Item, replace = false) {
    const last = this.queue[this.queue.length - 1]
    if (replace && last?.t === item.t) this.queue[this.queue.length - 1] = item
    else this.queue.push(item)
    this.schedule(0)
  }

  data(text: string) {
    if (text.length === 0) return

    const last = this.queue[this.queue.length - 1]
    let rest = text

    if (last?.t === this.opts.dataType && typeof last.d === "string" && last.d.length + rest.length <= MAX_CHUNK) {
      last.d += rest
      rest = ""
    }

    while (rest.length > 0) {
      let end = Math.min(rest.length, MAX_CHUNK)
      const code = rest.charCodeAt(end - 1)
      if (end < rest.length && code >= 0xd800 && code <= 0xdbff) end--
      this.queue.push({ t: this.opts.dataType, d: rest.slice(0, end) })
      rest = rest.slice(end)
    }

    this.schedule(this.opts.leadMs)
  }

  drain(timeoutMs: number): Promise<void> {
    if (this.queue.length === 0 && this.inFlight === 0) return Promise.resolve()

    return Promise.race([new Promise<void>((resolve) => this.idleWaiters.push(resolve)), sleep(timeoutMs)])
  }

  private schedule(delayMs: number) {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.pump()
    }, delayMs)
  }

  private pump() {
    while (this.queue.length > 0 && this.inFlight < this.opts.concurrency) {
      const wait = this.lastSentAt + this.opts.spacingMs - performance.now()
      if (wait > 0) {
        this.schedule(wait)
        return
      }

      const item = this.queue.shift()!
      this.lastSentAt = performance.now()
      this.inFlight++
      this.sent++

      this.opts
        .emit({ ...item, l: this.lane, s: ++this.seq })
        .catch(this.opts.onError)
        .finally(() => {
          this.inFlight--
          this.pump()
        })
    }

    if (this.queue.length === 0 && this.inFlight === 0) {
      for (const resolve of this.idleWaiters.splice(0)) resolve()
    }
  }
}

export class Reorder<M extends { s: number }> {
  private next: number
  private held = new Map<number, M>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private isStopped = false

  constructor(
    private opts: {
      start: number
      gapMs: number | (() => number)
      deliver: (message: M) => void
      onGap?: () => boolean | void
    }
  ) {
    this.next = opts.start
  }

  push(message: M) {
    if (this.isStopped || message.s < this.next || this.held.has(message.s)) return
    this.held.set(message.s, message)
    this.flush()
  }

  stop() {
    this.isStopped = true
    this.held.clear()
    if (this.timer) clearTimeout(this.timer)
  }

  private flush() {
    while (!this.isStopped) {
      const message = this.held.get(this.next)
      if (!message) break
      this.held.delete(this.next)
      this.next++
      this.opts.deliver(message)
    }

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.isStopped || this.held.size === 0) return

    const gapMs = typeof this.opts.gapMs === "function" ? this.opts.gapMs() : this.opts.gapMs
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.isStopped || this.held.size === 0) return
      if (this.opts.onGap?.() === false) {
        this.stop()
        return
      }
      this.next = Math.min(...this.held.keys())
      this.flush()
    }, gapMs)
  }
}

type Subscribable = {
  subscribe: (args: any) => Promise<() => unknown>
}

export class Listener<M> {
  private close: (() => unknown) | null = null
  private cursor: RealtimeCursor | null = null
  private generation = 0
  lastAt = performance.now()

  constructor(
    private opts: {
      channel: Subscribable
      event: string
      parse: (data: unknown) => M | null
      onMessage: (message: M) => void
      onLost?: () => void
      log?: (text: string) => void
    }
  ) {}

  start() {
    return this.open(false)
  }

  restart() {
    return this.open(true)
  }

  stop() {
    this.generation++
    this.shut()
  }

  private shut() {
    const close = this.close
    this.close = null
    if (!close) return
    try {
      Promise.resolve(close()).catch(() => {})
    } catch {}
  }

  private async open(isResuming: boolean) {
    const generation = ++this.generation
    this.shut()
    this.lastAt = performance.now()

    for (let attempt = 0; generation === this.generation; attempt++) {
      const pending = this.opts.channel.subscribe({
        events: [this.opts.event],
        ...(isResuming && this.cursor ? { after: this.cursor } : {}),
        onData: (event: { data: unknown; cursor: RealtimeCursor }) => {
          if (generation !== this.generation) return
          this.cursor = event.cursor
          this.lastAt = performance.now()
          const message = this.opts.parse(event.data)
          if (message) this.opts.onMessage(message)
        },
      })

      try {
        const close = await Promise.race([
          pending,
          sleep(10_000).then(() => {
            throw new Error("Subscribing timed out.")
          }),
        ])

        if (generation !== this.generation) {
          Promise.resolve(close()).catch(() => {})
          return
        }

        this.close = close
        this.lastAt = performance.now()
        return
      } catch (error) {
        pending.then((close) => close()).catch(() => {})

        if (error instanceof CursorUnavailableError) {
          this.cursor = null
          this.opts.onLost?.()
          continue
        }

        this.opts.log?.(`Subscribing failed: ${error instanceof Error ? error.message : String(error)}`)
        await sleep(Math.min(5_000, 300 * 2 ** attempt))
      }
    }
  }
}
