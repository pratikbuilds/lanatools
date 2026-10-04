import type { ReactNode } from 'react'

/** A page's title, with whatever belongs beside it. */
export function PageHead({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <h1 className="mr-1.5 font-mono text-[18px] font-semibold">{title}</h1>
      {children}
    </div>
  )
}

/** A section's heading, with its controls on the same row. */
export function SectionHead({
  title,
  className = '',
  children,
}: {
  title: string
  className?: string
  children?: ReactNode
}) {
  return (
    <div className={`mb-3 flex flex-wrap items-center gap-2.5 ${className}`}>
      <h2 className="d-h2">{title}</h2>
      {children}
    </div>
  )
}
