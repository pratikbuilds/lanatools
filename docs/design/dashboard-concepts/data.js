// Sample data shared by the theme options. Balance and per-client spend match
// the live dashboard; individual calls are illustrative.
const LT = {
  wallet: { balance: 19.91, address: 'G7fu2vBDEZ9SYM4agJ9shffJQUmyg6UC', network: 'Solana devnet' },
  clients: [
    { id: 'cc', name: 'Claude Code', project: 'lanatools', host: 'localhost:62434', limit: 2, last: '5 hours ago', live: false, buddy: 'warm' },
    { id: 'cx', name: 'Codex', host: '127.0.0.1:58113', limit: 1, last: '54 min ago', live: true, buddy: 'cool' },
  ],
  services: { merchant: 'Devnet merchant', helius: 'Helius RPC' },
  calls: [
    { day: 'Today', t: '6:11 PM', c: 'cx', s: 'merchant', path: '/api/v1/premium', p: 'x402', o: 'refused' },
    { day: 'Today', t: '6:08 PM', c: 'cx', s: 'merchant', path: '/api/v1/search', p: 'x402', o: 'paid', a: 0.02 },
    { day: 'Today', t: '6:05 PM', c: 'cx', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01 },
    { day: 'Today', t: '6:04 PM', c: 'cx', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01 },
    { day: 'Today', t: '6:04 PM', c: 'cx', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01 },
    { day: 'Today', t: '6:02 PM', c: 'cx', s: 'helius', path: '/getAssetsByOwner', p: 'RPC', o: 'free' },
    { day: 'Today', t: '2:02 PM', c: 'cc', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01 },
    { day: 'Today', t: '2:02 PM', c: 'cc', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01 },
    { day: 'Today', t: '2:01 PM', c: 'cc', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01 },
    { day: 'Today', t: '1:41 PM', c: 'cc', s: 'merchant', path: '/api/v1/fixed', p: 'MPP', o: 'failed' },
    { day: 'Yesterday', t: '4:15 PM', c: 'cc', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01 },
    { day: 'Yesterday', t: '4:14 PM', c: 'cc', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01 },
    { day: 'Yesterday', t: '4:14 PM', c: 'cc', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01 },
  ],
}

LT.money = (n) => '$' + n.toFixed(2)
LT.client = (id) => LT.clients.find((c) => c.id === id)
LT.spent = (id) => LT.calls.filter((x) => x.c === id && x.o === 'paid').reduce((s, x) => s + x.a, 0)
LT.totalSpent = () => LT.clients.reduce((s, c) => s + LT.spent(c.id), 0)
LT.cap = (s) => s[0].toUpperCase() + s.slice(1)
LT.short = (a, n = 6) => a.slice(0, n) + '…' + a.slice(-n)

// Demo only: every few seconds Codex makes a paid call, so the page shows
// how it reacts to live activity. Stops at its limit.
LT.live = (onCall, every = 7000) => setInterval(() => {
  const c = LT.client('cx')
  if (c.limit - LT.spent('cx') < 0.01) return
  const d = new Date()
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const call = { day: 'Today', t, c: 'cx', s: 'merchant', path: '/api/v1/fixed', p: 'x402', o: 'paid', a: 0.01, fresh: true }
  LT.calls.unshift(call)
  LT.wallet.balance = Math.round((LT.wallet.balance - 0.01) * 100) / 100
  c.last = 'just now'
  onCall(call)
}, every)

// Agent buddy: an original lanatools mascot, one per client, drawn on a
// pixel grid. a = antenna, b = body, l = light, d = dark (eyes, feet), m = mouth.
LT.BUDDY = [
  '......aa......',
  '.......a......',
  '...bbbbbbbb...',
  '..bbbbbbbbbb..',
  '.bbllbbbbbbbb.',
  '.bbbddbbbddbb.',
  '.bbbddbbbddbb.',
  '.bbbbbbbbbbbb.',
  '.bbbbbmmbbbbb.',
  '..bbbbbbbbbb..',
  '...bb....bb...',
  '...dd....dd...',
]

// Render a buddy as SVG. `palette` maps a/b/l/d/m to colours.
// `style`: 'pixel' (solid squares) or 'scan' (thin vertical strokes, dithered look).
LT.buddySVG = (palette, { size = 56, style = 'pixel', cls = '' } = {}) => {
  const W = LT.BUDDY[0].length, H = LT.BUDDY.length
  const cell = (x, y, ch, extra = '') => {
    const fill = palette[ch]
    if (!fill) return ''
    return style === 'scan'
      ? `<rect x="${x + 0.1}" y="${y}" width="0.75" height="1" fill="${fill}"${extra}/>`
      : `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${fill}"${extra}/>`
  }
  let open = '', closed = ''
  LT.BUDDY.forEach((row, y) => [...row].forEach((ch, x) => {
    if ((y === 5 || y === 6) && ch === 'd') {
      open += cell(x, y, 'd', ' class="eye"')
      closed += cell(x, y, y === 6 ? 'd' : 'b', ' class="lid"')
    } else open += cell(x, y, ch)
  }))
  return `<svg class="buddy ${cls}" viewBox="0 0 ${W} ${H}" width="${size}" height="${(size * H) / W}" shape-rendering="crispEdges" aria-hidden="true">${open}<g class="lids">${closed}</g></svg>`
}

// Small Solana-style mark: three slanted bars.
LT.solMark = (size = 14, fill = 'currentColor') => `<svg viewBox="0 0 24 20" width="${size}" height="${(size * 20) / 24}" aria-hidden="true"><path fill="${fill}" d="M5 0h19l-5 5H0zM0 7.5h19l5 5H5zM5 15h19l-5 5H0z"/></svg>`
