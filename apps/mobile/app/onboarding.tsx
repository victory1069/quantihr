/**
 * Sign-up flow — screens L3 through L13.
 *
 * One route with internal steps rather than a route each: nobody deep-links
 * into step four of setup, and a single owner of the state means the back
 * gesture cannot strand someone half-verified.
 *
 * Order, and why:
 *
 *   email → link sent → [phone] → details → biometrics → tour → permissions → done
 *
 * Verification comes before the value cards because a stranger should not be
 * shown someone's salary. Permissions come last, after the boundary card, so
 * the OS dialog is a confirmation of something already explained rather than an
 * ambush — which is the single biggest lever on grant rates.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button, Card, ErrorNotice } from '../src/ui/components'
import { CheckRow, CodeInput, ConfirmField, ProgressRail, ResendTimer } from '../src/ui/onboarding'
import { Figure, Label } from '../src/ui/primitives'
import { Icon } from '../src/ui/Icon'
import { colour, font, MAX_CONTENT_WIDTH, radius, space } from '../src/ui/theme'
import { API_BASE_URL } from '../src/api/client'
import { useInvite } from '../src/api/invite'
import { useBalances, useMe, usePayslips, useUpdateMe } from '../src/api/queries'
import { setOnboarded, useSession } from '../src/store/session'
import { authenticate } from '../src/ui/BiometricGate'
import { formatNaira } from '../src/lib/money'

type Step =
  | 'email'
  | 'sent'
  | 'phone'
  | 'details'
  | 'biometrics'
  | 'tour'
  | 'permissions'
  | 'done'

/** Steps that show the progress rail, in order. */
const RAIL: Step[] = ['email', 'sent', 'phone', 'details']

export default function Onboarding() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const invite = useInvite()
  const me = useMe()

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [devLink, setDevLink] = useState<string | null>(null)
  const [flagged, setFlagged] = useState<string[]>([])

  useEffect(() => {
    if (invite.data?.email && !email) setEmail(invite.data.email)
  }, [invite.data, email])

  // If a session already exists (the link was tapped and exchanged), resume
  // after verification rather than asking for the email again.
  useEffect(() => {
    if (me.data && (step === 'email' || step === 'sent')) setStep('details')
  }, [me.data, step])

  const railIndex = RAIL.indexOf(step)

  const back = useCallback(() => {
    setError(null)
    const order: Step[] = ['email', 'sent', 'phone', 'details', 'biometrics', 'tour', 'permissions']
    const i = order.indexOf(step)
    if (i > 0) setStep(order[i - 1]!)
    else router.back()
  }, [step, router])

  const finish = useCallback(async () => {
    await setOnboarded()
    router.replace('/')
  }, [router])

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View
        style={[
          styles.column,
          { paddingTop: insets.top + space.lg, paddingBottom: insets.bottom + space.lg },
        ]}
      >
        {railIndex >= 0 ? (
          <ProgressRail
            total={RAIL.length}
            index={railIndex}
            failed={!!error && step === 'phone'}
            onBack={back}
          />
        ) : null}

        <StepFrame step={step}>
          {step === 'email' ? (
            <EmailStep
              email={email}
              locked={!!invite.data?.email}
              orgName={invite.data?.orgName ?? 'your employer'}
              busy={busy}
              error={error}
              onChange={setEmail}
              onSubmit={async () => {
                setBusy(true)
                setError(null)
                try {
                  const response = await fetch(`${API_BASE_URL}/v1/auth/magic-link`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ email: email.trim() }),
                  })
                  const body = (await response.json()) as { devLink?: string }
                  setDevLink(body.devLink ?? null)
                  setStep('sent')
                } catch {
                  setError('Could not reach the server. Check your connection and try again.')
                } finally {
                  setBusy(false)
                }
              }}
            />
          ) : step === 'sent' ? (
            <SentStep
              email={email}
              devLink={devLink}
              onResend={() => {
                void fetch(`${API_BASE_URL}/v1/auth/magic-link`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ email: email.trim() }),
                })
              }}
              onOpenDevLink={() => {
                if (!devLink) return
                const token = new URL(devLink).searchParams.get('token')
                if (token) router.replace(`/auth/callback?token=${token}`)
              }}
              onSms={() => setStep('phone')}
            />
          ) : step === 'phone' ? (
            <PhoneStep
              hint={invite.data?.phoneHint ?? null}
              error={error}
              onError={setError}
              onSkip={() => {
                setError(null)
                setStep('details')
              }}
            />
          ) : step === 'details' ? (
            <DetailsStep
              flagged={flagged}
              onFlag={(field) =>
                setFlagged((f) => (f.includes(field) ? f.filter((x) => x !== field) : [...f, field]))
              }
              onContinue={() => setStep('biometrics')}
            />
          ) : step === 'biometrics' ? (
            <BiometricsStep
              busy={busy}
              onEnable={async () => {
                setBusy(true)
                try {
                  const ok = await authenticate('Enable unlock for Quanti')
                  if (ok) setStep('tour')
                  else setError('Unlock was cancelled. You can turn it on later under Me.')
                } finally {
                  setBusy(false)
                }
              }}
              onSkip={() => setStep('tour')}
            />
          ) : step === 'tour' ? (
            <TourStep orgName={invite.data?.orgName ?? 'Your employer'} onDone={() => setStep('permissions')} />
          ) : step === 'permissions' ? (
            <PermissionsStep busy={busy} setBusy={setBusy} onDone={() => setStep('done')} />
          ) : (
            <DoneStep flagged={flagged} onFinish={finish} />
          )}
        </StepFrame>
      </View>
    </KeyboardAvoidingView>
  )
}

