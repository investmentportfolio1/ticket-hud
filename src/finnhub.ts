// Finnhub REST client: only the two endpoints the HUD needs.
// Docs: https://finnhub.io/docs/api/quote and /market-status

const BASE = 'https://finnhub.io/api/v1'

export interface Quote {
  symbol: string
  price: number // current price
  change: number // change vs previous close
  changePct: number // percent change vs previous close
  time: number // unix seconds of the last trade
}

export type QuoteResult =
  | { ok: true; quote: Quote }
  | { ok: false; symbol: string; reason: 'not_found' | 'error' }

export class FinnhubError extends Error {
  constructor(
    public kind: 'bad_key' | 'rate_limited' | 'network' | 'http',
    message: string,
  ) {
    super(message)
  }
}

async function get(path: string, params: Record<string, string>, apiKey: string): Promise<any> {
  const qs = new URLSearchParams({ ...params, token: apiKey })
  let res: Response
  try {
    res = await fetch(`${BASE}${path}?${qs}`, { cache: 'no-store' })
  } catch {
    throw new FinnhubError('network', "Can't reach Finnhub")
  }
  if (res.status === 401 || res.status === 403) throw new FinnhubError('bad_key', 'API key rejected')
  if (res.status === 429) throw new FinnhubError('rate_limited', 'Rate limit hit')
  if (!res.ok) throw new FinnhubError('http', `Finnhub error ${res.status}`)
  return res.json()
}

export async function fetchQuote(symbol: string, apiKey: string): Promise<QuoteResult> {
  const d = await get('/quote', { symbol }, apiKey)
  // Finnhub returns all zeros (and t = 0) for symbols it doesn't know.
  if (!d || typeof d.c !== 'number' || (d.c === 0 && !d.t)) {
    return { ok: false, symbol, reason: 'not_found' }
  }
  return {
    ok: true,
    quote: {
      symbol,
      price: d.c,
      change: typeof d.d === 'number' ? d.d : 0,
      changePct: typeof d.dp === 'number' ? d.dp : 0,
      time: d.t ?? 0,
    },
  }
}

/** Fetch every symbol. Bad-key / rate-limit errors abort the whole batch. */
export async function fetchQuotes(symbols: string[], apiKey: string): Promise<QuoteResult[]> {
  const results: QuoteResult[] = []
  // Small batches keep us well inside Finnhub's 30 requests/second burst limit.
  for (let i = 0; i < symbols.length; i += 5) {
    const batch = symbols.slice(i, i + 5)
    const settled = await Promise.all(
      batch.map(s =>
        fetchQuote(s, apiKey).catch(err => {
          if (err instanceof FinnhubError && (err.kind === 'bad_key' || err.kind === 'rate_limited' || err.kind === 'network')) {
            throw err
          }
          return { ok: false, symbol: s, reason: 'error' } as QuoteResult
        }),
      ),
    )
    results.push(...settled)
  }
  return results
}

export async function fetchUsMarketOpen(apiKey: string): Promise<boolean | null> {
  try {
    const d = await get('/stock/market-status', { exchange: 'US' }, apiKey)
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
