// Server-owned counters; account and progress are committed together by API CAS.
// Never reconstruct counters from the capped trade log.
const definitions = [
  ['first_open', '第一筆交易', '首次成功開倉。', 1, s => s.openedTrades],
  ['first_close', '完成交易', '首次平倉（含強制平倉）。', 1, s => s.closedTrades],
  ['first_profit', '初嚐成果', '首次扣除開倉費及已付隔夜費後盈利平倉。', 1, s => s.wins],
  ['both_sides', '雙向探索', '分別體驗做多與做空。', 2, s => Number(s.longOpened > 0) + Number(s.shortOpened > 0)],
  ['three_pairs', '三對視野', '累積交易 3 種商品。', 3, s => s.pairsTraded.length],
  ['six_pairs', '六對視野', '累積交易 6 種商品。', 6, s => s.pairsTraded.length],
  ['ten_closes', '交易筆記', '累積完成 10 筆平倉。', 10, s => s.closedTrades],
  ['fifty_closes', '持續學習', '累積完成 50 筆平倉。', 50, s => s.closedTrades],
  ['low_leverage_profit', '穩健一步', '使用不超過 2 倍槓桿，扣費後盈利平倉。', 1, s => s.lowLeverageWins],
  ['long_profit', '順勢向上', '做多交易扣費後盈利平倉。', 1, s => s.longWins],
  ['short_profit', '向下有方', '做空交易扣費後盈利平倉。', 1, s => s.shortWins],
  ['five_profits', '五次成果', '累積 5 筆扣費後盈利平倉。', 5, s => s.wins],
];

export function emptyStats() {
  return {
    openedTrades: 0, closedTrades: 0, wins: 0, losses: 0, breakEvenTrades: 0,
    manualCloses: 0, liquidations: 0, grossRealizedPnl: 0, netRealizedPnl: 0,
    feesPaid: 0, closedEntryFees: 0, closedCarryPaid: 0, missingCarryCloses: 0, cashFlowPnl: 0, missingEntryFeeCloses: 0,
    longOpened: 0, shortOpened: 0, pairsTraded: [], lowLeverageWins: 0,
    longWins: 0, shortWins: 0,
  };
}

export function ensureProgress(g, now, fresh = false) {
  if (g.progress) {
    if (g.progress.version !== 1) throw new Error('Unsupported progress version');
    let changed = false;
    for (const s of [g.progress.stats, g.progress.lifetimeStats]) {
      if (s.closedCarryPaid === undefined) { s.closedCarryPaid = 0; s.missingCarryCloses = 0; changed = true; }
    }
    if (g.progress.carryAccountingSince === undefined) {
      g.progress.carryAccountingSince = now;
      g.progress.carryHistoryComplete = false;
      changed = true;
    }
    return changed;
  }
  if (!Number.isFinite(now)) throw new Error('Invalid progress clock');
  g.progress = {
    version: 1, trackingSince: now, roundStartedAt: now,
    historyComplete: fresh, carryAccountingSince: now, carryHistoryComplete: fresh, stats: emptyStats(), lifetimeStats: emptyStats(), unlocked: {},
  };
  return true;
}

function unlock(p, now) {
  // Offline catch-up may predate activation; never backdate new unlocks.
  const at = Math.max(p.trackingSince, now);
  for (const [id, , , target, value] of definitions) {
    if (p.unlocked[id] == null && value(p.lifetimeStats) >= target) p.unlocked[id] = at;
  }
}

export function recordOpen(g, pos, now) {
  ensureProgress(g, now);
  for (const s of [g.progress.stats, g.progress.lifetimeStats]) {
    s.openedTrades++;
    s[pos.side === 1 ? 'longOpened' : 'shortOpened']++;
    if (!s.pairsTraded.includes(pos.pair)) s.pairsTraded.push(pos.pair);
    s.feesPaid += pos.feePaid;
    s.cashFlowPnl = s.grossRealizedPnl - s.feesPaid;
  }
  unlock(g.progress, now);
}

