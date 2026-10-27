import { BrandMark } from './brand'
import { Logo } from './logo'
import { WhenVisible } from './when-visible'

const loadLedger = () =>
  import('./ledger-mark').then((module) => ({
    default: module.LedgerMark,
  }))

const LINKS = [
  { label: 'Why', href: '#why' },
  { label: 'How it works', href: '#how' },
  { label: 'Control', href: '#control' },
  { label: 'Tools', href: '#tools' },
  { label: 'Connect', href: '#connect' },
]

export function Footer({ wide }: { wide: string }) {
  return (
    <footer className="overflow-hidden bg-blue-deep">
      <div
        className={`${wide} flex flex-col gap-4 pt-10 sm:flex-row sm:items-center sm:justify-between`}
      >
        <p className="flex items-center gap-2.5 text-[16px] font-bold tracking-tight text-paper">
          <BrandMark size={22} />
          <span>
            lanatools<span className="font-medium text-paper-2">.sh</span>
          </span>
        </p>
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

      <div
        className={`${wide} mt-9 flex items-center gap-4 text-[12.5px] text-paper-2`}
      >
        <span className="flex shrink-0 items-center gap-2">
          <Logo id="solana" size={12} />
          built on <span className="text-paper">Solana</span>
        </span>
        <span aria-hidden="true" className="footer-rail" />
        <a
          href="#"
          className="-my-1.5 shrink-0 py-1.5 transition-colors hover:text-lime"
        >
          back to top ↑
        </a>
      </div>

      <div className="mx-auto w-full max-w-[90rem] px-2 pt-5">
        <WhenVisible
          load={loadLedger}
          fallback={<div className="min-h-40 w-full" />}
        />
      </div>
    </footer>
  )
}
