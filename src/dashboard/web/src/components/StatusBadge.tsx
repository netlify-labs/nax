// A run/agent status Badge with the shared run-status class, color, and style.
// Callers pass the label (their own status-label fn) and any Badge size/width.
import { Badge, type BadgeProps } from '@mantine/core'
import type { ReactNode } from 'react'

import { statusBadgeStyle, statusColor } from '../run-format'
import { statusKey } from '../status-model'

export function StatusBadge({ status, label, ...rest }: { status: string; label: ReactNode } & BadgeProps) {
  return (
    <Badge
      {...rest}
      className={`run-status ${statusKey(status)}`}
      variant="light"
      color={statusColor(status)}
      style={statusBadgeStyle(status)}
    >
      {label}
    </Badge>
  )
}
