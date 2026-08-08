import type { DryRunOptions } from './types'

export function withCurrentBranchDefault(options: DryRunOptions, currentBranch: string): DryRunOptions {
  const branch = currentBranch.trim()
  if (!branch || options.branch.trim()) return options
  return { ...options, branch }
}
