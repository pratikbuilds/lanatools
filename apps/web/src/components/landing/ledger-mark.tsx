import { useEffect, useRef } from 'react'

const WORD = 'lanatools'
const LIME = '#d9ff4a'
const PAPER = '#b5c1f0'
const DIM = '#7f92dd'
const FONT = "'JetBrains Mono', ui-monospace, monospace"

// Glyphs that read as money in motion: amounts, hashes, arrows.
const INK = '$0123456789abcdef#%&@'
const FIELD = '0123456789abcdef.:·'

type Packet = { row: number; x: number; speed: number; len: number }
type Ripple = { x: number; y: number; t: number }
const pick = (set: string) => set.charAt((Math.random() * set.length) | 0)

// The wordmark as a ledger: a grid of glyphs where the letters are lit
// lime, payment packets stream along the rows, and the pointer stirs them.
export function LedgerMark() {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let cols = 0
    let rows = 0
    let cw = 0
    let rh = 0
    let fs = 0
    let width = 0
    let height = 0
    let ink: Float32Array = new Float32Array(0)
    let heat: Float32Array = new Float32Array(0)
    let glyph: string[] = []
    let packets: Packet[] = []
    const ripples: Ripple[] = []
    const pointer = { x: -1e4, y: -1e4, on: false }
    let start = 0
    let frame = 0
    let visible = false
    let last = 0

    const build = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth
      fs = Math.max(5, Math.min(13, width / 110))
      cw = fs * 0.62
      rh = fs * 1.02

      // Size the word to span the width, then trace it into a mask.
      const probe = document.createElement('canvas').getContext('2d')!
      probe.font = `800 100px ${FONT}`
      const size = (100 * width * 0.94) / probe.measureText(WORD).width
      height = Math.ceil(size * 0.8)
      cols = Math.floor(width / cw)
      rows = Math.floor(height / rh)
      height = rows * rh

      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const mask = document.createElement('canvas')
      mask.width = width
      mask.height = height
      const m = mask.getContext('2d')!
      m.font = `800 ${size}px ${FONT}`
      m.textAlign = 'center'
      m.textBaseline = 'alphabetic'
      m.fillText(WORD, width / 2, height)
      const px = m.getImageData(0, 0, width, height).data
      const alpha = (x: number, y: number) =>
        (px[(Math.floor(y) * width + Math.floor(x)) * 4 + 3] ?? 0) / 255

      ink = new Float32Array(cols * rows)
      heat = new Float32Array(cols * rows)
      glyph = Array.from({ length: cols * rows }, () => pick(INK))
      const ox = (width - cols * cw) / 2
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // Light a cell by how much of it the letter covers, not by its
          // centre alone, so the thin tops of curves leave no stray glyphs.
          let cover = 0
          for (let sy = 0; sy < 3; sy++)
            for (let sx = 0; sx < 3; sx++)
              cover += alpha(
                ox + (c + 0.2 + sx * 0.3) * cw,
                (r + 0.2 + sy * 0.3) * rh,
              )
          ink[r * cols + c] = cover / 9
        }
      }
      packets = []
    }

    const spawn = (row = (Math.random() * rows) | 0) =>
      packets.push({
        row,
        x: -Math.random() * 20,
        speed: 18 + Math.random() * 40,
        len: 6 + Math.random() * 18,
      })

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000 || 0)
      last = now
      const age = still ? 99 : (now - start) / 1000
      const ox = (width - cols * cw) / 2

      if (!still) {
        if (packets.length < rows * 0.9 && Math.random() < 0.35) spawn()
        for (const p of packets) p.x += p.speed * dt
        packets = packets.filter((p) => p.x - p.len < cols)
        heat = heat.map((v) => v * 0.9)
        for (const p of packets) {
          const head = Math.floor(p.x)
          for (let k = 0; k < p.len; k++) {
            const c = head - k
            if (c < 0 || c >= cols) continue
            const i = p.row * cols + c
            heat[i] = Math.max(heat[i] ?? 0, 1 - k / p.len)
          }
        }
      }

      ctx.clearRect(0, 0, width, height)
      ctx.font = `700 ${fs}px ${FONT}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'

      const reach = 9
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const i = r * cols + c
          const cx = ox + c * cw + cw / 2
          const cy = r * rh + rh / 2
          let x = cx
          let y = cy

          // The pointer is a lens: glyphs heat up and bulge away from it.
          // Clicks send a shockwave through the grid.
          let h = heat[i] ?? 0
          if (pointer.on) {
            const ux = (cx - pointer.x) / cw
            const uy = (cy - pointer.y) / rh / 0.6
            const d = Math.hypot(ux, uy)
            if (d < reach) {
              const k = 1 - d / reach
              h = Math.max(h, k ** 1.5)
              const push = (k * k * cw * 2.2) / (d || 1)
              x += ux * push
              y += uy * push * 0.6
            }
          }
          for (const w of ripples) {
            const t = (now - w.t) / 1000
            const ux = (cx - w.x) / cw
            const uy = (cy - w.y) / rh / 0.6
            const d = Math.hypot(ux, uy)
            const band = 1 - Math.abs(d - t * 70) / 4
            if (band <= 0) continue
            const k = band * Math.max(0, 1 - t / 1.4)
            h = Math.max(h, k)
            const push = (k * cw * 1.4) / (d || 1)
            x += ux * push
            y += uy * push * 0.6
          }

          // Letters decode left to right on first view.
          const reveal = age * 1.1 - c / cols - ((r * 7 + c * 13) % 10) / 40
          if ((ink[i] ?? 0) > 0.5) {
            if (reveal < 0) continue
            const settling = reveal < 0.35
            if (settling || Math.random() < 0.004 + h * 0.3)
              glyph[i] = pick(INK)
            // A faint cell behind each glyph keeps the letters solid.
            ctx.fillStyle = settling ? PAPER : LIME
            ctx.globalAlpha = settling ? 0.06 : 0.1 + h * 0.25
            ctx.fillRect(x - cw / 2, y - rh / 2, cw, rh)
            ctx.globalAlpha = settling ? 0.5 : 0.85 + h * 0.15
            ctx.fillText(glyph[i] ?? '', x, y)
          } else if (h > 0.08) {
            if (Math.random() < h * 0.4) glyph[i] = pick(FIELD)
            const lead = h > 0.92
            ctx.fillStyle = lead ? LIME : PAPER
            ctx.globalAlpha = lead ? 1 : h * 0.7
            ctx.fillText(lead ? '▸' : (glyph[i] ?? ''), x, y)
          } else if ((c + r * 3) % 4 === 0) {
            ctx.fillStyle = DIM
            ctx.globalAlpha = 0.3
            ctx.fillText('·', x, y)
          }
        }
      }
      ctx.globalAlpha = 1

      while (ripples[0] && now - ripples[0].t > 1400) ripples.shift()
      if (!still && visible) frame = requestAnimationFrame(draw)
    }

    const run = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(draw)
    }

    const local = (e: PointerEvent) => {
      const box = canvas.getBoundingClientRect()
      return { x: e.clientX - box.left, y: e.clientY - box.top }
    }
    const onMove = (e: PointerEvent) => {
      Object.assign(pointer, local(e), { on: true })
    }
    const onLeave = () => {
      pointer.on = false
    }
    const onDown = (e: PointerEvent) => {
      const p = local(e)
      ripples.push({ ...p, t: performance.now() })
      const row = Math.floor(p.y / rh)
      for (let k = -2; k <= 2; k++)
        if (row + k >= 0 && row + k < rows) spawn(row + k)
    }

    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false
      if (visible && !start) start = performance.now()
      if (visible) run()
      else cancelAnimationFrame(frame)
    })
    const ro = new ResizeObserver(() => {
      if (canvas.clientWidth === width) return
      build()
      run()
    })

    let live = true
    void document.fonts.ready.then(() => {
      if (!live) return
      build()
      ro.observe(canvas)
      io.observe(canvas)
      if (still) draw(performance.now())
    })
    if (!still) {
      canvas.addEventListener('pointermove', onMove)
      canvas.addEventListener('pointerleave', onLeave)
      canvas.addEventListener('pointerdown', onDown)
    }

    return () => {
      live = false
      cancelAnimationFrame(frame)
      io.disconnect()
      ro.disconnect()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
    }
  }, [])

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className="block w-full cursor-crosshair touch-pan-y select-none"
    />
  )
}
