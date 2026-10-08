import { useEffect, useRef } from 'react'

// An alternative to LedgerMark, kept for later and not used yet: the
// final "s" of lanatools is drawn as the Solana logomark.
const WORD = 'lanatool'
const LIME = '#d9ff4a'
const PAPER = '#b5c1f0'
const DIM = '#7f92dd'
const FONT = "'Paper Mono', ui-monospace, monospace"

// Glyphs that read as money in motion: amounts, hashes, arrows.
const INK = '$0123456789abcdef#%&@'
const FIELD = '0123456789abcdef.:·'

// The Solana logomark and its gradient, exactly as published at
// solana.com/branding (a 101 × 88 artboard). The brand asks that the mark
// is never stretched, so it keeps these proportions.
const SOLANA =
  'M100.48 69.3817L83.8068 86.8015C83.4444 87.1799 83.0058 87.4816 82.5185 87.6878C82.0312 87.894 81.5055 88.0003 80.9743 88H1.93563C1.55849 88 1.18957 87.8926 0.874202 87.6912C0.558829 87.4897 0.31074 87.2029 0.160416 86.8659C0.0100923 86.529 -0.0359181 86.1566 0.0280382 85.7945C0.0919944 85.4324 0.263131 85.0964 0.520422 84.8278L17.2061 67.408C17.5676 67.0306 18.0047 66.7295 18.4904 66.5234C18.9762 66.3172 19.5002 66.2104 20.0301 66.2095H99.0644C99.4415 66.2095 99.8104 66.3169 100.126 66.5183C100.441 66.7198 100.689 67.0067 100.84 67.3436C100.99 67.6806 101.036 68.0529 100.972 68.415C100.908 68.7771 100.737 69.1131 100.48 69.3817ZM83.8068 34.3032C83.4444 33.9248 83.0058 33.6231 82.5185 33.4169C82.0312 33.2108 81.5055 33.1045 80.9743 33.1048H1.93563C1.55849 33.1048 1.18957 33.2121 0.874202 33.4136C0.558829 33.6151 0.31074 33.9019 0.160416 34.2388C0.0100923 34.5758 -0.0359181 34.9482 0.0280382 35.3103C0.0919944 35.6723 0.263131 36.0083 0.520422 36.277L17.2061 53.6968C17.5676 54.0742 18.0047 54.3752 18.4904 54.5814C18.9762 54.7875 19.5002 54.8944 20.0301 54.8952H99.0644C99.4415 54.8952 99.8104 54.7879 100.126 54.5864C100.441 54.3849 100.689 54.0981 100.84 53.7612C100.99 53.4242 101.036 53.0518 100.972 52.6897C100.908 52.3277 100.737 51.9917 100.48 51.723L83.8068 34.3032ZM1.93563 21.7905H80.9743C81.5055 21.7907 82.0312 21.6845 82.5185 21.4783C83.0058 21.2721 83.4444 20.9704 83.8068 20.592L100.48 3.17219C100.737 2.90357 100.908 2.56758 100.972 2.2055C101.036 1.84342 100.99 1.47103 100.84 1.13408C100.689 0.79713 100.441 0.510296 100.126 0.308823C99.8104 0.107349 99.4415 1.24074e-05 99.0644 0L20.0301 0C19.5002 0.000878397 18.9762 0.107699 18.4904 0.313848C18.0047 0.519998 17.5676 0.821087 17.2061 1.19848L0.524723 18.6183C0.267681 18.8866 0.0966198 19.2223 0.0325185 19.5839C-0.0315829 19.9456 0.0140624 20.3177 0.163856 20.6545C0.31365 20.9913 0.561081 21.2781 0.875804 21.4799C1.19053 21.6817 1.55886 21.7896 1.93563 21.7905Z'
const SOL_W = 101
const SOL_H = 88
const SOL_AXIS = [8.53, 90.1, 88.99, -3.02] as const
const SOL_STOPS: Array<[number, string]> = [
  [0.08, '#9945FF'],
  [0.3, '#8752F3'],
  [0.5, '#5497D5'],
  [0.6, '#43B4CA'],
  [0.72, '#28E0B9'],
  [0.97, '#19FB9B'],
]
// Ledger glyphs etched into the mark, dark enough to read as texture.
const SOL_ETCH = '#0b1a5c'

type Packet = { row: number; x: number; speed: number; len: number }
type Ripple = { x: number; y: number; t: number }
const pick = (set: string) => set.charAt((Math.random() * set.length) | 0)

