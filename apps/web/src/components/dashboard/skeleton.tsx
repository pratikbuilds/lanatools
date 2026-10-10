export function Skeleton({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block animate-pulse rounded-[6px] bg-panel-2 motion-reduce:animate-none ${className}`}
    />
  )
}
