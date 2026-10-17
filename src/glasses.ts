// Everything that draws on the G2 display (576 x 288, one fixed font).
//
// The firmware font is not monospaced, so columns are built from separate
// text containers (symbol / price / change) that share the same rows.
// Two layouts exist:
//   'message' → header + one full-width body (setup hints, errors)
//   'table'   → header + three column containers
// Switching layout uses rebuildPageContainer; updates within a layout use
// textContainerUpgrade, which redraws text without flicker.

import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { QuoteResult } from './finnhub'

export const ROWS_PER_PAGE = 8

const HEADER = { id: 1, name: 'header' }
const COL_SYM = { id: 2, name: 'symbols' } // also the event-capture container
const COL_PRICE = { id: 3, name: 'prices' }
const COL_CHG = { id: 4, name: 'changes' }

const BODY_Y = 40
const BODY_H = 248

type Layout = 'message' | 'table'

function text(
  ref: { id: number; name: string },
  x: number,
  y: number,
  w: number,
  h: number,
  content: string,
  capture = false,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: x,
    yPosition: y,
    width: w,
    height: h,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: ref.id,
    containerName: ref.name,
    content,
    isEventCapture: capture ? 1 : 0,
  })
}

function messageContainers(header: string, body: string): TextContainerProperty[] {
  return [
    text(HEADER, 0, 0, 576, 36, header),
    text(COL_SYM, 0, BODY_Y, 576, BODY_H, body, true),
  ]
}

function tableContainers(header: string, cols: [string, string, string]): TextContainerProperty[] {
  return [
    text(HEADER, 0, 0, 576, 36, header),
    text(COL_SYM, 0, BODY_Y, 170, BODY_H, cols[0], true),
    text(COL_PRICE, 170, BODY_Y, 190, BODY_H, cols[1]),
    text(COL_CHG, 360, BODY_Y, 216, BODY_H, cols[2]),
  ]
}

function formatPrice(p: number): string {
  const digits = p < 1 ? 4 : 2
  return p.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function formatChange(pct: number): string {
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '–'
  const sign = pct > 0 ? '+' : ''
  return `${arrow} ${sign}${pct.toFixed(2)}%`
}

function clock(d = new Date()): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / ROWS_PER_PAGE))
}

export class GlassesView {
  private layout: Layout | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private bridge: EvenAppBridge) {}

  /** Must run exactly once, before anything else is drawn. */
  async start(): Promise<boolean> {
    const containers = messageContainers('TICKER HUD', 'Loading…')
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({ containerTotalNum: containers.length, textObject: containers }),
    )
    const ok = result === 0
    if (ok) this.layout = 'message'
    return ok
  }

  showMessage(body: string, header = 'TICKER HUD'): Promise<void> {
    return this.enqueue(async () => {
      if (this.layout !== 'message') {
        await this.rebuild(messageContainers(header, body))
        this.layout = 'message'
        return
      }
      await this.upgrade(HEADER, header)
      await this.upgrade(COL_SYM, body)
    })
  }

  showQuotes(results: QuoteResult[], page: number, marketOpen: boolean | null, stale = false): Promise<void> {
    const pages = pageCount(results.length)
    const p = Math.min(Math.max(page, 0), pages - 1)
    const rows = results.slice(p * ROWS_PER_PAGE, (p + 1) * ROWS_PER_PAGE)

    const syms: string[] = []
    const prices: string[] = []
    const changes: string[] = []
    for (const r of rows) {
      if (r.ok) {
        syms.push(r.quote.symbol)
        prices.push(formatPrice(r.quote.price))
        changes.push(formatChange(r.quote.changePct))
      } else {
        syms.push(r.symbol)
        prices.push(r.reason === 'not_found' ? 'not found' : '—')
        changes.push('')
      }
    }

    const parts = ['WATCHLIST']
    if (pages > 1) parts.push(`${p + 1}/${pages}`)
    if (marketOpen !== null) parts.push(marketOpen ? '● OPEN' : '○ CLOSED')
    parts.push(stale ? `${clock()} (retrying)` : clock())
    const header = parts.join('   ')

    const cols: [string, string, string] = [syms.join('\n'), prices.join('\n'), changes.join('\n')]

    return this.enqueue(async () => {
      if (this.layout !== 'table') {
        await this.rebuild(tableContainers(header, cols))
        this.layout = 'table'
        return
      }
      await this.upgrade(HEADER, header)
      await this.upgrade(COL_SYM, cols[0])
      await this.upgrade(COL_PRICE, cols[1])
      await this.upgrade(COL_CHG, cols[2])
    })
  }

  /** Draw calls are serialized so overlapping refreshes never interleave. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(job, job)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async rebuild(containers: TextContainerProperty[]): Promise<void> {
    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({ containerTotalNum: containers.length, textObject: containers }),
    )
  }

  private async upgrade(ref: { id: number; name: string }, content: string): Promise<void> {
    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: ref.id, containerName: ref.name, content }),
    )
  }
}