// The wordmark as a ledger: a grid of glyphs where the letters are lit
// lime, payment packets stream along the rows, and the pointer stirs them.
export function LedgerMarkSolana() {
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
    // The Solana mark: where it sits, its shape and fill, and the cells it
    // covers, which it draws itself instead of the grid.
    const mark = { x: 0, y: 0, w: 0, h: 0 }
    let solPath: Path2D | null = null
    let solFill: CanvasGradient | null = null
    let markCells: number[] = []
    let inMark: Uint8Array = new Uint8Array(0)
    let markHeat: Float32Array = new Float32Array(0)
    let dpr = 1
    let packets: Packet[] = []
    const ripples: Ripple[] = []
    const pointer = { x: -1e4, y: -1e4, on: false }
    let start = 0
    let frame = 0
    let visible = false
    let last = 0

    const build = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = canvas.clientWidth
      fs = Math.max(5, Math.min(13, width / 110))
      cw = fs * 0.62
      rh = fs * 1.02

      // Size the word and the mark to span the width, then trace them
      // into a mask. The mark stands as tall as the "l".
      const probe = document.createElement('canvas').getContext('2d')!
      probe.font = `800 100px ${FONT}`
      const text = probe.measureText(WORD).width
      const tall = probe.measureText('l').actualBoundingBoxAscent
      const gap = text / WORD.length / 5
      const wide = (tall * SOL_W) / SOL_H
      const size = (100 * width * 0.94) / (text + gap + wide)
      const unit = size / 100
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
      m.textBaseline = 'alphabetic'
      const left = (width - (text + gap + wide) * unit) / 2
      m.fillText(WORD, left, height)
      Object.assign(mark, {
        x: left + (text + gap) * unit,
        y: height - tall * unit,
        w: wide * unit,
        h: tall * unit,
      })
      solPath = new Path2D(SOLANA)
      solFill = ctx.createLinearGradient(...SOL_AXIS)
      for (const [at, color] of SOL_STOPS) solFill.addColorStop(at, color)
      m.save()
      m.translate(mark.x, mark.y)
      m.scale(mark.w / SOL_W, mark.h / SOL_H)
      m.fill(solPath)
      m.restore()
      const px = m.getImageData(0, 0, width, height).data
      const alpha = (x: number, y: number) =>
        (px[(Math.floor(y) * width + Math.floor(x)) * 4 + 3] ?? 0) / 255

      ink = new Float32Array(cols * rows)
      heat = new Float32Array(cols * rows)
      markHeat = new Float32Array(cols * rows)
      markCells = []
      inMark = new Uint8Array(cols * rows)
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
          const i = r * cols + c
          ink[i] = cover / 9
          const cx = ox + c * cw + cw / 2
          if (cx > mark.x && cx < mark.x + mark.w && cover > 0) {
            markCells.push(i)
            inMark[i] = 1
          }
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

          if (inMark[i]) {
            markHeat[i] = h
            continue
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

      // The Solana mark fades in as the decode reaches it: the official
      // shape and gradient, etched with ledger glyphs, with a shine that
      // sweeps across it and glyphs that sparkle.
      const shown = Math.min(1, Math.max(0, (age * 1.1 - mark.x / width) / 0.4))
      if (shown > 0 && solPath && solFill) {
        ctx.save()
        ctx.translate(mark.x, mark.y)
        ctx.scale(mark.w / SOL_W, mark.h / SOL_H)
        ctx.globalAlpha = shown
        ctx.fillStyle = solFill
        ctx.fill(solPath)
        ctx.clip(solPath)
        // The shine runs along the gradient's axis, stretched past both ends
        // so the band can enter and leave the mark completely.
        const [ax, ay, bx, by] = SOL_AXIS
        const band = ctx.createLinearGradient(
          ax - (bx - ax) * 0.3,
          ay - (by - ay) * 0.3,
          bx + (bx - ax) * 0.3,
          by + (by - ay) * 0.3,
        )
        const at = ((age * 0.22) % 1) * 0.84 + 0.08
        band.addColorStop(at - 0.08, 'rgb(255 255 255 / 0)')
        band.addColorStop(at, 'rgb(255 255 255 / 0.5)')
        band.addColorStop(at + 0.08, 'rgb(255 255 255 / 0)')
        ctx.fillStyle = band
        ctx.fillRect(0, 0, SOL_W, SOL_H)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        for (const i of markCells) {
          const h = markHeat[i] ?? 0
          if (!still && Math.random() < 0.01 + h * 0.3) glyph[i] = pick(INK)
          const spark = !still && Math.random() < 0.006
          ctx.fillStyle = spark || h > 0.3 ? '#fff' : SOL_ETCH
          ctx.globalAlpha = shown * (spark ? 1 : h > 0.3 ? h : 0.3)
          const c = i % cols
          const r = (i - c) / cols
          ctx.fillText(glyph[i] ?? '', ox + c * cw + cw / 2, r * rh + rh / 2)
        }
        ctx.restore()
      }

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
