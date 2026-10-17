// Finnhub REST client: only the endpoints the HUD needs.
// Docs: https://finnhub.io/docs/api

const BASE = 'https://finnhub.io/api/v1'

export interface Quote {
  symbol: string
  price: number // current price
  change: number // change vs previous close
  changePct: number // percent change vs previous close
  high: number // today's high
  low: number // today's low
  open: number // today's open
  prevClose: number
  time: number // unix seconds of the last trade
}

export type QuoteResult =
  | { ok: true; quote: Quote }
  | { ok: false; symbol: string; reason: 'not_found' | 'error' }

export interface Candles {
  t: number[] // unix seconds (start of each bar)
  o: number[]
  h: number[]
  l: number[]
  c: number[]
}

export class FinnhubError extends Error {
  constructor(
    public kind: 'bad_key' | 'no_access' | 'rate_limited' | 'network' | 'http',
    message: string,
  ) {
    super(message)
  }
}

export async function getJson(path: string, params: Record<string, string>, apiKey: string): Promise<any> {
  const qs = new URLSearchParams({ ...params, token: apiKey })
  let res: Response
  try {
    res = await fetch(`${BASE}${path}?${qs}`, { cache: 'no-store' })
  } catch {
    throw new FinnhubError('network', "Can't reach Finnhub")
  }
  if (res.status === 401) throw new FinnhubError('bad_key', 'API key rejected')
  // Finnhub answers 403 "You don't have access to this resource" for
  // endpoints that need a paid plan (e.g. historical candles).
  if (res.status === 403) throw new FinnhubError('no_access', 'Not included in your Finnhub plan')
  if (res.status === 429) throw new FinnhubError('rate_limited', 'Rate limit hit')
  if (!res.ok) throw new FinnhubError('http', `Finnhub error ${res.status}`)
  return res.json()
}

export async function fetchQuote(symbol: string, apiKey: string): Promise<QuoteResult> {
  const d = await getJson('/quote', { symbol }, apiKey)
  // Finnhub returns all zeros (and t = 0) for symbols it doesn't know.
  if (!d || typeof d.c !== 'number' || (d.c === 0 && !d.t)) {
    return { ok: false, symbol, reason: 'not_found' }
  }
  const n = (v: unknown) => (typeof v === 'number' ? v : 0)
  return {
    ok: true,
    quote: {
      symbol,
      price: d.c,
      change: n(d.d),
      changePct: n(d.dp),
      high: n(d.h),
      low: n(d.l),
      open: n(d.o),
      prevClose: n(d.pc),
      time: n(d.t),
    },
  }
}

/** Fetch every symbol. Key / plan / rate-limit / network errors abort the batch. */
export async function fetchQuotes(symbols: string[], apiKey: string): Promise<QuoteResult[]> {
  const results: QuoteResult[] = []
  // Small batches keep us well inside Finnhub's 30 requests/second burst limit.
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = symbols.slice(i, i + 5)
    const settled = await Promise.all(
      batch.map(s =>
        fetchQuote(s, apiKey).catch(err => {
          if (err instanceof FinnhubError && err.kind !== 'http') throw err
          return { ok: false, symbol: s, reason: 'error' } as QuoteResult
        }),
      ),
    )
    results.push(...settled)
  }
  return results
}

/**
 * Price bars between two unix times. resolution: '1' | '5' | '15' | '30' | '60' | 'D'.
 * Returns null when Finnhub has no bars in that range (market closed, holiday).
 * Needs a paid Finnhub plan; free keys get FinnhubError('no_access').
 */
export async function fetchCandles(
  symbol: string,
  resolution: string,
  from: number,
  to: number,
  apiKey: string,
): Promise<Candles | null> {
  const d = await getJson(
    '/stock/candle',
    { symbol, resolution, from: String(Math.floor(from)), to: String(Math.floor(to)) },
    apiKey,
  )
  if (!d || d.s !== 'ok' || !Array.isArray(d.t) || !d.t.length) return null
  return { t: d.t, o: d.o, h: d.h, l: d.l, c: d.c }
}

/** Company name → ticker, via Finnhub's symbol search (free). */
export async function searchSymbol(query: string, apiKey: string): Promise<{ symbol: string; name: string } | null> {
  const d = await getJson('/search', { q: query }, apiKey)
  const list: any[] = Array.isArray(d?.result) ? d.result : []
  // Prefer plain US common stock tickers (no exchange suffix like ".L").
  const pick =
    list.find(r => r.type === 'Common Stock' && !String(r.symbol).includes('.')) ??
    list.find(r => !String(r.symbol).includes('.')) ??
    list[0]
  return pick ? { symbol: String(pick.symbol), name: String(pick.description ?? '') } : null
}

export async function fetchUsMarketOpen(apiKey: string): Promise<boolean | null> {
  try {
    const d = await getJson('/stock/market-status', { exchange: 'US' }, apiKey)
    return typeof d?.isOpen === 'boolean' ? d.isOpen : null
  } catch {
    return null
  }
}

/** Free tier allows 60 calls/minute; stay under ~50 to leave headroom. */
export function safeIntervalSeconds(requested: number, symbolCount: number): number {
  const minForLimit = Math.ceil((symbolCount * 60) / 50)
  return Math.max(requested, minForLimit, 10)
}

export function parseSymbols(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.toUpperCase().split(/[\s,;]+/)) {
    const s = part.replace(/[^A-Z0-9.:\-]/g, '')
    if (s) seen.add(s)
  }
  return [...seen].slice(0, 30)
}
