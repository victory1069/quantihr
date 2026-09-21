/**
 * Plan editor — what I will attend this period, and why.
 *
 * One period, one or more courses. Each course carries a "need": the line
 * the manager judges the request on, so it is required and asked for in
 * those words rather than as a "description". Saving keeps a draft; submit
 * sends it. Editing a plan with changes requested pre-fills what was there.
 */

import { useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import type { TrainingItemInput } from '@quanti/shared'
import {
  BackLink,
  Button,
  Card,
  ErrorNotice,
  HeroSheet,
  SegmentedTabs,
} from '../../src/ui/components'
import { Label } from '../../src/ui/primitives'
import { colour, font, radius, space } from '../../src/ui/theme'
import { useSaveTrainingPlan, useTrainingPlans } from '../../src/api/queries'
import { nextPeriodStart, periodName, quarterStart } from '../../src/lib/training'

type Period = 'month' | 'quarter'
type Draft = Omit<TrainingItemInput, 'costKobo'> & { cost: string }

const blank = (start: string): Draft => ({
  title: '',
  provider: '',
  mode: 'virtual',
  startDate: start,
  endDate: start,
  need: '',
  cost: '',
})

export default function PlanTraining() {
  const router = useRouter()
  const plans = useTrainingPlans()
  const save = useSaveTrainingPlan()

  const [period, setPeriod] = useState<Period>('month')
  const nextMonth = useMemo(() => nextPeriodStart(), [])
  const periodStart = period === 'month' ? nextMonth : quarterStart(nextMonth)
  const [items, setItems] = useState<Draft[]>([blank(nextMonth)])
  const [error, setError] = useState<string | null>(null)

  // Pre-fill from an editable plan for the same period, if there is one.
  const existing = plans.data?.plans.find(
    (p) =>
      p.periodType === period &&
      p.periodStart === periodStart &&
      (p.status === 'draft' || p.status === 'changes_requested'),
  )
  useEffect(() => {
    if (!existing) return
    setItems(
      existing.items.map((i) => ({
        title: i.title,
        provider: i.provider ?? '',
        mode: i.mode,
        startDate: i.startDate,
        endDate: i.endDate,
        need: i.need,
        cost: i.costKobo != null ? String(i.costKobo / 100) : '',
      })),
    )
  }, [existing?.id])

  const update = (index: number, patch: Partial<Draft>) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)))

  const problems = items.map((it) => {
    if (it.title.trim().length < 2) return 'Give the course a name'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(it.endDate))
      return 'Dates as YYYY-MM-DD'
    if (it.endDate < it.startDate) return 'The end date has to be on or after the start'
    if (it.need.trim().length < 10) return 'Say why you need it — a sentence is enough'
    return null
  })
  const valid = problems.every((p) => p === null)

  const payload = (): TrainingItemInput[] =>
    items.map((it) => ({
      title: it.title.trim(),
      provider: it.provider?.trim() || null,
      mode: it.mode,
      startDate: it.startDate,
      endDate: it.endDate,
      need: it.need.trim(),
      costKobo: it.cost.trim() ? Math.round(Number(it.cost) * 100) : null,
    }))

  const go = async (submit: boolean) => {
    setError(null)
    try {
      await save.mutateAsync({ periodType: period, periodStart, items: payload(), submit })
      router.replace('/learning')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That could not be saved.')
    }
  }

  return (
    <HeroSheet
      hero={
        <View>
          <BackLink label="Learning" onPress={() => router.back()} />
          <Text style={styles.heroTitle}>
            {existing?.status === 'changes_requested' ? 'Revise your plan' : 'Plan your training'}
          </Text>
          <Text style={styles.heroLede}>
            {periodName(periodStart, period)} · approved by your manager before it starts
          </Text>
        </View>
      }
      maxSheet={0.85}
    >
      <SegmentedTabs
        options={[
          { value: 'month', label: 'This month' },
          { value: 'quarter', label: 'This quarter' },
        ]}
        value={period}
        onChange={setPeriod}
      />

      {existing?.decisionNote ? (
        <ErrorNotice tone="warning" message={`Your manager: “${existing.decisionNote}”`} />
      ) : null}

      {items.map((it, index) => (
        <Card key={index}>
          <View style={styles.cardHead}>
            <Label>Course {items.length > 1 ? index + 1 : ''}</Label>
            {items.length > 1 ? (
              <Text
                style={styles.remove}
                onPress={() => setItems((prev) => prev.filter((_, i) => i !== index))}
                accessibilityRole="button"
              >
                Remove
              </Text>
            ) : null}
          </View>

          <TextInput
            value={it.title}
            onChangeText={(title) => update(index, { title })}
            placeholder="What is the course?"
            placeholderTextColor={colour.textFaint}
            style={styles.input}
            accessibilityLabel="Course title"
          />
          <TextInput
            value={it.provider ?? ''}
            onChangeText={(provider) => update(index, { provider })}
            placeholder="Who runs it? (optional)"
            placeholderTextColor={colour.textFaint}
            style={styles.input}
            accessibilityLabel="Provider"
          />

          <SegmentedTabs
            options={[
              { value: 'virtual', label: 'Virtual' },
              { value: 'physical', label: 'In person' },
            ]}
            value={it.mode}
            onChange={(mode) => update(index, { mode })}
          />

          <View style={styles.row}>
            <View style={styles.grow}>
              <Label>Starts</Label>
              <TextInput
                value={it.startDate}
                onChangeText={(startDate) => update(index, { startDate })}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colour.textFaint}
                style={styles.input}
                accessibilityLabel="Start date"
              />
            </View>
            <View style={styles.grow}>
              <Label>Ends</Label>
              <TextInput
                value={it.endDate}
                onChangeText={(endDate) => update(index, { endDate })}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colour.textFaint}
                style={styles.input}
                accessibilityLabel="End date"
              />
            </View>
          </View>

          <Label>Why you need it</Label>
          <TextInput
            value={it.need}
            onChangeText={(need) => update(index, { need })}
            placeholder="What it fixes or unlocks in your work this period"
            placeholderTextColor={colour.textFaint}
            style={[styles.input, styles.multiline]}
            multiline
            accessibilityLabel="Why you need it"
          />

          <Label>Cost in ₦ (optional)</Label>
          <TextInput
            value={it.cost}
            onChangeText={(cost) => update(index, { cost: cost.replace(/[^\d.]/g, '') })}
            placeholder="0 if free"
            placeholderTextColor={colour.textFaint}
            keyboardType="decimal-pad"
            style={styles.input}
            accessibilityLabel="Cost"
          />

          {problems[index] && (it.title || it.need) ? (
            <Text style={styles.problem}>{problems[index]}</Text>
          ) : null}
        </Card>
      ))}

      <Button
        label="Add another course"
        variant="ghost"
        onPress={() => setItems((prev) => [...prev, blank(periodStart)])}
      />

      {error ? <ErrorNotice message={error} /> : null}

      <View style={styles.row}>
        <Button
          label="Submit for approval"
          disabled={!valid}
          loading={save.isPending && save.variables?.submit === true}
          onPress={() => void go(true)}
          style={styles.grow}
        />
        <Button
          label="Save draft"
          variant="secondary"
          disabled={!valid}
          loading={save.isPending && save.variables?.submit === false}
          onPress={() => void go(false)}
        />
      </View>
    </HeroSheet>
  )
}

const styles = StyleSheet.create({
  heroTitle: {
    fontSize: font.size.display,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    lineHeight: 40,
    fontFamily: font.family,
  },
  heroLede: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family, paddingBottom: space.lg },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  remove: { fontSize: font.size.sm, color: colour.danger, fontWeight: font.weight.semibold },
  input: {
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: 46,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surfaceSunken,
    fontFamily: font.family,
  },
  multiline: { minHeight: 84, paddingTop: space.md, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: space.sm },
  grow: { flex: 1, gap: space.xs },
  problem: { fontSize: font.size.sm, color: colour.warning, fontFamily: font.family },
})
