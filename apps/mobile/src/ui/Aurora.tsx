/**
 * Slow colour drift behind a screen.
 *
 * Three large solid discs — cyan, violet, deep teal — each on its own slow
 * loop, overlapping at low opacity so where they cross reads as a third
 * colour. No blur, no gradient library: the softness comes from each disc
 * being six concentric rings that step down in opacity, which is enough at
 * this size and speed to read as light rather than shapes.
 *
 * Everything runs on the native driver (transforms only), so the drift costs
 * nothing on the JS thread and keeps moving while the form is busy.
 */

import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, useWindowDimensions, View } from 'react-native'
import { colour } from './theme'

interface Blob {
  tint: string
  size: number
  /** Resting position as a fraction of the screen. */
  x: number
  y: number
  /** Drift amplitude in px and the loop's period in ms. */
  dx: number
  dy: number
  period: number
  opacity: number
}

const BLOBS: Blob[] = [
  { tint: colour.primary, size: 1.15, x: 0.15, y: 0.18, dx: 60, dy: 40, period: 26_000, opacity: 0.16 },
  { tint: colour.accent, size: 1.0, x: 0.85, y: 0.35, dx: -50, dy: 70, period: 31_000, opacity: 0.14 },
  { tint: '#0B6B7A', size: 1.3, x: 0.5, y: 0.95, dx: 40, dy: -60, period: 37_000, opacity: 0.22 },
]

/**
 * `intensity` scales the whole thing. Sign-in runs it at 1, where the colour
 * is the point; inside the app it runs low, a slow shift behind the sheets
 * rather than something to look at.
 */
export function Aurora({ intensity = 1 }: { intensity?: number }) {
  const { width, height } = useWindowDimensions()

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {BLOBS.map((b, i) => (
        <Disc key={i} blob={b} width={width} height={height} intensity={intensity} />
      ))}
    </View>
  )
}

function Disc({
  blob,
  width,
  height,
  intensity,
}: {
  blob: Blob
  width: number
  height: number
  intensity: number
}) {
  const t = useRef(new Animated.Value(0)).current

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, {
          toValue: 1,
          duration: blob.period,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(t, {
          toValue: 0,
          duration: blob.period,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [t, blob.period])

  const d = Math.max(width, height) * blob.size
  const left = width * blob.x - d / 2
  const top = height * blob.y - d / 2

  const translateX = t.interpolate({ inputRange: [0, 1], outputRange: [0, blob.dx] })
  const translateY = t.interpolate({ inputRange: [0, 1], outputRange: [0, blob.dy] })
  const scale = t.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] })

  // Outer to inner, each ring adding a little — a cheap soft edge.
  const rings = [1, 0.9, 0.8, 0.7, 0.6, 0.5]

  return (
    <Animated.View
      style={{
        position: 'absolute',
        left,
        top,
        width: d,
        height: d,
        transform: [{ translateX }, { translateY }, { scale }],
      }}
    >
      {rings.map((r, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: (d - d * r) / 2,
            top: (d - d * r) / 2,
            width: d * r,
            height: d * r,
            borderRadius: (d * r) / 2,
            backgroundColor: blob.tint,
            opacity: blob.opacity * 0.3 * intensity,
          }}
        />
      ))}
    </Animated.View>
  )
}
