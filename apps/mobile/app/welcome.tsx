/**
 * Welcome — screen L2.
 *
 * The app arrives unannounced: an employer added someone to a payroll system
 * and a link appeared. So the employer's name leads, before anything is asked
 * for. Until the user recognises who sent this, every subsequent request reads
 * as phishing.
 *
 * The three numbered steps set an expectation of length. "About two minutes"
 * plus a visible count is what stops the drop-off at step two.
 */

import { useEffect, useRef } from 'react'
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '../src/ui/components'
import { Avatar, Figure } from '../src/ui/primitives'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from '../src/ui/theme'
import { useInvite } from '../src/api/invite'

const STEPS = ['Confirm your email', 'Verify your phone number', 'Check your details are right']

export default function Welcome() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const invite = useInvite()

  const enter = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [enter])

  const orgName = invite.data?.orgName ?? 'your employer'

  return (
    <View style={styles.root}>
      <Animated.View
        style={[
          styles.column,
          {
            paddingTop: insets.top + space.xl,
            paddingBottom: insets.bottom + space.lg,
            opacity: enter,
            transform: [
              { translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
            ],
          },
        ]}
      >
        {/* Employer identity first — this app has to prove whose it is. */}
        <View style={styles.orgPill}>
          <Avatar name={orgName} size={30} />
          <Text style={styles.orgName}>{orgName}</Text>
        </View>

        <Text style={styles.title}>You&apos;ve been invited to Quanti</Text>
        <Text style={styles.lede}>
          Your payslips, leave balance and HR answers, in one place. Setup takes about two
          minutes.
        </Text>

        <View style={styles.steps}>
          {STEPS.map((label, i) => (
            <View key={label} style={styles.step}>
              <Figure size="sm" tone="primary">
                {String(i + 1).padStart(2, '0')}
              </Figure>
              <Text style={styles.stepLabel}>{label}</Text>
            </View>
          ))}
        </View>

        <View style={styles.spacer} />

        <Button label="Get started" onPress={() => router.push('/onboarding')} />

        <Pressable
          onPress={() => router.push('/sign-in')}
          accessibilityRole="link"
          style={styles.altRow}
          hitSlop={8}
        >
          <Text style={styles.altText}>
            Already set up on another phone? <Text style={styles.altLink}>Sign in</Text>
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colour.bg },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    paddingHorizontal: space.lg,
    gap: space.lg,
  },
  spacer: { flex: 1, minHeight: space.lg },

  orgPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    paddingLeft: 5,
    paddingRight: space.lg,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colour.border,
    backgroundColor: colour.surface,
  },
  orgName: {
    fontSize: font.size.md,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
  },

  title: {
    fontSize: font.size.display,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    lineHeight: 50,
    fontFamily: font.family,
  },
  lede: {
    fontSize: font.size.lg,
    color: colour.textMuted,
    lineHeight: 27,
    fontFamily: font.family,
  },

  steps: { gap: space.sm, paddingTop: space.sm },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderWidth: 1,
    borderColor: colour.border,
    borderRadius: radius.md,
    backgroundColor: colour.surface,
    paddingHorizontal: space.lg,
    minHeight: 60,
  },
  stepLabel: { fontSize: font.size.md, color: colour.text, fontFamily: font.family, flex: 1 },

  altRow: { alignItems: 'center', paddingVertical: space.sm },
  altText: { fontSize: font.size.sm, color: colour.textFaint, fontFamily: font.family },
  altLink: { color: colour.primary, fontWeight: font.weight.bold },
})
