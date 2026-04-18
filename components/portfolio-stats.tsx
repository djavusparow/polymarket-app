'use client'

import { TrendingUp, TrendingDown, Activity, Target, DollarSign, Percent } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PortfolioStats } from '@/lib/types'

interface PortfolioStatsProps {
  stats: PortfolioStats
}

export function PortfolioStatsBar({ stats }: PortfolioStatsProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
      <StatCard
        label="Total Balance"
        value={`$${stats.total_balance.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        icon={DollarSign}
        iconClass="text-primary"
      />
      <StatCard
        label="Available"
        value={`$${stats.available_balance.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        icon={DollarSign}
        iconClass="text-muted-foreground"
      />
      <StatCard
        label="Total P&L"
        value={`${stats.total_pnl >= 0 ? '+' : ''}$${stats.total_pnl.toFixed(2)}`}
        icon={stats.total_pnl >= 0 ? TrendingUp : TrendingDown}
        valueClass={stats.total_pnl >= 0 ? 'text-profit' : 'text-loss'}
        iconClass={stats.total_pnl >= 0 ? 'text-profit' : 'text-loss'}
      />
      <StatCard
        label="Today P&L"
        value={`${stats.today_pnl >= 0 ? '+' : ''}$${stats.today_pnl.toFixed(2)}`}
        icon={Activity}
        valueClass={stats.today_pnl >= 0 ? 'text-profit' : 'text-loss'}
        iconClass={stats.today_pnl >= 0 ? 'text-profit' : 'text-loss'}
      />
      <StatCard
        label="Win Rate"
        value={`${stats.win_rate.toFixed(1)}%`}
        icon={Target}
        iconClass="text-primary"
      />
      <StatCard
        label="Open Positions"
        value={String(stats.open_positions)}
        icon={Activity}
        iconClass="text-primary"
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  icon: Icon,
  valueClass = 'text-foreground',
  iconClass = 'text-primary',
}: {
  label: string
  value: string
  icon: React.ElementType
  valueClass?: string
  iconClass?: string
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Icon className={cn('w-3.5 h-3.5', iconClass)} />
      </div>
      <span className={cn('text-lg font-mono font-bold', valueClass)}>{value}</span>
    </div>
  )
}
