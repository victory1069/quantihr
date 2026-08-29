/**
 * The Quanti mark, drawn with Views.
 *
 * `react-native-svg` is not installed, and it turns out not to be needed: the
 * mark is eight circles on a ring plus one rounded bar, which are a border
 * radius and a rotation. Building it this way also means each dot is an
 * independently animatable node, which is what makes the loader below possible.
 *
 * Geometry is copied from the supplied SVG (64×64 viewBox) and scaled, so the
 * app icon and the in-app mark stay identical.
 */

import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View, type ViewStyle } from 'react-native'
import { colour } from './theme'

/** Dot centres from the source SVG, in its 64-unit space. */
const DOTS = [
  { x: 32, y: 10 },
  { x: 48, y: 18 },
  { x: 54, y: 34 },
  { x: 46, y: 49 },
  { x: 30, y: 54 },
  { x: 15, y: 46 },
  { x: 10, y: 30 },
  { x: 17, y: 15 },
] as const

const VIEWBOX = 64
const DOT_R = 5
const BAR_W = 22
const BAR_H = 9

export interface LogoProps {
  size?: number
  dotColour?: string
  barColour?: string
  style?: ViewStyle
}

export function LogoMark({
  size = 64,
  dotColour = colour.primary,
  barColour = colour.accent,
  style,
}: LogoProps) {
  const k = size / VIEWBOX

  return (
    <View style={[{ width: size, height: size }, style]}>
      {DOTS.map((d, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: (d.x - DOT_R) * k,
            top: (d.y - DOT_R) * k,
            width: DOT_R * 2 * k,
            height: DOT_R * 2 * k,
            borderRadius: DOT_R * k,
            backgroundColor: dotColour,
          }}
        />
      ))}
      <View
        style={{
          position: 'absolute',
          left: 38 * k,
          top: 38 * k,
          width: BAR_W * k,
          height: BAR_H * k,
          borderRadius: (BAR_H / 2) * k,
          backgroundColor: barColour,
          // The source SVG rotates about its top-left corner, not its centre.
          transform: [
            { translateX: -((BAR_W * k) / 2) },
            { translateY: -((BAR_H * k) / 2) },
            { rotate: '45deg' },
            { translateX: (BAR_W * k) / 2 },
            { translateY: (BAR_H * k) / 2 },
          ],
        }}
      />
    </View>
  )
}

/**
 * The mark as a loader.
 *
 * The bar sweeps like a clock hand while the dots brighten in sequence just
 * ahead of it. Both run on the native driver (transform and opacity only), so
 * the animation stays smooth even while the JS thread is busy hydrating the
 * cache — which is exactly when this is on screen.
 */
export function LogoLoader({
  size = 96,
  dotColour = colour.primary,
  barColour = colour.accent,
}: LogoProps) {
  const k = size / VIEWBOX
  const spin = useRef(new Animated.Value(0)).current
  const pulses = useRef(DOTS.map(() => new Animated.Value(0.25))).current

  useEffect(() => {
    const rotation = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1600,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    )

    // Each dot lights slightly after the one before it, so the ring reads as a
    // travelling wave rather than eight independent blinks.
    const wave = Animated.loop(
      Animated.stagger(
        110,
        pulses.map((value) =>
          Animated.sequence([
            Animated.timing(value, {
              toValue: 1,
              duration: 260,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true,
            }),
            Animated.timing(value, {
              toValue: 0.25,
              duration: 520,
              easing: Easing.in(Easing.quad),
              useNativeDriver: true,
            }),
          ]),
        ),
      ),
    )

    rotation.start()
    wave.start()
    return () => {
      rotation.stop()
      wave.stop()
    }
  }, [spin, pulses])

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['45deg', '405deg'],
  })

  return (
    <View style={{ width: size, height: size }}>
      {DOTS.map((d, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            left: (d.x - DOT_R) * k,
            top: (d.y - DOT_R) * k,
            width: DOT_R * 2 * k,
            height: DOT_R * 2 * k,
            borderRadius: DOT_R * k,
            backgroundColor: dotColour,
            opacity: pulses[i],
            transform: [
              {
                scale: pulses[i]!.interpolate({
                  inputRange: [0.25, 1],
                  outputRange: [0.82, 1.12],
                }),
              },
            ],
          }}
        />
      ))}

      {/* Rotates about the ring centre, so the bar sweeps rather than wobbles. */}
      <Animated.View
        style={{
          position: 'absolute',
          left: size / 2,
          top: size / 2 - (BAR_H * k) / 2,
          width: BAR_W * k,
          height: BAR_H * k,
          borderRadius: (BAR_H / 2) * k,
          backgroundColor: barColour,
          transformOrigin: 'left center',
          transform: [{ rotate }],
        }}
      />
    </View>
  )
}

/** Horizontal lockup: mark plus wordmark. */
export function LogoLockup({
  size = 34,
  tint = colour.text,
}: {
  size?: number
  tint?: string
}) {
  return (
    <View style={styles.lockup}>
      <LogoMark size={size} />
      <Animated.Text style={[styles.wordmark, { color: tint, fontSize: size * 0.82 }]}>
        Quanti
      </Animated.Text>
    </View>
  )
}

const styles = StyleSheet.create({
  lockup: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  wordmark: { fontWeight: '700', letterSpacing: -1.2 },
})
