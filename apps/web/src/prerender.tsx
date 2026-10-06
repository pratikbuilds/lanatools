import { renderToString } from 'react-dom/server'
import { Home } from './components/landing/page'

export function render() {
  return renderToString(<Home />)
}
