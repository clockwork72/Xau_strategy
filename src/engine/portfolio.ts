import type { UTCTimestamp } from 'lightweight-charts'
import type { Signal } from './strategy'

// 1 standard lot of XAUUSD = 100 oz. With lotSize 0.01 → 1 oz exposure.
// $1 price move on 0.01 lot = $1 P&L.
export const CONTRACT_SIZE_OZ = 100

export type TradeSide = 'long' | 'short'

export interface ClosedTrade {
  side: TradeSide
  entryTime: UTCTimestamp
  entryPrice: number
  exitTime: UTCTimestamp
  exitPrice: number
  pnl: number
  // PAB enrichments — set when the entry Signal carried them:
  label?: string
  sl?: number
  tp?: number
  rMultiple?: number
  reason?: 'stop' | 'target'
  channelLabel?: string
}

export interface OpenTrade {
  side: TradeSide
  entryTime: UTCTimestamp
  entryPrice: number
  label?: string
  sl?: number
  tp?: number
  channelLabel?: string
}

export interface StrategyStats {
  closedTrades: ClosedTrade[]
  openTrade: OpenTrade | null
  realizedPnl: number
  unrealizedPnl: number
  totalTrades: number
  wins: number
  losses: number
  winRate: number | null
  avgWin: number
  avgLoss: number
  equity: number
}

function pnlOnClose(side: TradeSide, entry: number, exit: number, lotSize: number): number {
  const perUnit = side === 'long' ? exit - entry : entry - exit
  return perUnit * CONTRACT_SIZE_OZ * lotSize
}

/**
 * Pair signals into closed trades + an optional open trade.
 *
 * Two pairing models, chosen automatically per call:
 *
 *  - **Label-paired** (PAB-style, default when any signal carries a label):
 *    Sells with `sl/tp` metadata are entries; buys with `reason` metadata are
 *    exits. Entries pair with exits by `label`. Open trades are entries with
 *    no matching exit. Orphan signals are dropped. This avoids the
 *    "consecutive sells fabricate a fake long" phantom-trade bug.
 *
 *  - **Alternating-flip** (fallback when signals are unlabeled): each new
 *    signal closes the previous open and opens a new position on the opposite
 *    side. Preserved so the EMA-cross placeholder strategy still produces
 *    sensible stats if someone swaps it back in.
 */
export function computeStats(
  signals: ReadonlyArray<Signal>,
  lotSize: number,
  startingBalance: number,
  markPrice: number | null,
): StrategyStats {
  const closedTrades: ClosedTrade[] = []
  let openTrade: OpenTrade | null = null

  const labeled = signals.some((s) => s.label !== undefined)

  if (labeled) {
    const entryByLabel = new Map<string, Signal>()
    for (const s of signals) {
      if (s.label === undefined) continue
      if (s.side === 'sell' && s.sl !== undefined && s.tp !== undefined) {
        entryByLabel.set(s.label, s)
        continue
      }
      if (s.side === 'buy') {
        const entry = entryByLabel.get(s.label)
        if (!entry || entry.sl === undefined) continue
        const side: TradeSide = 'short'
        const rDistance = Math.abs(entry.sl - entry.price)
        const rMultiple = rDistance > 0 ? (entry.price - s.price) / rDistance : undefined
        closedTrades.push({
          side,
          entryTime: entry.time,
          entryPrice: entry.price,
          exitTime: s.time,
          exitPrice: s.price,
          pnl: pnlOnClose(side, entry.price, s.price, lotSize),
          label: s.label,
          sl: entry.sl,
          tp: entry.tp,
          rMultiple,
          reason: s.reason,
          channelLabel: entry.channelLabel,
        })
        entryByLabel.delete(s.label)
      }
    }
    // Anything left in the map = still open. PAB only ever holds one at a
    // time; if more than one ever shows up here it means the strategy
    // emitted overlapping entries (a bug) — we still surface the most-
    // recent one as the open trade for consistency.
    for (const entry of entryByLabel.values()) {
      openTrade = {
        side: 'short',
        entryTime: entry.time,
        entryPrice: entry.price,
        label: entry.label,
        sl: entry.sl,
        tp: entry.tp,
        channelLabel: entry.channelLabel,
      }
    }
  } else {
    let open: OpenTrade | null = null
    for (const s of signals) {
      const desired: TradeSide = s.side === 'buy' ? 'long' : 'short'
      if (open) {
        closedTrades.push({
          side: open.side,
          entryTime: open.entryTime,
          entryPrice: open.entryPrice,
          exitTime: s.time,
          exitPrice: s.price,
          pnl: pnlOnClose(open.side, open.entryPrice, s.price, lotSize),
        })
      }
      open = { side: desired, entryTime: s.time, entryPrice: s.price }
    }
    openTrade = open
  }

  let realizedPnl = 0
  let wins = 0
  let losses = 0
  let sumWin = 0
  let sumLoss = 0
  for (const t of closedTrades) {
    realizedPnl += t.pnl
    if (t.pnl > 0) {
      wins += 1
      sumWin += t.pnl
    } else if (t.pnl < 0) {
      losses += 1
      sumLoss += t.pnl
    }
  }

  let unrealizedPnl = 0
  if (openTrade && markPrice !== null) {
    unrealizedPnl = pnlOnClose(openTrade.side, openTrade.entryPrice, markPrice, lotSize)
  }

  const totalTrades = closedTrades.length
  const winRate = totalTrades > 0 ? wins / totalTrades : null
  const avgWin = wins > 0 ? sumWin / wins : 0
  const avgLoss = losses > 0 ? sumLoss / losses : 0
  const equity = startingBalance + realizedPnl + unrealizedPnl

  return {
    closedTrades,
    openTrade,
    realizedPnl,
    unrealizedPnl,
    totalTrades,
    wins,
    losses,
    winRate,
    avgWin,
    avgLoss,
    equity,
  }
}