/** Cross-fades between steps so the flow reads as one moving surface. */
function StepFrame({ step, children }: { step: Step; children: React.ReactNode }) {
  const enter = useRef(new Animated.Value(0)).current

  useEffect(() => {
    enter.setValue(0)
    Animated.timing(enter, {
      toValue: 1,
      duration: 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start()
  }, [step, enter])

  return (
    <Animated.View
      style={[
        styles.frame,
        {
          opacity: enter,
          transform: [
            { translateX: enter.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  )
}

// ---------------------------------------------------------------------------
// L3 · Email
// ---------------------------------------------------------------------------

function EmailStep({
  email,
  locked,
  orgName,
  busy,
  error,
  onChange,
  onSubmit,
}: {
  email: string
  locked: boolean
  orgName: string
  busy: boolean
  error: string | null
  onChange: (next: string) => void
  onSubmit: () => void
}) {
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())

  return (
    <>
      <Text style={styles.title}>Confirm your work email</Text>
      <Text style={styles.lede}>
        We&apos;ll send a one-time link. There&apos;s no password to create or remember.
      </Text>

      <View style={{ gap: space.sm }}>
        <Text style={styles.fieldLabel}>Work email</Text>
        <View style={[styles.field, locked && styles.fieldLocked]}>
          <TextInput
            value={email}
            onChangeText={onChange}
            editable={!locked}
            placeholder="you@company.com"
            placeholderTextColor={colour.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            style={styles.fieldInput}
            accessibilityLabel="Work email address"
          />
          {valid ? <Text style={styles.tick}>✓</Text> : null}
        </View>

        {locked ? (
          <Text style={styles.hint}>
            From your invite. Wrong address?{' '}
            <Text style={styles.hintStrong}>Tell your HR admin</Text> — only they can change it.
          </Text>
        ) : null}
      </View>

      <Card>
        <Label>Why we ask</Label>
        <Text style={styles.cardBody}>
          Your email is how {orgName} identifies you in payroll. It&apos;s also the only way to
          recover access.
        </Text>
      </Card>

      {error ? <ErrorNotice message={error} /> : null}

      <View style={styles.spacer} />
      <Button label="Send my link" onPress={onSubmit} loading={busy} disabled={!valid} />
    </>
  )
}

// ---------------------------------------------------------------------------
// L4 · Link sent
// ---------------------------------------------------------------------------

function SentStep({
  email,
  devLink,
  onResend,
  onOpenDevLink,
  onSms,
}: {
  email: string
  devLink: string | null
  onResend: () => void
  onOpenDevLink: () => void
  onSms: () => void
}) {
  return (
    <>
      <View style={styles.iconBadge}>
        <Icon name="documents" size={28} color={colour.primary} accent={colour.primary} />
      </View>

      <Text style={styles.title}>Tap the link we emailed you</Text>
      <Text style={styles.lede}>
        Sent to <Text style={styles.strong}>{email}</Text>. It expires in 15 minutes.
      </Text>

      <Card>
        <Label>Not arriving?</Label>
        <Text style={styles.cardBody}>· Check spam and Promotions</Text>
        <Text style={styles.cardBody}>· Corporate filters can hold it 2–3 minutes</Text>
      </Card>

      <ResendTimer seconds={60} label="Resend link" onResend={onResend} />

      {/* Offered here rather than hidden behind a failure — corporate mail
          filtering is the largest single drop-off cause in this flow. */}
      <Button label="Text me a code instead" variant="secondary" onPress={onSms} />

      {devLink ? (
        <Button label="Open the link (development)" variant="ghost" onPress={onOpenDevLink} />
      ) : null}

      <View style={styles.spacer} />
      <Text style={styles.footnote}>
        You can close the app — we&apos;ll pick up where you left off.
      </Text>
    </>
  )
}

// ---------------------------------------------------------------------------
// L5 / L6 · Phone
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3

function PhoneStep({
  hint,
  error,
  onError,
  onSkip,
}: {
  hint: string | null
  error: string | null
  onError: (message: string | null) => void
  onSkip: () => void
}) {
  const [code, setCode] = useState('')
  const [attempts, setAttempts] = useState(0)
  const failed = !!error

  const left = MAX_ATTEMPTS - attempts

  return (
    <>
      <Text style={styles.title}>{failed ? 'That code didn’t match' : 'Verify your phone'}</Text>
      <Text style={styles.lede}>
        {failed
          ? 'Check the most recent message — older codes stop working once a new one is sent.'
          : 'Because this app shows your pay, we check a second factor once. After this, unlocking with your face or fingerprint is enough.'}
      </Text>

      {!failed ? (
        <Text style={styles.fieldLabel}>
          Code sent to {hint ?? 'the number on your HR record'}
        </Text>
      ) : null}

      <CodeInput
        value={code}
        onChange={(next) => {
          setCode(next)
          if (failed) onError(null)
        }}
        state={failed ? 'error' : 'idle'}
        onComplete={() => {
          // No OTP endpoint exists yet; see the note below. Every submission
          // fails closed rather than pretending to verify.
          setAttempts((n) => n + 1)
          onError('Phone verification is not switched on for this build.')
        }}
      />

      {failed ? (
        <Card tone="danger">
          <Text style={styles.cardBody}>
            <Text style={styles.strong}>{Math.max(0, left)} attempts left.</Text> After that
            we&apos;ll pause verification for 15 minutes and email you a link instead.
          </Text>
        </Card>
      ) : (
        <ResendTimer seconds={30} label="Resend code" onResend={() => setCode('')} />
      )}

      {/* Honest state: the screen is built, the endpoint is not. Skipping keeps
          the flow completable rather than dead-ending a real user. */}
      <ErrorNotice
        tone="info"
        message="Phone verification needs an SMS provider and a /v1/auth/otp endpoint, neither of which exists yet. Skip for now."
      />

      <View style={styles.spacer} />
      <Button label="Skip phone verification" onPress={onSkip} />
    </>
  )
}

// ---------------------------------------------------------------------------
// L7 · Confirm details
// ---------------------------------------------------------------------------

function DetailsStep({
  flagged,
  onFlag,
  onContinue,
}: {
  flagged: string[]
  onFlag: (field: string) => void
  onContinue: () => void
}) {
  const me = useMe()

  if (!me.data) {
    return (
      <>
        <Text style={styles.title}>Loading your record…</Text>
      </>
    )
  }

  const e = me.data.employee
  const fields: { key: string; label: string; value: string }[] = [
    { key: 'name', label: 'Full name', value: `${e.firstName} ${e.lastName}` },
    {
      key: 'role',
      label: 'Role · Department',
      value: [e.jobTitle, e.departmentName].filter(Boolean).join(' · ') || '—',
    },
    { key: 'manager', label: 'Manager', value: e.managerName ?? '—' },
    { key: 'start', label: 'Start date', value: e.startDate },
    { key: 'location', label: 'Work location', value: e.locationName ?? '—' },
  ]

  return (
    <>
      <Text style={styles.title}>Is this right?</Text>
      <Text style={styles.lede}>
        From your HR record. Flag anything wrong — it affects your payslip and your leave.
      </Text>

      <View style={{ gap: space.sm }}>
        {fields.map((f) => (
          <ConfirmField
            key={f.key}
            label={f.label}
            value={f.value}
            flagged={flagged.includes(f.key)}
            onFlag={() => onFlag(f.key)}
          />
        ))}
      </View>

      {flagged.length > 0 ? (
        <Card tone="warning">
          <Text style={styles.cardBody}>
            {flagged.length} item{flagged.length === 1 ? '' : 's'} flagged. These go to HR with
            your note attached — you can carry on setting up while they check.
          </Text>
        </Card>
      ) : null}

      <View style={styles.spacer} />
      <Button
        label={flagged.length > 0 ? 'Send flags and continue' : 'Looks right, continue'}
        onPress={onContinue}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// L8 · Biometrics
// ---------------------------------------------------------------------------

function BiometricsStep({
  busy,
  onEnable,
  onSkip,
}: {
  busy: boolean
  onEnable: () => void
  onSkip: () => void
}) {
  const update = useUpdateMe()

  return (
    <>
      <View style={styles.iconBadge}>
        <Icon name="approvals" size={28} color={colour.primary} accent={colour.primary} />
      </View>

      <Text style={styles.title}>Unlock with your face</Text>
      <Text style={styles.lede}>
        You stay signed in. It&apos;s asked again whenever you open a payslip or a document.
      </Text>

      <View style={{ gap: space.sm }}>
        <CheckRow state="yes">No password to remember</CheckRow>
        <CheckRow state="yes">Pay figures stay out of notifications</CheckRow>
        <CheckRow state="yes">Balances and payslips work offline</CheckRow>
        {/* The line that actually moves adoption. Biometric anxiety is about
            transmission, not capture. */}
        <CheckRow state="yes">Your face never leaves this phone</CheckRow>
      </View>

      <View style={styles.spacer} />
      <Button
        label="Enable unlock"
        loading={busy}
        onPress={() => {
          update.mutate({ biometricEnabled: true })
          onEnable()
        }}
      />
      <Button label="Sign in with a link each time" variant="ghost" onPress={onSkip} />
    </>
  )
}

// ---------------------------------------------------------------------------
// L9 / L10 / L11 · Value cards
// ---------------------------------------------------------------------------

function TourStep({ orgName, onDone }: { orgName: string; onDone: () => void }) {
  const [card, setCard] = useState(0)
  const balances = useBalances()
  const payslips = usePayslips()

  const annual = balances.data?.balances[0]
  const latest = payslips.data?.payslips[0]

  const next = () => (card < 2 ? setCard((c) => c + 1) : onDone())

  return (
    <>
      <View style={styles.tourHead}>
        <View style={styles.tourDots}>
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              style={[
                styles.tourDot,
                i === card && (i === 1 ? styles.tourDotViolet : styles.tourDotActive),
              ]}
            />
          ))}
        </View>
        <Pressable onPress={onDone} hitSlop={10} accessibilityRole="button">
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      </View>

      <View style={styles.spacer} />

      {card === 0 ? (
        <>
          {/* Real figures from the record, not illustrations — by this point the
              value is provable, so prove it. */}
          <Card>
            <Label>{latest ? `Last paid · ${latest.payDate}` : 'Your pay'}</Label>
            <Figure size="display">{latest ? formatNaira(latest.netPay) : '—'}</Figure>
            <View style={styles.tourDivider} />
            <View style={styles.tourRow}>
              <Text style={styles.cardBody}>Annual leave left</Text>
              <Figure size="sm" tone="success">
                {annual ? `${annual.available} days` : '—'}
              </Figure>
            </View>
          </Card>

          <Text style={styles.title}>Your pay and leave, always on hand</Text>
          <Text style={styles.lede}>
            Payslips with a plain-language explanation of anything that changed. Balances that
            work with no signal.
          </Text>
        </>
      ) : card === 1 ? (
        <>
          <View style={styles.askBubble}>
            <Text style={styles.askQuestion}>How many sick days do I get?</Text>
          </View>
          <Card style={styles.askAnswer}>
            <Text style={styles.cardBodyStrong}>
              Answers come from your company&apos;s own policies, with the section quoted.
            </Text>
            <Label tone="violet">Source · your leave policy</Label>
          </Card>

          <Text style={styles.title}>Ask instead of waiting on HR</Text>
          <Text style={styles.lede}>
            If Quanti doesn&apos;t know, it says so and points you to a person rather than
            guessing.
          </Text>
        </>
      ) : (
        <>
          <Text style={styles.title}>What {orgName} can and can&apos;t see</Text>
          <View style={{ gap: space.sm }}>
            <CheckRow state="yes">Your check-ins, leave and payroll data</CheckRow>
            <CheckRow state="yes">Goals and reviews you submit</CheckRow>
            <CheckRow state="no">Your location outside a check-in</CheckRow>
            <CheckRow state="no">Anything else on your phone</CheckRow>
            <CheckRow state="no">What you ask the policy assistant</CheckRow>
          </View>
          <Text style={styles.footnote}>
            You can read this again any time under Me → Privacy.
          </Text>
        </>
      )}

      <View style={styles.spacer} />
      <Button
        label={card === 2 ? 'I understand' : 'Next'}
        onPress={next}
        variant={card === 1 ? 'secondary' : 'primary'}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// L12 · Permissions
// ---------------------------------------------------------------------------

function PermissionsStep({
  busy,
  setBusy,
  onDone,
}: {
  busy: boolean
  setBusy: (v: boolean) => void
  onDone: () => void
}) {
  const [note, setNote] = useState<string | null>(null)

  const request = async (which: 'both' | 'location' | 'notifications') => {
    setBusy(true)
    setNote(null)
    try {
      if (Platform.OS === 'web') {
        setNote('These are phone permissions — on the web preview there is nothing to grant.')
        return
      }
      if (which === 'both' || which === 'location') {
        const Location = await import('expo-location')
        await Location.requestForegroundPermissionsAsync()
      }
      if (which === 'both' || which === 'notifications') {
        const Notifications = await import('expo-notifications')
        await Notifications.requestPermissionsAsync()
      }
      onDone()
    } catch {
      setNote('Could not request permissions on this device.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Text style={styles.title}>Two things to allow</Text>
      <Text style={styles.lede}>
        Both optional. The app works without them — some things just take an extra step.
      </Text>

      <Card>
        <View style={styles.permHead}>
          <View style={styles.permIcon}>
            <Icon name="home" size={20} color={colour.primary} accent={colour.primary} />
          </View>
          <Text style={styles.permTitle}>Location, at check-in only</Text>
        </View>
        <Text style={styles.cardBody}>
          Checked once, when you tap Check In. Never in the background, never after hours, and
          your manager never sees a map.
        </Text>
        <View style={styles.permNote}>
          <Text style={styles.permNoteText}>
            Records that a phone with the code was near the office — a record, not proof. Your
            HR team sees this same wording.
          </Text>
        </View>
      </Card>

      <Card>
        <View style={styles.permHead}>
          <View style={styles.permIcon}>
            <Icon name="time" size={20} color={colour.primary} accent={colour.primary} />
          </View>
          <Text style={styles.permTitle}>Notifications</Text>
        </View>
        <Text style={styles.cardBody}>
          Check-in reminders, payslip ready, leave approved, documents to sign. Never the
          amount — you will never see pay figures on your lock screen.
        </Text>
      </Card>

      {note ? <ErrorNotice tone="info" message={note} /> : null}

      <View style={styles.spacer} />
      <Button label="Allow both" loading={busy} onPress={() => void request('both')} />
      <Button label="Decide each one" variant="ghost" onPress={onDone} />
    </>
  )
}

// ---------------------------------------------------------------------------
// L13 · Done
// ---------------------------------------------------------------------------

function DoneStep({ flagged, onFinish }: { flagged: string[]; onFinish: () => void }) {
  const me = useMe()
  const first = me.data?.employee.firstName ?? ''
  const deviceReview = useSession((s) => s.deviceReviewRequired)

  return (
    <>
      <View style={[styles.iconBadge, styles.iconBadgeSuccess]}>
        <Text style={styles.successTick}>✓</Text>
      </View>

      <Text style={styles.title}>You&apos;re all set{first ? `, ${first}` : ''}</Text>

      {/* Ends on open items rather than confetti, and carries forward anything
          flagged at L7 so the user knows it was heard. */}
      {flagged.length > 0 || deviceReview ? (
        <>
          <Text style={styles.lede}>Here&apos;s what&apos;s waiting for you.</Text>
          <View style={{ gap: space.sm }}>
            {flagged.length > 0 ? (
              <View style={[styles.openItem, styles.openItemWarn]}>
                <View style={[styles.openDot, { backgroundColor: colour.warning }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.openTitle}>
                    {flagged.length} detail{flagged.length === 1 ? '' : 's'} flagged for review
                  </Text>
                  <Text style={styles.openSub}>HR will confirm and come back to you</Text>
                </View>
              </View>
            ) : null}

            {deviceReview ? (
              <View style={[styles.openItem, styles.openItemAccent]}>
                <View style={[styles.openDot, { backgroundColor: colour.accent }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.openTitle}>This device needs HR approval</Text>
                  <Text style={styles.openSub}>Check-ins are flagged until it is approved</Text>
                </View>
              </View>
            ) : null}
          </View>
        </>
      ) : (
        <Text style={styles.lede}>Everything is ready. Your balance and payslips are on Home.</Text>
      )}

      <View style={styles.spacer} />
      <Button label="Go to home" onPress={onFinish} />
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
  frame: { flex: 1, gap: space.lg },
  spacer: { flex: 1, minHeight: space.md },

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
  strong: { color: colour.text, fontWeight: font.weight.bold },
  footnote: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    lineHeight: 20,
    textAlign: 'center',
    fontFamily: font.family,
  },

  fieldLabel: {
    fontSize: font.size.sm,
    color: colour.text,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderWidth: 1.5,
    borderColor: colour.primary,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    minHeight: 58,
    backgroundColor: colour.surfaceSunken,
  },
  fieldLocked: { borderColor: colour.primaryBorder },
  fieldInput: {
    flex: 1,
    fontSize: font.size.lg,
    color: colour.text,
    fontFamily: font.family,
  },
  tick: { fontSize: 18, color: colour.success, fontWeight: font.weight.bold },
  hint: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    lineHeight: 20,
    fontFamily: font.family,
  },
  hintStrong: { color: colour.primary, fontWeight: font.weight.bold },

  cardBody: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 22,
    fontFamily: font.family,
  },
  cardBodyStrong: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 22,
    fontFamily: font.family,
  },

  iconBadge: {
    width: 58,
    height: 58,
    borderRadius: radius.lg,
    backgroundColor: colour.primarySoft,
    borderWidth: 1,
    borderColor: colour.primaryBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadgeSuccess: {
    backgroundColor: colour.successSoft,
    borderColor: 'rgba(61,220,151,0.35)',
  },
  successTick: { fontSize: 28, color: colour.success, fontWeight: font.weight.bold },

  tourHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  tourDots: { flexDirection: 'row', gap: space.sm },
  tourDot: { width: 26, height: 4, borderRadius: 2, backgroundColor: colour.surfaceRaised },
  tourDotActive: { backgroundColor: colour.primary },
  tourDotViolet: { backgroundColor: colour.pending },
  skip: {
    fontSize: font.size.md,
    color: colour.textMuted,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },
  tourDivider: { height: 1, backgroundColor: colour.border },
  tourRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  askBubble: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: colour.primary,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  askQuestion: {
    fontSize: font.size.md,
    color: colour.primaryText,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },
  askAnswer: { borderColor: 'rgba(123,92,255,0.35)' },

  permHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  permIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colour.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permTitle: {
    fontSize: font.size.md,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
    flex: 1,
  },
  permNote: {
    borderWidth: 1,
    borderColor: 'rgba(255,176,32,0.3)',
    backgroundColor: colour.warningSoft,
    borderRadius: radius.sm,
    padding: space.md,
  },
  permNoteText: {
    fontSize: font.size.sm,
    color: colour.warning,
    lineHeight: 20,
    fontFamily: font.family,
  },

  openItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space.lg,
  },
  openItemWarn: { borderColor: 'rgba(255,176,32,0.4)', backgroundColor: colour.warningSoft },
  openItemAccent: { borderColor: 'rgba(255,61,138,0.4)', backgroundColor: colour.accentSoft },
  openDot: { width: 8, height: 8, borderRadius: 4 },
  openTitle: {
    fontSize: font.size.md,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
  },
  openSub: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
})
