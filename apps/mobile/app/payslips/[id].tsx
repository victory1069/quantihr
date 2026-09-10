/**
 * Payslip detail with the "why is my pay different" explainer (spec §5.5).
 *
 * The explanation is arithmetic computed server-side from the two stored
 * payslips, not generated text. It leads the screen because it is the question
 * employees actually open this page to answer.
 */

import { StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Button,
  Card,
  Divider,
  ErrorNotice,
  Screen,
  SectionTitle,
  Skeleton,
} from '../../src/ui/components'
import { colour, font, space } from '../../src/ui/theme'
import { usePayslip, type PayslipLine } from '../../src/api/queries'
import { formatNaira } from '../../src/lib/money'

export default function PayslipDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const payslip = usePayslip(id)

  if (payslip.isLoading || !payslip.data) {
    return (
      <Screen>
        <Card>
          <Skeleton height={28} />
          <Skeleton height={120} />
        </Card>
      </Screen>
    )
  }

  const { detail, explanation } = payslip.data
  const earnings = detail.lines.filter((l) => l.category === 'earning')
  const statutory = detail.lines.filter((l) => l.category === 'statutory')
  const deductions = detail.lines.filter((l) => l.category === 'deduction')

  return (
    <Screen>
      <View style={styles.header}>
        <Text style={styles.title}>{monthLabel(payslip.data.periodStart)}</Text>
        <Text style={styles.sub}>
          {payslip.data.periodStart} → {payslip.data.periodEnd} · paid {payslip.data.payDate}
        </Text>
      </View>

      <Card>
        <Text style={styles.netLabel}>Net pay</Text>
        <Text style={styles.net}>{formatNaira(detail.netPay)}</Text>
        <Text style={styles.netSub}>
          {formatNaira(detail.gross)} gross, less {formatNaira(detail.totalDeductions)} in
          deductions
        </Text>
      </Card>

      {explanation ? (
        <Card style={styles.explainer}>
          <Text style={styles.explainerTitle}>What changed</Text>
          <Text style={styles.explainerBody}>{explanation.summary}</Text>

          {explanation.changes.length > 0 ? (
            <View style={styles.changes}>
              {explanation.changes.map((c) => (
                <View key={c.code} style={styles.changeRow}>
                  <Text style={styles.changeLabel}>{c.label}</Text>
                  <Text
                    style={[
                      styles.changeDelta,
                      { color: c.delta > 0 ? colour.success : colour.danger },
                    ]}
                  >
                    {formatNaira(c.delta, { sign: true })}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </Card>
      ) : (
        <ErrorNotice
          tone="info"
          message="This is your first payslip, so there is nothing to compare it against yet."
        />
      )}

      <SectionTitle>Earnings</SectionTitle>
      <Card>
        <LineList lines={earnings} />
        <Divider />
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Gross pay</Text>
          <Text style={styles.totalValue}>{formatNaira(detail.gross)}</Text>
        </View>
      </Card>

      <SectionTitle>Statutory deductions</SectionTitle>
      <Card>
        {statutory.length > 0 ? (
          <LineList lines={statutory} negative />
        ) : (
          <Text style={styles.none}>None this period.</Text>
        )}
      </Card>

      {deductions.length > 0 ? (
        <>
          <SectionTitle>Other deductions</SectionTitle>
          <Card>
            <LineList lines={deductions} negative />
          </Card>
        </>
      ) : null}

      <Card>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Take home</Text>
          <Text style={styles.totalValue}>{formatNaira(detail.netPay)}</Text>
        </View>
      </Card>

      <Text style={styles.footnote}>
        Questions about a figure here go to your HR team. Every line is computed from your
        recorded salary and the statutory rates in force for the period.
      </Text>

      <Button label="Back to pay" variant="ghost" onPress={() => router.replace('/payslips')} />
    </Screen>
  )
}

function LineList({ lines, negative }: { lines: PayslipLine[]; negative?: boolean }) {
  return (
    <>
      {lines.map((l, i) => (
        <View key={l.code}>
          {i > 0 ? <Divider /> : null}
          <View style={styles.lineRow}>
            <Text style={styles.lineLabel}>{l.label}</Text>
            <Text style={styles.lineValue}>
              {negative ? '−' : ''}
              {formatNaira(l.amount)}
            </Text>
          </View>
        </View>
      ))}
    </>
  )
}

function monthLabel(iso: string): string {
  const [y, m] = iso.split('-').map(Number)
  return new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, 1)).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  })
}

const styles = StyleSheet.create({
  header: { paddingTop: space.lg, gap: space.xs },
  title: { fontSize: font.size.xxl, fontWeight: font.weight.bold, color: colour.text },
  sub: { fontSize: font.size.sm, color: colour.textMuted },

  netLabel: {
    fontSize: font.size.xs,
    fontWeight: font.weight.semibold,
    color: colour.textFaint,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  net: { fontSize: font.size.display, fontWeight: font.weight.bold, color: colour.text },
  netSub: { fontSize: font.size.sm, color: colour.textMuted },

  explainer: { backgroundColor: colour.primarySoft, borderColor: colour.primaryBorder },
  explainerTitle: { fontSize: font.size.md, fontWeight: font.weight.semibold, color: colour.primary },
  explainerBody: { fontSize: font.size.md, color: colour.text, lineHeight: 22 },
  changes: { gap: space.xs, paddingTop: space.sm },
  changeRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  changeLabel: { fontSize: font.size.sm, color: colour.textMuted, flex: 1 },
  changeDelta: { fontSize: font.size.sm, fontWeight: font.weight.semibold },

  lineRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
    gap: space.md,
  },
  lineLabel: { fontSize: font.size.md, color: colour.textMuted, flex: 1 },
  lineValue: { fontSize: font.size.md, color: colour.text, fontWeight: font.weight.medium },

  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: space.xs },
  totalLabel: { fontSize: font.size.md, fontWeight: font.weight.semibold, color: colour.text },
  totalValue: { fontSize: font.size.lg, fontWeight: font.weight.bold, color: colour.text },

  none: { fontSize: font.size.md, color: colour.textMuted },
  footnote: { fontSize: font.size.sm, color: colour.textFaint, lineHeight: 19 },
})
