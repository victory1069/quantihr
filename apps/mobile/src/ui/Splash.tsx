/**
 * Launch screen.
 *
 * Held for a minimum duration even when the session restores instantly. A
 * loader that flashes for 80ms reads as a glitch, not as polish — below roughly
 * 400ms the eye registers a flicker rather than a transition. It then fades out
 * over the app rather than cutting, so the first frame of content arrives
 * already composed.
 *
 * `expo-splash-screen` is not installed, so this is a React overlay: the native
 * splash still covers the very first frames, and this takes over from there.
 */

import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, StyleSheet, Text, View } from 'react-native'
import { LogoLoader } from './Logo'
import { colour, font, motion, space } from './theme'

export function Splash({
  visible,
  message,
}: {
  visible: boolean
  message?: string
}) {
  const [mounted, setMounted] = useState(true)
  const fade = useRef(new Animated.Value(1)).current
  const lift = useRef(new Animated.Value(0)).current
  const shownAt = useRef(Date.now())

  useEffect(() => {
    if (visible) return

    const elapsed = Date.now() - shownAt.current
    const wait = Math.max(0, motion.splashMin - elapsed)

    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(fade, {
          toValue: 0,
          duration: motion.slow,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        // A small upward drift makes the dismissal feel like the screen is
        // getting out of the way rather than simply disappearing.
        Animated.timing(lift, {
          toValue: -24,
          duration: motion.slow,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setMounted(false)
      })
    }, wait)

    return () => clearTimeout(timer)
  }, [visible, fade, lift])

  if (!mounted) return null

  return (
    <Animated.View
      pointerEvents={visible ? 'auto' : 'none'}
      style={[styles.overlay, { opacity: fade }]}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading Quanti HR"
    >
      <Animated.View style={{ alignItems: 'center', transform: [{ translateY: lift }] }}>
        <LogoLoader size={104} />
        <Text style={styles.wordmark}>Quanti</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </Animated.View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colour.bg,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  },
  wordmark: {
    marginTop: space.xl,
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
  },
  message: {
    marginTop: space.sm,
    fontSize: font.size.sm,
    color: colour.textFaint,
    fontFamily: font.family,
  },
})
