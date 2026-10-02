import { expect, test } from '@playwright/test'
import {
  CROSSING_MESSAGES,
  ENTRY,
  PHASE,
} from '../../apps/web/src/components/landing/crossing'

test('toolkit checks coincide with every crossing on desktop and mobile', async ({
  page,
}) => {
  await page.goto('/')
  const diagram = page.getByRole('img', { name: /connect through one URL/ })
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(diagram).toHaveAttribute(
      'viewBox',
      width === 390 ? '0 0 390 646' : '0 0 1040 360',
    )
    const synchronized = await diagram.evaluate(
      (svg, clock) => {
        if (!(svg instanceof SVGSVGElement)) throw new Error('Missing diagram')
        svg.pauseAnimations()
        const packets = [...svg.querySelectorAll('animateMotion')].slice(0, 4)
        const toolkit = svg.querySelector('rect[width="260"]')
        if (!toolkit) throw new Error('Missing toolkit')
        const box = toolkit.getBoundingClientRect()
        const crossingsMatch = packets.every((motion, route) => {
          const period = Number.parseFloat(motion.getAttribute('dur') ?? '')
          const begin = Number.parseFloat(motion.getAttribute('begin') ?? '')
          return clock.messages.every((message, step) => {
            svg.setCurrentTime(
              begin + period * (clock.entry + step * clock.phase) + 0.1,
            )
            const label = [...svg.querySelectorAll('text')].filter(
              (el) => el.textContent === message,
            )[route]
            const packet = motion.parentElement?.getBoundingClientRect()
            if (!label?.parentElement || !packet) return false
            const x = packet.x + packet.width / 2
            const y = packet.y + packet.height / 2
            return (
              Number(getComputedStyle(label.parentElement).opacity) > 0.9 &&
              x >= box.x &&
              x <= box.right &&
              y >= box.y &&
              y <= box.bottom
            )
          })
        })
        const labels = [...svg.querySelectorAll('text')].filter((el) =>
          clock.messages.includes(el.textContent),
        )
        for (let tick = 0; tick < 180; tick++) {
          svg.setCurrentTime(tick / 10)
          const active = labels.filter(
            (el) =>
              el.parentElement &&
              Number(getComputedStyle(el.parentElement).opacity) > 0.9,
          )
          if (active.length !== 1) return false
        }
        return crossingsMatch
      },
      {
        entry: ENTRY,
        phase: PHASE,
        messages: CROSSING_MESSAGES,
      },
    )
    expect(synchronized).toBe(true)
    const denialClears = await diagram.evaluate((svg) => {
      if (!(svg instanceof SVGSVGElement)) throw new Error('Missing diagram')
      const motion = [...svg.querySelectorAll('animateMotion')].at(-1)
      const packet = motion?.parentElement
      const label = [...svg.querySelectorAll('text')].find(
        (el) => el.textContent === 'denied · over limit',
      )?.parentElement
      if (!motion || !packet || !label) throw new Error('Missing denial')
      const begin = Number.parseFloat(motion.getAttribute('begin') ?? '')
      const period = Number.parseFloat(motion.getAttribute('dur') ?? '')
      const arrival = begin + period * 0.45
      svg.setCurrentTime(arrival + 0.3)
      const visible = [packet, label].every(
        (el) => Number(getComputedStyle(el).opacity) > 0.9,
      )
      svg.setCurrentTime(arrival + 1.6)
      return (
        visible &&
        [packet, label].every(
          (el) => Number(getComputedStyle(el).opacity) === 0,
        )
      )
    })
    expect(denialClears).toBe(true)
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(diagram.locator('animate, animateMotion')).toHaveCount(0)
  await expect(diagram.getByText('your toolkit', { exact: true })).toBeVisible()
})
