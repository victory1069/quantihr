/**
 * Design tokens — Quanti "Soft".
 *
 * Light-first and warm. The previous system was Midnight Cyan, built on
 * #06111A because the logo mark is cyan and magenta; this one deliberately
 * departs from that. Cyan cannot carry a light ground — #00D3FF on white is
 * about 1.9:1, which fails for type at any size — so rather than compromise it
 * into an unrecognisable darker teal, the interface palette is re-pitched
 * around indigo and coral and the brand hues are retained for the mark alone.
 *
 * **Two palettes, one shape.** `light` and `dark` carry identical keys, so a
 * screen never branches on scheme — it asks for `c.surface` and gets the right
 * one. Dark here is warm-neutral rather than navy, to stay in the same family
 * as the light ground rather than reading as the old system.
 *
 * **Why a hook and not a constant.** `StyleSheet.create` captures its values at
 * import time, so a module-level colour object can never follow the system
 * setting — it would need an app restart. Colour therefore comes from
 * `useColour()`, while spacing, radii and type stay static exports because they
 * do not vary by scheme. The practical rule in a screen: layout in
 * `StyleSheet.create`, colour inline.
 *
 * Colours carry semantic names, never visual ones. `c.primary`, not `c.indigo`
 * — the accent moves, the meaning does not.
 */

import { Platform, useColorScheme } from 'react-native'

/**
 * Raw brand values, kept for the logo and splash only.
 *
 * Nothing in the interface should reference these directly — they exist so the
 * mark renders correctly, not to be borrowed as UI colour.
 */
export const brand = {
  deep: '#06111A',
  cyan: '#00D3FF',
  magenta: '#FF3D8A',
  frost: '#EAF4F8',
  teal: '#0089B8',
  violet: '#7B5CFF',
} as const

export interface Palette {
  bg: string
  surface: string
  surfaceRaised: string
  surfaceSunken: string
  border: string
  borderStrong: string

  text: string
  textMuted: string
  textFaint: string
  textInverse: string

  primary: string
  primaryText: string
  primarySoft: string
  primaryBorder: string

  accent: string
  accentSoft: string

  success: string
  successSoft: string
  warning: string
  warningSoft: string
  danger: string
  dangerSoft: string
  info: string
  infoSoft: string

  present: string
  late: string
  absent: string
  pending: string
  pendingSoft: string

  /** Skeleton base and its moving highlight. */
  skeleton: string
  skeletonHighlight: string
  /** Scrim behind sheets and modals. */
  scrim: string
}

const light: Palette = {
  // A warm off-white rather than pure white: #FFFFFF under a phone's auto
  // brightness in daylight is genuinely fatiguing, and the warmth is what
  // separates this from every fintech dashboard.
  bg: '#FDFCFA',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#F5F2EE',
  border: '#EAE5DF',
  borderStrong: '#D9D2CA',

  text: '#1C1B1A',
  textMuted: '#6E6A66',
  textFaint: '#9A948E',
  textInverse: '#FFFFFF',

  primary: '#5B4BE8',
  primaryText: '#FFFFFF',
  primarySoft: 'rgba(91, 75, 232, 0.10)',
  primaryBorder: 'rgba(91, 75, 232, 0.28)',

  accent: '#FF6B4A',
  accentSoft: 'rgba(255, 107, 74, 0.12)',

  success: '#12B886',
  successSoft: 'rgba(18, 184, 134, 0.12)',
  warning: '#F59F00',
  warningSoft: 'rgba(245, 159, 0, 0.14)',
  // Distinct from `accent`. Coral and red sitting next to each other is how a
  // destructive action stops reading as destructive.
  danger: '#E03131',
  dangerSoft: 'rgba(224, 49, 49, 0.10)',
  info: '#5B4BE8',
  infoSoft: 'rgba(91, 75, 232, 0.10)',

  present: '#12B886',
  late: '#F59F00',
  absent: '#E03131',
  pending: '#5B4BE8',
  pendingSoft: 'rgba(91, 75, 232, 0.12)',

  skeleton: '#EFEBE6',
  skeletonHighlight: '#F8F6F3',
  scrim: 'rgba(28, 27, 26, 0.42)',
}

/**
 * Warm-neutral dark, not navy.
 *
 * Indigo lightens to #8B7CFF here: #5B4BE8 on a dark ground drops to roughly
 * 3:1, which is under the bar for body text and looks muddy besides.
 */
const dark: Palette = {
  bg: '#16151A',
  surface: '#1F1E24',
  surfaceRaised: '#26252C',
  surfaceSunken: '#101015',
  border: '#302E38',
  borderStrong: '#423F4C',

  text: '#F5F3F0',
  textMuted: '#A5A0AA',
  textFaint: '#77727E',
  textInverse: '#16151A',

  primary: '#8B7CFF',
  primaryText: '#16151A',
  primarySoft: 'rgba(139, 124, 255, 0.16)',
  primaryBorder: 'rgba(139, 124, 255, 0.36)',

  accent: '#FF8A6B',
  accentSoft: 'rgba(255, 138, 107, 0.16)',

  success: '#2FD69B',
  successSoft: 'rgba(47, 214, 155, 0.16)',
  warning: '#FFB020',
  warningSoft: 'rgba(255, 176, 32, 0.16)',
  danger: '#FF6B6B',
  dangerSoft: 'rgba(255, 107, 107, 0.16)',
  info: '#8B7CFF',
  infoSoft: 'rgba(139, 124, 255, 0.16)',

  present: '#2FD69B',
  late: '#FFB020',
  absent: '#FF6B6B',
  pending: '#8B7CFF',
  pendingSoft: 'rgba(139, 124, 255, 0.18)',

  skeleton: '#272630',
  skeletonHighlight: '#32313C',
  scrim: 'rgba(0, 0, 0, 0.58)',
}

