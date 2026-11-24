const ALT = [1049, 1047, 47]
const DEFAULT_ON = new Set([7, 25])
const TRANSIENT = new Set([2026])

const CSI_BODY_MAX = 256
const OSC_MAX = 4096

export class ModeTracker {
  private dec = new Map<number, boolean>()
  private kittyMain: number[] = []
  private kittyAlt: number[] = []
  private modifyOtherKeys = 0
  private isKeypadApplication = false
  private cursorStyle = 0
  private title: string | null = null
  private carry = ""

  reset() {
    this.dec.clear()
    this.kittyMain = []
    this.kittyAlt = []
    this.modifyOtherKeys = 0
    this.isKeypadApplication = false
    this.cursorStyle = 0
    this.title = null
    this.carry = ""
  }

  get isEmpty() {
    return (
      this.dec.size === 0 &&
      this.kittyMain.length === 0 &&
      this.kittyAlt.length === 0 &&
      this.modifyOtherKeys === 0 &&
      !this.isKeypadApplication &&
      this.cursorStyle === 0 &&
      this.title === null
    )
  }

  get alt() {
    return ALT.find((mode) => this.dec.get(mode))
  }

  feed(chunk: string) {
    const text = this.carry + chunk
    this.carry = ""
    let at = 0

    while (true) {
      const esc = text.indexOf("\x1b", at)
      if (esc === -1) return
      if (esc + 1 >= text.length) {
        this.carry = text.slice(esc)
        return
      }

      const kind = text[esc + 1]

      if (kind === "[") {
        let end = esc + 2
        while (end < text.length) {
          const code = text.charCodeAt(end)
          if (code < 0x20 || code > 0x3f) break
          end++
        }
        if (end >= text.length) {
          if (text.length - esc <= CSI_BODY_MAX) this.carry = text.slice(esc)
          return
        }
        this.csi(text.slice(esc + 2, end), text[end]!)
        at = end + 1
      } else if (kind === "]") {
        const bel = text.indexOf("\x07", esc + 2)
        const st = text.indexOf("\x1b\\", esc + 2)
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
        if (end === -1) {
          if (text.length - esc <= OSC_MAX) this.carry = text.slice(esc)
          return
        }
        this.osc(text.slice(esc + 2, end))
        at = end + (end === bel ? 1 : 2)
      } else if (kind === "=") {
        this.isKeypadApplication = true
        at = esc + 2
      } else if (kind === ">") {
        this.isKeypadApplication = false
        at = esc + 2
      } else if (kind === "c") {
        this.reset()
        at = esc + 2
      } else {
        at = esc + 1
      }
    }
  }

  private csi(body: string, final: string) {
    if ((final === "h" || final === "l") && body.startsWith("?")) {
      for (const part of body.slice(1).split(";")) {
        const mode = Number(part)
        if (Number.isInteger(mode) && mode > 0) this.dec.set(mode, final === "h")
      }
      return
    }

    if (final === "u") {
      const stack = this.alt ? this.kittyAlt : this.kittyMain
      if (body.startsWith(">")) {
        stack.push(Number(body.slice(1)) || 0)
      } else if (body.startsWith("<")) {
        const count = Number(body.slice(1)) || 1
        stack.splice(Math.max(0, stack.length - count))
      } else if (body.startsWith("=")) {
        const [flags = 0, how = 1] = body.slice(1).split(";").map(Number)
        const top = stack.pop() ?? 0
        stack.push(how === 2 ? top | flags : how === 3 ? top & ~flags : flags)
      }
      return
    }

    if (final === "m" && body.startsWith(">4")) {
      this.modifyOtherKeys = Number(body.split(";")[1]) || 0
      return
    }

    if (final === "q" && body.endsWith(" ")) {
      this.cursorStyle = Number(body.slice(0, -1)) || 0
    }
  }

  private osc(body: string) {
    if (body.startsWith("0;") || body.startsWith("2;")) this.title = body.slice(2)
  }

  preamble(screen = ""): string {
    let out = ""

    for (const flags of this.kittyMain) out += `\x1b[>${flags}u`

    const alt = this.alt
    if (alt) out += `\x1b[?${alt}h`
    if (alt || screen) out += `\x1b[0m\x1b[2J\x1b[H${screen}`

    for (const flags of this.kittyAlt) out += `\x1b[>${flags}u`

    for (const [mode, isOn] of this.dec) {
      if (ALT.includes(mode) || TRANSIENT.has(mode)) continue
      if (isOn && !DEFAULT_ON.has(mode)) out += `\x1b[?${mode}h`
      if (!isOn && DEFAULT_ON.has(mode)) out += `\x1b[?${mode}l`
    }

    if (this.modifyOtherKeys) out += `\x1b[>4;${this.modifyOtherKeys}m`
    if (this.isKeypadApplication) out += "\x1b="
    if (this.cursorStyle) out += `\x1b[${this.cursorStyle} q`
    if (this.title !== null) out += `\x1b]2;${this.title}\x07`

    return out
  }

  cleanup(): string {
    let out = "\x1b[?2026l"

    for (const [mode, isOn] of this.dec) {
      if (ALT.includes(mode) || TRANSIENT.has(mode)) continue
      if (isOn && !DEFAULT_ON.has(mode)) out += `\x1b[?${mode}l`
      if (!isOn && DEFAULT_ON.has(mode)) out += `\x1b[?${mode}h`
    }

    if (this.modifyOtherKeys) out += "\x1b[>4;0m"
    if (this.isKeypadApplication) out += "\x1b>"
    if (this.cursorStyle) out += "\x1b[0 q"

    out += "\x1b[<u".repeat(this.kittyAlt.length)
    out += "\x1b[0m"

    const alt = this.alt
    if (alt) out += `\x1b[?${alt}l`

    out += "\x1b[<u".repeat(this.kittyMain.length)

    return out
  }
}