export function recordClose(g, pos, pnl, reason, now) {
  ensureProgress(g, now);
  const knownFee = Number.isFinite(pos.feePaid) && pos.feePaid >= 0;
  const fee = knownFee ? pos.feePaid : 0;
  // Unversioned positions never incurred carry. A versioned position missing
  // carryPaid has unknown costs: do not award profitability achievements.
  const knownCarry = !pos.carryUnknown && (Number.isFinite(pos.carryPaid) && pos.carryPaid >= 0 || pos.executionVersion === undefined);
  const carry = Number.isFinite(pos.carryPaid) && pos.carryPaid >= 0 ? pos.carryPaid : 0;
  const net = pnl - fee - carry;
  for (const s of [g.progress.stats, g.progress.lifetimeStats]) {
    s.closedTrades++;
    s[reason === 'liquidated' ? 'liquidations' : 'manualCloses']++;
    s.grossRealizedPnl += pnl;
    s.closedEntryFees += fee;
    s.closedCarryPaid += carry;
    s.netRealizedPnl = s.grossRealizedPnl - s.closedEntryFees - s.closedCarryPaid;
    s.cashFlowPnl = s.grossRealizedPnl - s.feesPaid;
    if (!knownCarry) s.missingCarryCloses++;
    if (!knownFee) s.missingEntryFeeCloses++;
    if (!knownFee || !knownCarry) continue;
    else if (net > 1e-9) {
      s.wins++;
      s[pos.side === 1 ? 'longWins' : 'shortWins']++;
      if (pos.leverage <= 2) s.lowLeverageWins++;
    } else if (net < -1e-9) s.losses++;
    else s.breakEvenTrades++;
  }
  unlock(g.progress, now);
}

export function resetProgress(g, now) {
  ensureProgress(g, now);
  g.progress.stats = emptyStats();
  g.progress.roundStartedAt = now;
}

export function progressView(g, now) {
  ensureProgress(g, now);
  const p = g.progress;
  // Explicit allowlist; no private game or RNG state is returned.
  return {
    version: p.version, trackingSince: p.trackingSince, roundStartedAt: p.roundStartedAt,
    historyComplete: p.historyComplete,
    carryAccountingSince: p.carryAccountingSince, carryHistoryComplete: p.carryHistoryComplete,
    trackingNote: p.historyComplete
      ? '從帳戶建立起累積；本回合統計於重置時歸零，終生成就保留。'
      : '從功能啟用起處理的交易與強平累積（包含離線補算及舊持倉平倉）；不回推歷史紀錄，舊歷史不完整。',
    stats: { ...p.stats, pairsTraded: [...p.stats.pairsTraded] },
    lifetimeStats: { ...p.lifetimeStats, pairsTraded: [...p.lifetimeStats.pairsTraded] },
    resets: g.resets || 0,
    achievements: definitions.map(([id, title, description, target, value]) => ({
      id, title, description, unlockedAt: p.unlocked[id] ?? null,
      progress: Math.min(target, value(p.lifetimeStats)), target,
    })),
    feePolicy: {
      currency: 'USD',
      feesPaid: '期間成功開倉時實付的費用；平倉及強平不另收費。',
      grossRealizedPnl: '期間平倉損益，尚未扣除開倉費；包含強平。',
      netRealizedPnl: '期間平倉損益減該批持倉的已知開倉費及已付隔夜費；舊統計不回推。',
      cashFlowPnl: '期間平倉損益減期間實付開倉費；不等同已平倉淨損益。',
      missingEntryFeeCloses: '缺少開倉費的平倉筆數；其淨損益暫不扣未知費，不列入勝負或盈利成就。',
      closedCarryPaid: '已平倉對應的已付隔夜費；已從現金扣除，平倉不再扣現金。',
      missingCarryCloses: '新版執行持倉缺少隔夜費資料時不猜測成本，不列入勝負或盈利成就。',
      reset: '重置會放棄未平倉部位，不視為平倉，不補記損益；終生統計及成就保留。',
      wins: '已知開倉費與隔夜費且淨損益大於 $0.000000001 為盈利；正負此誤差內為損益兩平。',
    },
  };
}
