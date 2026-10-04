import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * A dialog centred over the page, for a short task like a form. It is a
 * native modal dialog, so focus stays inside it and Escape closes it.
 */
export function Modal({
  open,
  onClose,
  title,
  detail,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  detail: string
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
      onClose={onClose}
      // A click on the dialog itself, not its content, is a click outside.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="d-modal m-auto w-[min(26rem,calc(100vw-2rem))] rounded-[14px] border border-line bg-panel p-0 text-fg shadow-(--d-shadow) backdrop:bg-(--d-scrim)"
    >
      {open && (
        <div>
          <div className="flex items-start justify-between gap-4 border-b border-dashed border-line-2 px-6 pt-5 pb-4">
            <div className="min-w-0">
              <p className="font-mono text-[11.5px] break-words text-fg-3">
                {detail}
              </p>
              <h2 className="mt-1 font-mono text-[17px] font-semibold tracking-tight break-words">
                {title}
              </h2>
            </div>
            <button type="button" className="d-btn d-btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="px-6 pt-5 pb-6">{children}</div>
        </div>
      )}
    </dialog>
  )
}
