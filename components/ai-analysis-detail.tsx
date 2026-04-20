'use client'

import { SignalDirection } from '@/lib/types'
import { BrainCircuit } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AIResult {
  model: string
  signal: SignalDirection
  confidence: number
  rationale: string
  trueProbabilityYes: number
  edge: number
}

interface AI AnalysisDetailProps {
  analyses: AIResult[]
  className?: string
}

export function AI AnalysisDetail({ analyses, className }: AI AnalysisDetailProps) {
  return (
    <div className={cn('space-y-3 p-4 bg-card border rounded-lg', className)}>
      <div className="flex items-center gap-2 mb-3">
        <BrainCircuit className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">AI Analysis Details</h3>
      </div>
      <div className="space-y-2">
        {analyses.map((analysis, i) => (
          <div key={i} className="p-3 bg-secondary/50 rounded-md">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-mono text-primary">{analysis.model.toUpperCase()}</span>
              <span className={cn(
                'px-2 py-0.5 text-xs font-semibold rounded-full',
                analysis.signal === 'BUY' ? 'bg-profit text-profit-foreground' :
                analysis.signal === 'SELL' ? 'bg-loss text-loss-foreground' :
                'bg-muted text-muted-foreground'
              )}>
                {analysis.signal}
              </span>
              <span className="text-xs font-mono">{analysis.confidence.toFixed(0)}%</span>
            </div>
            <p className="text-xs text-foreground leading-relaxed">{analysis.rationale}</p>
            <div className="grid grid-cols-2 gap-2 mt-2 text-xs text-muted-foreground">
              <div>True Prob YES: {(analysis.trueProbabilityYes * 100).toFixed(1)}%</div>
              <div>Edge: {analysis.edge.toFixed(1)}%</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

