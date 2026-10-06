import ReactDOM from 'react-dom/client'
import './styles.css'

const rootElement = document.getElementById('app')
if (!rootElement) throw new Error('Application root is missing')

if (location.pathname === '/') {
  const { Home } = await import('./components/landing/page')
  const page = <Home />
  if (rootElement.children.length) ReactDOM.hydrateRoot(rootElement, page)
  else ReactDOM.createRoot(rootElement).render(page)
} else {
  await import('./app')
}
