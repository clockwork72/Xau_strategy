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
}

export interface OpenTrade {
  side: TradeSide
  entryTime: UTCTimestamp
  entryPrice: number
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
 * Treat consecutive opposite signals as one closed trade (entry → exit at
 * the next signal's price). The last unmatched signal becomes the open
 * position; its unrealized PnL marks to the provided markPrice.
 */
export function computeStats(
  signals: ReadonlyArray<Signal>,
  lotSize: number,
  startingBalance: number,
  markPrice: number | null,
): StrategyStats {
  const closedTrades: ClosedTrade[] = []
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
  if (open && markPrice !== null) {
    unrealizedPnl = pnlOnClose(open.side, open.entryPrice, markPrice, lotSize)
  }

  const totalTrades = closedTrades.length
  const winRate = totalTrades > 0 ? wins / totalTrades : null
  const avgWin = wins > 0 ? sumWin / wins : 0
  const avgLoss = losses > 0 ? sumLoss / losses : 0
  const equity = startingBalance + realizedPnl + unrealizedPnl

  return {
    closedTrades,
    openTrade: open,
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
