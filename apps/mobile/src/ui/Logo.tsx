/**
 * The Quanti mark, drawn with Views.
 *
 * A rounded-square ring with a diagonal tail — a Q, in the geometry of the
 * 2026 brand. `react-native-svg` is not installed and is not needed: the ring
 * is a border and a corner radius, the tail is a rotated rounded bar, and the
 * gap where the tail leaves the ring is a small patch in the ground colour.
 * Building it this way also makes each part independently animatable, which is
 * what the loader below relies on.
 *
 * Proportions are taken from the supplied 480-unit icon and scaled.
 */

import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View, type ViewStyle } from 'react-native'
import { colour } from './theme'

const VIEWBOX = 480

/** Ring bounds and stroke, in the 480-unit space. */
const RING = { left: 30, top: 30, size: 420, stroke: 62, radius: 168 }
/** The tail: a rounded bar from the ring's inner corner out past the edge. */
const TAIL = { x: 300, y: 300, length: 188, thickness: 62 }
/** The notch in the ring the tail passes through. */
const NOTCH = { x: 322, y: 322, size: 130 }

export interface LogoProps {
  size?: number
  /** Ring colour. */
  dotColour?: string
  /** Tail colour. */
  barColour?: string
  /**
   * Unused since the notch became a true cut-out; kept so call sites that
   * matched it to their surface keep compiling. The mark now sits on anything.
   */
  ground?: string
  style?: ViewStyle
}

/**
 * The ring, drawn twice inside two clipping boxes that together cover the
 * whole mark except the notch. A painted notch only ever matched one
 * background; a clipped one is transparent over a photo, a gradient or the
 * drifting colour on sign-in.
 */
function Ring({ k, colourValue }: { k: number; colourValue: string }) {
  const full = VIEWBOX * k
  const nx = NOTCH.x * k
  const ny = NOTCH.y * k
  const ring = (dx: number, dy: number) => (
    <View
      style={{
        position: 'absolute',
        left: RING.left * k - dx,
        top: RING.top * k - dy,
        width: RING.size * k,
        height: RING.size * k,
        borderRadius: RING.radius * k,
        borderWidth: RING.stroke * k,
        borderColor: colourValue,
      }}
    />
  )
  return (
    <>
      {/* Everything above the notch. */}
      <View style={{ position: 'absolute', left: 0, top: 0, width: full, height: ny, overflow: 'hidden' }}>
        {ring(0, 0)}
      </View>
      {/* Everything left of the notch, below that line. */}
      <View style={{ position: 'absolute', left: 0, top: ny, width: nx, height: full - ny, overflow: 'hidden' }}>
        {ring(0, ny)}
      </View>
    </>
  )
}

export function LogoMark({
  size = 64,
  dotColour = colour.text,
  barColour = colour.primary,
  style,
}: LogoProps) {
  const k = size / VIEWBOX

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Ring k={k} colourValue={dotColour} />
      <View
        style={{
          position: 'absolute',
          left: TAIL.x * k,
          top: TAIL.y * k,
          width: TAIL.length * k,
          height: TAIL.thickness * k,
          borderRadius: (TAIL.thickness / 2) * k,
          backgroundColor: barColour,
          // Rotate about the bar's start, not its centre, so the tail leaves
          // the ring at a fixed point regardless of length.
          transform: [
            { translateX: -((TAIL.length * k) / 2) },
            { translateY: -((TAIL.thickness * k) / 2) },
            { rotate: '45deg' },
            { translateX: (TAIL.length * k) / 2 },
            { translateY: (TAIL.thickness * k) / 2 },
          ],
        }}
      />
    </View>
  )
}

/**
 * The mark as a loader.
 *
 * The ring breathes and the tail sweeps once round and back, like a hand
 * settling. Transform and opacity only, so it runs on the native driver and
 * stays smooth while the JS thread is hydrating the cache — which is exactly
 * when this is on screen.
 */
export function LogoLoader({
  size = 96,
  dotColour = colour.text,
  barColour = colour.primary,
}: LogoProps) {
  const breathe = useRef(new Animated.Value(0)).current
  const sweep = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const ring = Animated.loop(
      Animated.sequence([
        Animated.timing(breathe, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(breathe, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    )
    const tail = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.delay(200),
      ]),
    )
    ring.start()
    tail.start()
    return () => {
      ring.stop()
      tail.stop()
    }
  }, [breathe, sweep])

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }),
        transform: [
          { scale: breathe.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
          {
            rotate: sweep.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }),
          },
        ],
      }}
    >
      <LogoMark size={size} dotColour={dotColour} barColour={barColour} />
    </Animated.View>
  )
}

/** Wordmark beside the mark: "Quanti" with a small superscript "HR". */
export function LogoLockup({
  size = 28,
  colourText = colour.text,
  hrColour = colour.primary,
  style,
}: {
  size?: number
  colourText?: string
  hrColour?: string
  style?: ViewStyle
}) {
  return (
    <View style={[styles.lockup, style]}>
      <LogoMark size={size} dotColour={colourText} barColour={hrColour} />
      <Animated.Text
        style={{
          fontSize: size * 0.86,
          fontWeight: '700',
          letterSpacing: -size * 0.03,
          color: colourText,
        }}
      >
        Quanti
        <Animated.Text
          style={{ fontSize: size * 0.4, fontWeight: '600', letterSpacing: 2, color: hrColour }}
        >
          {'  HR'}
        </Animated.Text>
      </Animated.Text>
    </View>
  )
}

const styles = StyleSheet.create({
  lockup: { flexDirection: 'row', alignItems: 'center', gap: 8 },
})
