import { expect, test } from 'bun:test'
import { renderToString } from 'react-dom/server'
import { ExportWalletView } from './export-wallet'

function render(props: Partial<Parameters<typeof ExportWalletView>[0]> = {}) {
  return renderToString(
    <ExportWalletView
      exporting={false}
      failed={false}
      onExport={() => {}}
      {...props}
    />,
  )
}

test('the private key can be exported, with a warning', () => {
  const html = render()
  expect(html).toContain('Export private key')
  expect(html).toContain('Anyone with this key controls your funds')
  expect(html).not.toContain('disabled=""')
})

test('export is not opened twice while Privy shows it', () => {
  expect(render({ exporting: true })).toContain('disabled=""')
})

test('a failed export says so', () => {
  expect(render({ failed: true })).toContain('Could not open the private key')
})
