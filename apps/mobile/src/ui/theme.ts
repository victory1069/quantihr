/**
 * Design tokens — Quanti brand.
 *
 * Dark-first, because the brand mark is cyan and magenta on #06111A and those
 * hues go muddy on white. The palette below is taken directly from the supplied
 * logo pack rather than approximated.
 *
 * Colours carry semantic names, never visual ones. `colour.primary`, not
 * `colour.cyan` — the accent moves, the meaning does not.
 */

import { Platform } from 'react-native'

/** Raw brand values. Only `colour` below should be referenced from screens. */
export const brand = {
  deep: '#06111A',
  cyan: '#00D3FF',
  magenta: '#FF3D8A',
  frost: '#EAF4F8',
  teal: '#0089B8',
  violet: '#7B5CFF',
} as const

export const colour = {
  // Ground and elevation. Each step is a deliberate lift, not a gradient.
  bg: brand.deep,
  surface: '#0D1D28',
  surfaceRaised: '#132634',
  surfaceSunken: '#040C13',
  border: '#1C3242',
  borderStrong: '#2A4759',

  text: brand.frost,
  textMuted: '#8CA7B8',
  textFaint: '#5C7688',
  textInverse: brand.deep,

  primary: brand.cyan,
  primaryText: brand.deep,
  primarySoft: 'rgba(0, 211, 255, 0.12)',
  primaryBorder: 'rgba(0, 211, 255, 0.35)',

  accent: brand.magenta,
  accentSoft: 'rgba(255, 61, 138, 0.12)',

  success: '#3DDC97',
  successSoft: 'rgba(61, 220, 151, 0.12)',
  warning: '#FFB020',
  warningSoft: 'rgba(255, 176, 32, 0.12)',
  danger: brand.magenta,
  dangerSoft: 'rgba(255, 61, 138, 0.12)',
  info: brand.cyan,
  infoSoft: 'rgba(0, 211, 255, 0.12)',

  // Attendance and leave statuses.
  present: '#3DDC97',
  late: '#FFB020',
  absent: brand.magenta,
  pending: brand.violet,
  pendingSoft: 'rgba(123, 92, 255, 0.14)',
} as const

/**
 * 4pt scale. `lg` is the default gap between unrelated blocks and `md` inside
 * a block — keeping those two distinct is most of what makes a layout breathe.
 */
export const space = {
  xs: 4,
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  xxl: 40,
  xxxl: 56,
} as const

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const

/**
 * Space Grotesk is the brand face. The font file is not vendored yet, so this
 * stack names it first and degrades to the platform grotesque. On web it picks
 * up a locally installed copy; bundling the woff2/ttf via expo-font is the
 * follow-up once there is network.
 */
const FAMILY = Platform.select({
  web: "'Space Grotesk', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  ios: 'System',
  default: 'sans-serif',
})

export const font = {
  family: FAMILY,
  size: { xs: 12, sm: 13, md: 15, lg: 18, xl: 22, xxl: 30, display: 44, hero: 56 },
  weight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  /** Space Grotesk is set tight; matching that keeps the fallback on-brand. */
  tracking: { tight: -1.2, snug: -0.4, normal: 0, wide: 0.6 },
} as const

/** Glow rather than drop-shadow — a dark ground swallows conventional shadows. */
export const elevation = {
  card: Platform.select({
    ios: {
      shadowColor: '#000',
      shadowOpacity: 0.35,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 4 },
    default: { boxShadow: '0 8px 24px rgba(0,0,0,0.35)' },
  }) as object,

  glow: Platform.select({
    ios: {
      shadowColor: brand.cyan,
      shadowOpacity: 0.45,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 0 },
    },
    android: { elevation: 8 },
    default: { boxShadow: '0 0 28px rgba(0,211,255,0.35)' },
  }) as object,
} as const

/** Motion. Short and eased — fluid means quick and continuous, not slow. */
export const motion = {
  fast: 140,
  base: 220,
  slow: 380,
  splashMin: 900,
} as const

export const MAX_CONTENT_WIDTH = 560

export function statusColour(status: string): string {
  switch (status) {
    case 'present':
    case 'approved':
    case 'paid':
      return colour.success
    case 'late':
      return colour.warning
    case 'absent':
    case 'rejected':
    case 'declined':
      return colour.danger
    case 'pending':
    case 'pending_review':
    case 'pending_approval':
      return colour.pending
    default:
      return colour.textMuted
  }
}

export function statusLabel(status: string): string {
  switch (status) {
    case 'pending_review':
      return 'Needs review'
    case 'pending_approval':
      return 'Awaiting approval'
    case 'present':
      return 'On time'
    default:
      return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ')
  }
}
