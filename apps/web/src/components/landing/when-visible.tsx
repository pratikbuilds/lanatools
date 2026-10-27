import { useEffect, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'

/** Loads a section once it is near the viewport. The server keeps the fallback. */
export function WhenVisible({
  load,
  fallback,
  className,
}: {
  load: () => Promise<{ default: ComponentType }>
  fallback: ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [Comp, setComp] = useState<ComponentType | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node || Comp) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        observer.disconnect()
        void load().then((mod) => setComp(() => mod.default))
      },
      { rootMargin: '240px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [Comp, load])
  if (Comp) return <Comp />
  return (
    <div ref={ref} className={className}>
      {fallback}
    </div>
  )
}
