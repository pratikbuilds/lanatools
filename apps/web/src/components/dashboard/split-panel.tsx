import type { ReactNode } from 'react'

/**
 * Two panes side by side in a hatched frame, stacked on a phone: the
 * figure on the left, what to do about it on the right.
 */
export function SplitPanel({
  left,
  right,
  className = '',
  leftClassName = '',
}: {
  left: ReactNode
  right: ReactNode
  className?: string
  leftClassName?: string
}) {
  return (
    <div className={`d-frame ${className}`}>
      <div className="d-inset grid md:grid-cols-[1.15fr_1fr]">
        <div className={`d-pane ${leftClassName}`}>{left}</div>
        <div className="d-pane border-t border-line md:border-t-0 md:border-l">
          {right}
        </div>
      </div>
    </div>
  )
}
