import { Suspense, use } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getRouter } from './router'

const rootElement = document.getElementById('app')
if (!rootElement) throw new Error('Application root is missing')

const router = getRouter()
// Keep the boot screen visible while the first route chunk loads.
const boot = rootElement.innerHTML
const firstPage = router.load()
function Pages() {
  use(firstPage)
  return <RouterProvider router={router} />
}
const queryClient = new QueryClient({
  // Matches the dashboard's polling, so moving between pages reuses data.
  defaultOptions: { queries: { staleTime: 15_000 } },
})

const app = (
  <QueryClientProvider client={queryClient}>
    <Suspense
      fallback={
        <div className="contents" dangerouslySetInnerHTML={{ __html: boot }} />
      }
    >
      <Pages />
    </Suspense>
  </QueryClientProvider>
)

ReactDOM.createRoot(rootElement).render(app)
