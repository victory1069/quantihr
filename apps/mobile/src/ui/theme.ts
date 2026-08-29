/**
 * Design tokens.
 *
 * Kept as plain objects rather than Tailwind classes so the same values are
 * usable from StyleSheet, inline styles and the chart-free summary views
 * without a build step. Colours carry semantic names, not visual ones, so a
 * palette change does not mean a find-and-replace across every screen.
 */

import { Platform } from 'react-native'

export const colour = {
  bg: '#F8FAFC',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F5F9',
  border: '#E2E8F0',
  borderStrong: '#CBD5E1',

  text: '#0F172A',
  textMuted: '#64748B',
  textFaint: '#94A3B8',
  textInverse: '#FFFFFF',

  primary: '#1D4ED8',
  primaryDark: '#1E40AF',
  primarySoft: '#EFF6FF',

  success: '#047857',
  successSoft: '#ECFDF5',
  warning: '#B45309',
  warningSoft: '#FFFBEB',
  danger: '#B91C1C',
  dangerSoft: '#FEF2F2',
  info: '#0369A1',
  infoSoft: '#F0F9FF',

  // Status colours for attendance and leave, resolved once here.
  present: '#047857',
  late: '#B45309',
  absent: '#B91C1C',
  pending: '#7C3AED',
} as const

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const

export const font = {
  size: { xs: 12, sm: 13, md: 15, lg: 17, xl: 20, xxl: 28, display: 40 },
  weight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
} as const

export const shadow = Platform.select({
  ios: {
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  android: { elevation: 2 },
  default: {
    // react-native-web understands boxShadow.
    boxShadow: '0 4px 12px rgba(15, 23, 42, 0.06)',
  },
}) as object

/** Web preview reads better with a bounded column than an edge-to-edge stretch. */
export const MAX_CONTENT_WIDTH = 720

export function statusColour(status: string): string {
  switch (status) {
    case 'present':
    case 'approved':
      return colour.success
    case 'late':
      return colour.warning
    case 'absent':
    case 'rejected':
    case 'declined':
      return colour.danger
    case 'pending':
    case 'pending_review':
      return colour.pending
    default:
      return colour.textMuted
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'pending_review':
      return 'Needs review'
    case 'present':
      return 'On time'
    default:
      return status.charAt(0).toUpperCase() + status.slice(1)
  }
}
