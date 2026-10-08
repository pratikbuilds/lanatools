import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { getRouter } from './router'

const router = getRouter()
const queryClient = new QueryClient()
const rootElement = document.getElementById('app')
if (!rootElement) throw new Error('Application root is missing')

// Load the route chunk before replacing the boot screen.
await router.load()

ReactDOM.createRoot(rootElement).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
)
