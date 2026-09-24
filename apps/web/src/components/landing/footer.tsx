import { useRef } from 'react'
import type { PointerEvent } from 'react'
import { ApiStatus } from './api-status'
import { BrandMark } from './brand'
import { CopyStatus, MCP_HOST, MCP_URL, copyLabel, useCopy } from './copy-url'
import { Logo } from './logo'

const LINKS = [
  { label: 'Why', href: '#why' },
  { label: 'How it works', href: '#how' },
  { label: 'Control', href: '#control' },
  { label: 'Tools', href: '#tools' },
  { label: 'Connect', href: '#connect' },
]

// An outlined wordmark; a lime spotlight fills the letters under the pointer.
function Spotlight() {
  const ref = useRef<HTMLDivElement>(null)

  const move = (e: PointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    el.style.setProperty('--x', `${e.clientX - box.left}px`)
    el.style.setProperty('--y', `${e.clientY - box.top}px`)
  }

  return (
    <div
      ref={ref}
      onPointerMove={move}
      onPointerDown={move}
      className="spotlight @container relative cursor-crosshair touch-pan-y select-none"
      aria-hidden="true"
    >
      <p className="spotlight-outline text-center text-[16.5cqw] leading-none font-extrabold tracking-[-0.02em]">
        lanatools
      </p>
      <p className="spotlight-fill absolute inset-0 text-center text-[16.5cqw] leading-none font-extrabold tracking-[-0.02em] text-lime">
        lanatools
      </p>
    </div>
  )
}

export function Footer({ wide }: { wide: string }) {
  const { state, copy } = useCopy(MCP_URL)
  return (
    <footer className="bg-blue-deep">
      <div className={`${wide} pt-14 sm:pt-16`}>
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="flex items-center gap-2.5 text-[17px] font-bold tracking-tight text-paper">
              <BrandMark size={26} />
              <span>
                lanatools<span className="font-medium text-paper-2">.sh</span>
              </span>
            </p>
            <p className="mt-3 max-w-[34ch] text-[13.5px] text-paper-2">
              One URL for every agent. Each one pays within its own limit.
            </p>
            <button
              type="button"
              onClick={() => void copy()}
              className="mt-4 flex min-h-[30px] items-center gap-2 text-[13px] text-paper-2 transition-colors hover:text-lime"
              aria-label="Copy the MCP URL"
            >
              <span className="text-paper-3">$</span>
              <span className="font-semibold text-paper">{MCP_HOST}</span>
              <span className="rounded-[4px] border border-paper/30 px-1.5 text-[10.5px] leading-[18px]">
                {state === 'copied' ? 'copied ✓' : copyLabel(state)}
              </span>
            </button>
            <CopyStatus state={state} />
          </div>

          <nav aria-label="Footer">
            <ul className="-my-1.5 flex flex-wrap gap-x-6 text-[13.5px]">
              {LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    className="inline-block py-1.5 text-paper-2 transition-colors hover:text-lime"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>

      <div className="mx-auto w-full max-w-[90rem] px-2 pt-10 pb-4 sm:pt-12 sm:pb-6">
        <Spotlight />
      </div>

      <div className={wide}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-paper/15 py-5 text-[12px] text-paper-3">
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>© 2026 lanatools</span>
            <span className="flex items-center gap-1.5">
              <Logo id="solana" size={11} />
              built on Solana
            </span>
            <span>figures on this page are illustrative</span>
          </span>
          <span className="flex items-center gap-5">
            <ApiStatus />
            <a
              href="#"
              className="-my-1.5 inline-block py-1.5 whitespace-nowrap text-paper-2 hover:text-lime"
            >
              back to top ↑
            </a>
          </span>
        </div>
      </div>
    </footer>
  )
}
