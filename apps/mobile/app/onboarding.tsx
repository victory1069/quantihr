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
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Button, Card, ErrorNotice, HeroSheet } from '../src/ui/components'
import { CheckRow, CodeInput, ConfirmField, ResendTimer } from '../src/ui/onboarding'
import { Figure, Label } from '../src/ui/primitives'
import { Icon } from '../src/ui/Icon'
import { LogoMark } from '../src/ui/Logo'
import { colour, font, radius, space } from '../src/ui/theme'
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

const ORDER: Step[] = ['email', 'sent', 'phone', 'details', 'biometrics', 'tour', 'permissions', 'done']

const BIOMETRIC_NAME = Platform.select({ ios: 'Face ID', default: 'your fingerprint' })

export default function Onboarding() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const invite = useInvite(email || undefined)
  const me = useMe()

  const [step, setStep] = useState<Step>('email')
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

  const back = useCallback(() => {
    setError(null)
    const i = ORDER.indexOf(step)
    if (i > 0) setStep(ORDER[i - 1]!)
    else router.back()
  }, [step, router])
  void back

  const orgName = invite.data?.orgName ?? 'Your employer'

  // What sits above the sheet. The invite headline stays through the email
  // steps so the person always knows whose app this is; it dims once the
  // sheet is where the action is, and gives way to the Face ID pitch later.
  const hero =
    step === 'email' || step === 'sent' ? (
      <View style={styles.hero}>
        <LogoMark size={40} />
        <Text style={styles.heroTitle}>{orgName} invited you</Text>
        <Text style={styles.heroLede}>Your pay, leave and HR answers in one place.</Text>
      </View>
    ) : step === 'biometrics' ? (
      <View style={styles.hero}>
        <View style={styles.iconBadge}>
          <Icon name="approvals" size={24} color={colour.primary} accent={colour.primary} />
        </View>
        <Text style={styles.heroTitle}>Unlock with {BIOMETRIC_NAME}</Text>
        <Text style={styles.heroLede}>
          You&apos;ll stay signed in. {Platform.OS === 'ios' ? 'Face ID' : 'It'} is asked again
          whenever you open a payslip or a document.
        </Text>
      </View>
    ) : step === 'details' ? null : (
      <View style={styles.hero}>
        <LogoMark size={40} />
      </View>
    )

  const finish = useCallback(async () => {
    await setOnboarded()
    router.replace('/')
  }, [router])

  return (
    <HeroSheet
      hero={hero}
      dimmed={step === 'sent' || step === 'phone'}
      stepKey={step}
      maxSheet={step === 'details' ? 0.92 : 0.8}
    >
          {step === 'email' ? (
            <EmailStep
              email={email}
              locked={!!invite.data?.email}
              orgName={orgName}
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
              email={email}
              hint={invite.data?.phoneHint ?? null}
              error={error}
              onError={setError}
              onVerified={() => {
                setError(null)
                setStep('details')
              }}
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
    </HeroSheet>
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
      <View style={{ gap: space.sm }}>
        <Text style={styles.fieldLabel}>Your work email</Text>
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

        <Text style={styles.hint}>
          {locked
            ? 'From your HR record. Only an admin can change it.'
            : 'The address on your HR record.'}
        </Text>
      </View>

      {error ? <ErrorNotice message={error} /> : null}

      <Button label="Send my sign-in link" onPress={onSubmit} loading={busy} disabled={!valid} />

      <Text style={styles.footnote}>
        {orgName} can see your leave, attendance and payroll data. It can&apos;t see your
        location outside a check-in, or anything else on this phone.
      </Text>
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
        <Icon name="documents" size={24} color={colour.primary} accent={colour.primary} />
      </View>

      <Text style={styles.title}>Check your email</Text>
      <Text style={styles.lede}>
        Tap the link we sent to <Text style={styles.strong}>{email}</Text>. It works for 15
        minutes.
      </Text>

      <ResendTimer seconds={60} label="Send again" onResend={onResend} />

      {/* Offered here rather than hidden behind a failure — corporate mail
          filtering is the largest single drop-off cause in this flow. */}
      <Button label="Text me a code instead" variant="secondary" onPress={onSms} />

      {devLink ? (
        <Button label="Open the link (development)" variant="ghost" onPress={onOpenDevLink} />
      ) : null}

      <Text style={styles.footnote}>
        Wrong address? <Text style={styles.hintStrong}>Ask your HR admin</Text> — only they can
        change it.
      </Text>
    </>
  )
}

// ---------------------------------------------------------------------------
// L5 / L6 · Phone
// ---------------------------------------------------------------------------

/**
 * L5 / L6 — phone verification.
 *
 * Backed by `/v1/auth/otp/request` and `/v1/auth/otp/verify`. The destination
 * comes from the HR record, never from the user, so this cannot be turned into
 * a way to send SMS to arbitrary numbers.
 *
 * The server owns the attempt count and the lockout; this screen only renders
 * what it is told. Duplicating the limit client-side would let a modified
 * client keep guessing.
 */
function PhoneStep({
  email,
  hint,
  error,
  onError,
  onVerified,
  onSkip,
}: {
  email: string
  hint: string | null
  error: string | null
  onError: (message: string | null) => void
  onVerified: () => void
  onSkip: () => void
}) {
  const [code, setCode] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(hint)
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
  const [locked, setLocked] = useState(false)
  const [devCode, setDevCode] = useState<string | null>(null)
  const requested = useRef(false)

  const request = useCallback(async () => {
    setSending(true)
    onError(null)
    try {
      const response = await fetch(`${API_BASE_URL}/v1/auth/otp/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const body = (await response.json()) as {
        phoneHint?: string | null
        devCode?: string
        message?: string
      }
      if (!response.ok) {
        onError(body.message ?? 'Could not send a code.')
        return
      }
      setSentTo(body.phoneHint ?? hint)
      setDevCode(body.devCode ?? null)
    } catch {
      onError('Could not reach the server. Check your connection and try again.')
    } finally {
      setSending(false)
    }
  }, [email, hint, onError])

  useEffect(() => {
    if (requested.current) return
    requested.current = true
    void request()
  }, [request])

  const verify = async (submitted: string) => {
    setVerifying(true)
    onError(null)
    try {
      const response = await fetch(`${API_BASE_URL}/v1/auth/otp/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code: submitted }),
      })
      const body = (await response.json()) as {
        verified?: boolean
        message?: string
        details?: { attemptsLeft?: number; locked?: boolean }
      }

      if (response.ok && body.verified) {
        onVerified()
        return
      }

      setAttemptsLeft(body.details?.attemptsLeft ?? null)
      setLocked(!!body.details?.locked || response.status === 429)
      onError(body.message ?? 'That code did not match.')
      setCode('')
    } catch {
      onError('Could not reach the server. Check your connection and try again.')
    } finally {
      setVerifying(false)
    }
  }

  const failed = !!error

  return (
    <>
      <Text style={styles.title}>{failed ? 'That code didn’t work' : 'Enter the code'}</Text>
      <Text style={styles.lede}>
        {failed
          ? error
          : `Sent to ${sentTo ?? 'the number on your HR record'} — the number on your HR record.`}
      </Text>

      <CodeInput
        value={code}
        onChange={(next) => {
          setCode(next)
          if (failed) onError(null)
        }}
        state={failed ? 'error' : 'idle'}
        onComplete={(full) => void verify(full)}
      />

      {locked ? (
        <Card tone="danger">
          <Text style={styles.cardBody}>
            Verification is paused for 15 minutes. An email sign-in link still works — it uses
            a different check, so the cool-down doesn&apos;t apply.
          </Text>
        </Card>
      ) : attemptsLeft !== null ? (
        <Card tone="danger">
          <Text style={styles.cardBody}>
            <Text style={styles.strong}>{attemptsLeft} attempts left.</Text> After that
            we&apos;ll pause verification for 15 minutes and email you a link instead.
          </Text>
        </Card>
      ) : (
        <ResendTimer
          seconds={30}
          label="Resend code"
          onResend={() => {
            setCode('')
            void request()
          }}
        />
      )}

      {devCode ? (
        <ErrorNotice tone="info" message={`Development: your code is ${devCode}`} />
      ) : null}

      {failed && !locked ? (
        <Button
          label="Send a new code"
          loading={sending}
          onPress={() => {
            setCode('')
            onError(null)
            void request()
          }}
        />
      ) : (
        <Button
          label={verifying ? 'Checking…' : 'Continue'}
          loading={verifying || sending}
          disabled={code.length < 6}
          onPress={() => void verify(code)}
        />
      )}
      <Button
        label={failed ? 'Email me a link instead' : 'Skip for now'}
        variant="ghost"
        onPress={onSkip}
      />
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

      <Button
        label={flagged.length > 0 ? 'Send flags and continue' : 'Looks right'}
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
      <View style={{ gap: space.sm }}>
        <CheckRow state="yes">No password to remember</CheckRow>
        <CheckRow state="yes">Pay figures never show in notifications</CheckRow>
        <CheckRow state="yes">Balances and payslips work offline</CheckRow>
      </View>

      <Button
        label={BIOMETRIC_NAME === 'Face ID' ? 'Enable Face ID' : 'Enable unlock'}
        loading={busy}
        onPress={() => {
          update.mutate({ biometricEnabled: true })
          onEnable()
        }}
      />
      <Button label="Use a sign-in link each time" variant="ghost" onPress={onSkip} />

      {/* The line that actually moves adoption. Biometric anxiety is about
          transmission, not capture. */}
      <Text style={styles.footnote}>
        Your face never leaves this phone — Quanti only ever hears yes or no from{' '}
        {Platform.OS === 'ios' ? 'iOS' : 'Android'}.
      </Text>
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
  spacer: { minHeight: space.md },

  hero: { gap: space.md, paddingBottom: space.xl },
  heroTitle: {
    fontSize: font.size.display,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    lineHeight: 40,
    fontFamily: font.family,
    marginTop: space.md,
  },
  heroLede: {
    fontSize: font.size.lg,
    color: colour.textMuted,
    lineHeight: 24,
    fontFamily: font.family,
  },

  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    lineHeight: 34,
    fontFamily: font.family,
  },
  lede: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 22,
    fontFamily: font.family,
  },
  strong: { color: colour.text, fontWeight: font.weight.bold },
  footnote: {
    fontSize: font.size.sm,
    color: colour.textFaint,
    lineHeight: 18,
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
    minHeight: 52,
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
    lineHeight: 18,
    fontFamily: font.family,
  },
  hintStrong: { color: colour.primary, fontWeight: font.weight.bold },

  cardBody: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 20,
    fontFamily: font.family,
  },
  cardBodyStrong: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 20,
    fontFamily: font.family,
  },

  iconBadge: {
    width: 58,
    height: 52,
    borderRadius: radius.lg,
    backgroundColor: colour.primarySoft,
    borderWidth: 1,
    borderColor: colour.primaryBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadgeSuccess: {
    backgroundColor: colour.successSoft,
    borderColor: colour.success,
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
  askAnswer: { borderColor: colour.primaryBorder },

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
    borderColor: colour.warning,
    backgroundColor: colour.warningSoft,
    borderRadius: radius.sm,
    padding: space.md,
  },
  permNoteText: {
    fontSize: font.size.sm,
    color: colour.warning,
    lineHeight: 18,
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
  openItemWarn: { borderColor: colour.warning, backgroundColor: colour.warningSoft },
  openItemAccent: { borderColor: colour.accent, backgroundColor: colour.accentSoft },
  openDot: { width: 8, height: 8, borderRadius: 4 },
  openTitle: {
    fontSize: font.size.md,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
  },
  openSub: { fontSize: font.size.sm, color: colour.textMuted, fontFamily: font.family },
})
