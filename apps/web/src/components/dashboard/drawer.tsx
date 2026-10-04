import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * A panel that slides over the page from the right, for the detail of one
 * row. It is a native modal dialog, so focus stays inside it and Escape
 * closes it without any code here.
 */
export function Drawer({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean
  onClose: () => void
  label: string
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
      aria-label={label}
      onClose={onClose}
      // The backdrop belongs to the dialog element; its content sits in the
      // wrapper below, so a click on the dialog itself is a click outside.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      className="m-0 ml-auto h-dvh max-h-none w-[min(28rem,100vw)] max-w-none border-l border-line bg-panel p-0 text-fg backdrop:bg-(--d-scrim)"
    >
      {open && (
        <div className="min-h-full px-6 pt-5 pb-8 sm:px-7">{children}</div>
      )}
    </dialog>
  )
}

export function DrawerHeader({
  title,
  detail,
  onClose,
}: {
  title: string
  detail: string
  onClose: () => void
}) {
  return (
    <div className="-mx-6 mb-6 flex items-start justify-between gap-4 border-b border-dashed border-line-2 px-6 pb-5 sm:-mx-7 sm:px-7">
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
  )
}

/** Label and value pairs under a drawer's main figure. */
export function DrawerFacts({
  facts,
}: {
  facts: Array<[label: string, value: ReactNode]>
}) {
  return (
    <dl className="mt-6 grid grid-cols-[8.5rem_minmax(0,1fr)] overflow-hidden rounded-[10px] border border-line text-[13.5px]">
      {facts.map(([label, value]) => (
        <div
          key={label}
          className="col-span-2 grid grid-cols-subgrid border-b border-line last:border-b-0"
        >
          <dt className="d-th d-label flex items-center px-3.5 py-2.5">
            {label}
          </dt>
          <dd className="px-3.5 py-2.5 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