export const palettes = { light, dark } as const
export type Scheme = keyof typeof palettes

/**
 * Dark mode is built but not yet switched on.
 *
 * Following the system appearance only works once *every* screen reads its
 * colour through `useColour()`. While some screens still use the static
 * `colour` export below, a dark system setting produces a genuinely broken
 * page — migrated components go dark while the ground, headings and inputs
 * around them stay light, which is worse than not offering dark at all.
 *
 * So the switch is held here, in one place, rather than shipping a half-dark
 * app. Flip this to `true` once the migration is finished; both palettes and
 * every shared component are already correct.
 */
const FOLLOW_SYSTEM_APPEARANCE = false

/**
 * The palette for the current system appearance.
 *
 * There is no in-app toggle by design: the phone already has one, and an app
 * that disagrees with the system setting is an app people notice for the wrong
 * reason. `useColorScheme` returns null before the OS reports, so light wins
 * the first frame rather than flashing dark.
 */
export function useColour(): Palette {
  return palettes[useScheme()]
}

export function useScheme(): Scheme {
  const system = useColorScheme()
  if (!FOLLOW_SYSTEM_APPEARANCE) return 'light'
  return system === 'dark' ? 'dark' : 'light'
}

/**
 * The light palette as a plain object.
 *
 * For module-scope `StyleSheet.create` where a hook cannot reach, and for the
 * handful of places that are light-only regardless (the splash, which runs
 * before React has mounted anything). Anything a user can look at in dark mode
 * must use `useColour()` instead.
 */
export const colour = light

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

/**
 * Every figure in the product is set in mono: balances, money, timestamps,
 * countdowns, "12 of 12".
 *
 * Two reasons, both practical. Tabular figures align down a column, so a list
 * of payslip amounts can be scanned rather than read. And mono visually marks
 * a value as *recorded data* rather than prose — which matters in a product
 * whose numbers end up in disciplinary and payroll decisions.
 */
const MONO = Platform.select({
  web: "'Space Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  ios: 'Menlo',
  default: 'monospace',
})

export const font = {
  family: FAMILY,
  mono: MONO,
  size: { xs: 12, sm: 13, md: 15, lg: 18, xl: 22, xxl: 30, display: 44, hero: 56 },
  weight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },
  /** Space Grotesk is set tight; matching that keeps the fallback on-brand. */
  tracking: { tight: -1.2, snug: -0.4, normal: 0, wide: 0.6, label: 1.6 },
} as const

/**
 * Shadow, by scheme.
 *
 * The old system used a cyan glow because a near-black ground swallows a
 * conventional shadow. On a light ground the opposite is true: a real, soft,
 * neutral shadow is what makes a card read as lifted, and a glow would look
 * like an error state. Dark mode drops back to almost no shadow and leans on
 * the border instead, because shadow on a dark ground is mostly invisible
 * effort.
 */
export function shadow(scheme: Scheme = 'light') {
  if (scheme === 'dark') {
    return {
      card: Platform.select({
        ios: {
          shadowColor: '#000',
          shadowOpacity: 0.4,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
        },
        android: { elevation: 2 },
        default: { boxShadow: '0 4px 14px rgba(0,0,0,0.4)' },
      }) as object,
      lifted: Platform.select({
        ios: {
          shadowColor: '#000',
          shadowOpacity: 0.5,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 10 },
        },
        android: { elevation: 6 },
        default: { boxShadow: '0 10px 28px rgba(0,0,0,0.5)' },
      }) as object,
    }
  }

  return {
    card: Platform.select({
      ios: {
        shadowColor: '#2B211A',
        shadowOpacity: 0.06,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 4 },
      },
      android: { elevation: 2 },
      default: { boxShadow: '0 4px 14px rgba(43,33,26,0.06)' },
    }) as object,
    lifted: Platform.select({
      ios: {
        shadowColor: '#2B211A',
        shadowOpacity: 0.12,
        shadowRadius: 26,
        shadowOffset: { width: 0, height: 12 },
      },
      android: { elevation: 8 },
      default: { boxShadow: '0 12px 32px rgba(43,33,26,0.12)' },
    }) as object,
  }
}

/** Back-compat for screens not yet migrated off the static export. */
export const elevation = {
  card: shadow('light').card,
  glow: shadow('light').lifted,
} as const

/**
 * Motion.
 *
 * Short and eased — fluid means quick and continuous, not slow. `stagger` is
 * the gap between consecutive items in an entering list; past about 8 items the
 * caller should clamp the index, or the last card arrives after the user has
 * already started reading.
 */
export const motion = {
  fast: 140,
  base: 220,
  slow: 380,
  splashMin: 900,
  stagger: 45,
  /** Items beyond this enter together — nobody waits through a long cascade. */
  staggerCap: 8,

  /** Press feedback: tight, no overshoot. A button is not a toy. */
  press: { speed: 40, bounciness: 0 },
  /** Entrances: a little overshoot reads as responsive rather than mechanical. */
  enter: { speed: 14, bounciness: 6 },
  /** Counters and meters settling on a value. */
  settle: { speed: 12, bounciness: 0 },
} as const

export const MAX_CONTENT_WIDTH = 560

export function statusColour(status: string, c: Palette = light): string {
  switch (status) {
    case 'present':
    case 'approved':
    case 'paid':
    case 'confirmed':
    case 'done':
      return c.success
    case 'late':
      return c.warning
    case 'absent':
    case 'rejected':
    case 'declined':
      return c.danger
    case 'pending':
    case 'pending_review':
    case 'pending_approval':
    case 'draft':
      return c.pending
    default:
      return c.textMuted
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
