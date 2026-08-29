/**
 * Payslip list (spec §5.5).
 *
 * Biometric-gated, like the document vault. Only approved runs appear — the API
 * filters those out, but the screen also says nothing at all about pay until the
 * gate is satisfied, so a shoulder-surfer sees no figures.
 */

import { useEffect, useState } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { Badge, Button, Card, EmptyState, Screen, Skeleton } from '../../src/ui/components'
import { colour, font, space } from '../../src/ui/theme'
import { keys, usePayslips } from '../../src/api/queries'
import { authenticate } from '../../src/ui/BiometricGate'
import { formatNaira } from '../../src/lib/money'

export default function Payslips() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [unlocked, setUnlocked] = useState(false)
  const [checking, setChecking] = useState(true)

  const payslips = usePayslips()

  useEffect(() => {
    let active = true
    void (async () => {
      const ok = await authenticate('View your payslips')
      if (!active) return
      setUnlocked(ok)
      setChecking(false)
    })()
    return () => {
      active = false
    }
  }, [])

  if (checking) {
    return (
      <Screen>
        <Text style={styles.title}>Pay</Text>
        <Card>
          <Skeleton height={20} />
        </Card>
      </Screen>
    )
  }

  if (!unlocked) {
    return (
      <Screen>
        <Text style={styles.title}>Pay</Text>
        <Card>
          <Text style={styles.locked}>
            Your payslips are locked. Unlock with biometrics to view them.
          </Text>
          <Button
            label="Unlock"
            onPress={() => {
              setChecking(true)
              void authenticate('View your payslips').then((ok) => {
                setUnlocked(ok)
                setChecking(false)
              })
            }}
          />
        </Card>
      </Screen>
    )
  }

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={payslips.isRefetching}
          onRefresh={() => void queryClient.invalidateQueries({ queryKey: keys.payslips })}
          tintColor={colour.primary}
        />
      }
    >
      <Text style={styles.title}>Pay</Text>

      {payslips.data ? (
        payslips.data.payslips.length > 0 ? (
          payslips.data.payslips.map((p) => (
            <Card key={p.id} onPress={() => router.push(`/payslips/${p.id}`)}>
              <View style={styles.row}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.period}>{monthLabel(p.periodStart)}</Text>
                  <Text style={styles.dates}>
                    {p.periodStart} → {p.periodEnd} · paid {p.payDate}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.net}>{formatNaira(p.netPay)}</Text>
                  <Badge
                    label={p.status === 'paid' ? 'Paid' : 'Approved'}
                    tone={p.status === 'paid' ? 'success' : 'info'}
                  />
                </View>
              </View>
            </Card>
          ))
        ) : (
          <EmptyState
            title="No payslips yet"
            body="Your payslips appear here once a payroll run has been approved."
          />
        )
      ) : (
        <Card>
          <Skeleton height={24} />
          <Skeleton height={44} />
        </Card>
      )}
    </Screen>
  )
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1))
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

const styles = StyleSheet.create({
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    paddingTop: space.lg,
  },
  locked: { fontSize: font.size.md, color: colour.textMuted, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  period: { fontSize: font.size.lg, fontWeight: font.weight.semibold, color: colour.text },
  dates: { fontSize: font.size.sm, color: colour.textMuted },
  net: { fontSize: font.size.xl, fontWeight: font.weight.bold, color: colour.text },
})
