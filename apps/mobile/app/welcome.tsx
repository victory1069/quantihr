/**
 * First run.
 *
 * Four steps, and each one exists because skipping it causes a specific problem
 * later:
 *
 *  1. **Who you are** — a magic link proves control of an inbox, not identity.
 *     Showing the employee record catches a wrong link or a stale account before
 *     someone checks in as the wrong person.
 *  2. **This device** — the phone has just been bound for attendance
 *     verification, and changing it needs HR approval. An employee who is not
 *     told discovers it when a check-in is flagged, which reads as the product
 *     accusing them. Spec §16 names surveillance-feel as risk one; this is the
 *     cheapest place to be straight about it.
 *  3. **Biometrics** — gates pay and documents. Asked here rather than at the
 *     moment someone opens a payslip in front of a colleague.
 *  4. **Notifications** — push is the primary entry point (spec §12), not the
 *     launcher icon. An employee who declines here effectively opts out of the
 *     product working.
 *
 * Every step is skippable and nothing here blocks entry. An onboarding that
 * traps someone on step three is worse than one they ignore.
 */

import { useEffect, useRef, useState } from 'react'
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button, Card, ErrorNotice } from '../src/ui/components'
import { Avatar, DataRow, Label } from '../src/ui/primitives'
import { LogoMark } from '../src/ui/Logo'
import { Icon } from '../src/ui/Icon'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from '../src/ui/theme'
import { useMe, useUpdateMe } from '../src/api/queries'
import { setOnboarded, useSession } from '../src/store/session'
import { authenticate } from '../src/ui/BiometricGate'

const STEPS = ['You', 'This device', 'Unlock', 'Alerts'] as const

export default function Welcome() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const me = useMe()
  const update = useUpdateMe()
  const deviceReview = useSession((s) => s.deviceReviewRequired)

  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const finish = async () => {
    await setOnboarded()
    router.replace('/')
  }

  const next = () => {
    setNotice(null)
    if (step === STEPS.length - 1) void finish()
    else setStep((s) => s + 1)
  }

  return (
    <View style={styles.root}>
      <View
        style={[
          styles.column,
          { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.lg },
        ]}
      >
        <View style={styles.head}>
          <LogoMark size={30} />
          <Stepper index={step} />
        </View>

        <StepBody key={step}>
          {step === 0 ? (
            <IdentityStep me={me.data} />
          ) : step === 1 ? (
            <DeviceStep review={deviceReview} />
          ) : step === 2 ? (
            <BiometricStep
              busy={busy}
              onEnable={async () => {
                setBusy(true)
                setNotice(null)
                try {
                  const ok = await authenticate('Enable unlock for Quanti')
                  if (!ok) {
                    setNotice('Unlock was cancelled. You can turn it on later under Me.')
                    return
                  }
                  await update.mutateAsync({ biometricEnabled: true })
                  next()
                } catch {
                  setNotice('This device could not enable biometric unlock.')
                } finally {
                  setBusy(false)
                }
              }}
            />
          ) : (
            <NotificationStep
              busy={busy}
              onEnable={async () => {
                setBusy(true)
                setNotice(null)
                try {
                  if (Platform.OS === 'web') {
                    setNotice('Push notifications are only available on the phone app.')
                  } else {
                    const Notifications = await import('expo-notifications')
                    const { status } = await Notifications.requestPermissionsAsync()
                    if (status !== 'granted') {
                      setNotice(
                        'Notifications are off. Quanti will still work, but you will need to open it to see approvals and payslips.',
                      )
                      return
                    }
                  }
                  void finish()
                } catch {
                  setNotice('Could not request notification permission on this device.')
                } finally {
                  setBusy(false)
                }
              }}
            />
          )}
        </StepBody>

        {notice ? <ErrorNotice tone="warning" message={notice} /> : null}

        <View style={styles.actions}>
          {step === 0 || step === 1 ? (
            <Button label="Continue" onPress={next} />
          ) : null}

          <Button
            label={step === STEPS.length - 1 ? 'Skip and finish' : 'Skip this'}
            variant="ghost"
            onPress={step === STEPS.length - 1 ? () => void finish() : next}
          />
        </View>
      </View>
    </View>
  )
}

