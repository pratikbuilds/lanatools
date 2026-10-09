import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * A dialog centred over the page, for a short task like a form. It is a
 * native modal dialog, so focus stays inside it and Escape closes it.
 */
export function Modal({
  open,
  onClose,
  closable = true,
  title,
  detail,
  size = 'md',
  children,
}: {
  open: boolean
  onClose: () => void
  /**
   * False holds the dialog open: no Close button, and Escape and clicks
   * outside do nothing, for a task that must not be abandoned midway.
   */
  closable?: boolean
  title: string
  detail: string
  /**
   * Wide enough for two columns, for a task with a choice beside it. Its
   * height is fixed, so choosing does not move the dialog.
   */
  size?: 'md' | 'lg'
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const elements = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ),
        ).filter((element) => element.getClientRects().length > 0)
        const first = elements[0]
        const last = elements.at(-1)
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
      onCancel={(event) => {
        if (!closable) event.preventDefault()
      }}
      // The browser may still close it on a repeated Escape; reopen it.
      onClose={() => {
        if (closable) onClose()
        else ref.current?.showModal()
      }}
      // A click on the dialog itself, not its content, is a click outside.
      onClick={(event) => {
        if (closable && event.target === event.currentTarget) onClose()
      }}
      className={`d-modal m-auto flex-col overflow-clip rounded-[14px] ${size === 'lg' ? 'w-[min(46rem,calc(100vw-2rem))] md:h-[min(36rem,calc(100dvh-3rem))]' : 'w-[min(26rem,calc(100vw-2rem))]'} border border-line bg-panel p-0 text-fg shadow-(--d-shadow) open:flex backdrop:bg-(--d-scrim)`}
    >
      {open && (
        <>
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-dashed border-line-2 px-4 pt-5 pb-4 sm:px-6">
            <div className="min-w-0">
              <p className="font-mono text-[11.5px] break-words text-fg-3">
                {detail}
              </p>
              <h2 className="mt-1 font-mono text-[17px] font-semibold tracking-tight break-words">
                {title}
              </h2>
            </div>
            {closable && (
              <button
                type="button"
                className="d-btn d-btn-sm"
                onClick={onClose}
              >
                Close
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-6 sm:px-6">
            {children}
          </div>
        </>
      )}
    </dialog>
  )
}