/** Cross-fades and slides each step so the flow reads as one moving surface. */
function StepBody({ children }: { children: React.ReactNode }) {
  const enter = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(enter, {
      toValue: 1,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [enter])

  return (
    <Animated.View
      style={[
        styles.body,
        {
          opacity: enter,
          transform: [
            { translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  )
}

function Stepper({ index }: { index: number }) {
  return (
    <View style={styles.stepper} accessibilityLabel={`Step ${index + 1} of ${STEPS.length}`}>
      {STEPS.map((label, i) => (
        <View
          key={label}
          style={[
            styles.stepDot,
            i === index && styles.stepDotActive,
            i < index && styles.stepDotDone,
          ]}
        />
      ))}
    </View>
  )
}

function IdentityStep({ me }: { me: ReturnType<typeof useMe>['data'] }) {
  if (!me) {
    return (
      <Card>
        <Text style={styles.title}>Signing you in…</Text>
      </Card>
    )
  }

  const name = `${me.employee.firstName} ${me.employee.lastName}`

  return (
    <>
      <Text style={styles.title}>You&apos;re in, {me.employee.firstName}</Text>
      <Text style={styles.lede}>
        Check this is you. If anything is wrong, tell HR before you start using the app —
        these details drive your leave and your pay.
      </Text>

      <Card>
        <View style={styles.identity}>
          <Avatar name={name} size={52} colour={colour.primary} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.name}>{name}</Text>
            <Text style={styles.role}>{me.employee.jobTitle ?? 'Employee'}</Text>
          </View>
        </View>

        <View style={styles.data}>
          <DataRow label="Employee number" value={me.employee.employeeNumber} />
          <DataRow label="Department" value={me.employee.departmentName ?? '—'} mono={false} />
          <DataRow label="Manager" value={me.employee.managerName ?? '—'} mono={false} />
          <DataRow label="Started" value={me.employee.startDate} last />
        </View>
      </Card>
    </>
  )
}

function DeviceStep({ review }: { review: boolean }) {
  return (
    <>
      <Text style={styles.title}>This phone is now your check-in device</Text>
      <Text style={styles.lede}>
        Attendance is tied to one device per person. It is the strongest part of the check-in
        system — it means nobody can check in as you without physically holding your phone.
      </Text>

      <Card tone={review ? 'warning' : 'default'}>
        <Label tone={review ? 'faint' : 'primary'}>
          {review ? 'Awaiting HR approval' : 'Registered'}
        </Label>
        <Text style={styles.cardBody}>
          {review
            ? 'You already had a registered device, so this one needs HR to approve it. You can use everything else meanwhile; check-ins from here will be flagged for review until they do.'
            : 'Checking in from a different phone later will be flagged, and switching devices needs HR to approve it.'}
        </Text>
      </Card>

      <Card>
        <Label>What check-in records</Label>
        <Text style={styles.cardBody}>
          The time, that you were inside the office area, and which method verified it. Your
          location itself is never stored, and nothing is tracked in the background — location
          is read only in the moment you tap check in.
        </Text>
      </Card>
    </>
  )
}

function BiometricStep({ busy, onEnable }: { busy: boolean; onEnable: () => void }) {
  return (
    <>
      <View style={styles.iconBadge}>
        <Icon name="approvals" size={30} color={colour.primary} accent={colour.accent} />
      </View>
      <Text style={styles.title}>Lock your pay and documents</Text>
      <Text style={styles.lede}>
        Payslips, tax documents and contracts open behind Face ID or your fingerprint — every
        time, even when the app is already open. Someone glancing at your screen sees nothing.
      </Text>

      <Button label="Turn on unlock" onPress={onEnable} loading={busy} />
    </>
  )
}

function NotificationStep({ busy, onEnable }: { busy: boolean; onEnable: () => void }) {
  return (
    <>
      <Text style={styles.title}>How Quanti reaches you</Text>
      <Text style={styles.lede}>
        Most people open this app a handful of times a year, so notifications do the work.
      </Text>

      <Card>
        {[
          'Check-in is open',
          'Leave approved or declined',
          'Your payslip is ready',
          'A document needs your signature',
        ].map((line, i, all) => (
          <View key={line} style={[styles.bullet, i < all.length - 1 && styles.bulletDivider]}>
            <View style={styles.bulletDot} />
            <Text style={styles.bulletText}>{line}</Text>
          </View>
        ))}
      </Card>

      <Card>
        <Label>Never in a preview</Label>
        <Text style={styles.cardBody}>
          Pay figures, disciplinary content and document contents stay out of lock-screen
          previews. &ldquo;Your payslip is ready&rdquo; — never the amount.
        </Text>
      </Card>

      <Button label="Turn on notifications" onPress={onEnable} loading={busy} />
    </>
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
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  stepper: { flexDirection: 'row', gap: space.sm },
  stepDot: {
    width: 22,
    height: 4,
    borderRadius: 2,
    backgroundColor: colour.surfaceRaised,
  },
  stepDotActive: { backgroundColor: colour.primary },
  stepDotDone: { backgroundColor: colour.primaryBorder },

  body: { flex: 1, gap: space.lg },

  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    lineHeight: 38,
    fontFamily: font.family,
  },
  lede: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 24,
    fontFamily: font.family,
  },

  identity: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  name: {
    fontSize: font.size.lg,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
  },
  role: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },
  data: { borderTopWidth: 1, borderTopColor: colour.border, paddingTop: space.xs },

  cardBody: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 23,
    fontFamily: font.family,
  },

  iconBadge: {
    width: 60,
    height: 60,
    borderRadius: radius.lg,
    backgroundColor: colour.primarySoft,
    borderWidth: 1,
    borderColor: colour.primaryBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },

  bullet: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  bulletDivider: { borderBottomWidth: 1, borderBottomColor: colour.border },
  bulletDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colour.primary },
  bulletText: { fontSize: font.size.md, color: colour.text, fontFamily: font.family, flex: 1 },

  actions: { gap: space.sm },
})
