/**
 * Todos — everything the app is asking of you.
 *
 * This is the one screen that inverts the product's usual direction. The rest
 * of Quanti tells the employee things; this is where the employer asks them
 * for something, and gathering those asks in one place is what stops a contract
 * sitting unsigned for three weeks because it was mentioned once in a
 * notification.
 *
 * Items are ordered by consequence, not by date: anything with a deadline that
 * lands in a personnel file comes before anything informational.
 */

import { useMemo } from 'react'
import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { Appear, Card, EmptyState, Screen, Skeleton } from '../src/ui/components'
import { Label } from '../src/ui/primitives'
import { colour, font, radius, space } from '../src/ui/theme'
import { useBalances, useDocuments, useLeaveRequests } from '../src/api/queries'
import { useSession } from '../src/store/session'

type Urgency = 'action' | 'waiting' | 'info'

interface Todo {
  key: string
  urgency: Urgency
  title: string
  detail: string
  href: string
  due?: string
}

export default function Todos() {
  const router = useRouter()
  const queryClient = useQueryClient()

  const documents = useDocuments()
  const requests = useLeaveRequests('pending')
  const balances = useBalances()
  const deviceReview = useSession((s) => s.deviceReviewRequired)

  const loading = !documents.data || !requests.data || !balances.data

  const todos = useMemo<Todo[]>(() => {
    const items: Todo[] = []

    // 1. Signatures. A deadline, and it lands in the personnel file.
    for (const doc of documents.data?.documents ?? []) {
      if (doc.requiresAcknowledgement && !doc.acknowledgedAt) {
        items.push({
          key: `doc-${doc.id}`,
          urgency: 'action',
          title: doc.name,
          detail: 'Read and acknowledge this document',
          href: '/me',
        })
      }
    }

    // 2. Device approval — blocks nothing, but flags every check-in until done.
    if (deviceReview) {
      items.push({
        key: 'device',
        urgency: 'action',
        title: 'This device needs HR approval',
        detail: 'Check-ins from here are flagged for review until it is approved',
        href: '/me',
      })
    }

    // 3. Expiring carryover — the employee can still act on it.
    for (const balance of balances.data?.balances ?? []) {
      if (balance.carriedOver > 0 && balance.carryoverExpiresOn) {
        items.push({
          key: `expiry-${balance.leaveTypeId}`,
          urgency: 'action',
          title: `${balance.carriedOver} ${balance.leaveTypeName} days expire soon`,
          detail: `Use them before ${balance.carryoverExpiresOn} or they are forfeited`,
          href: '/leave/new',
          due: balance.carryoverExpiresOn,
        })
      }
    }

    // 4. Waiting on someone else. Not an ask, but people look for it here.
    for (const request of requests.data?.requests ?? []) {
      items.push({
        key: `leave-${request.id}`,
        urgency: 'waiting',
        title: `${request.leaveTypeName} · ${request.daysCount} day(s)`,
        detail: `${request.start} → ${request.end} · waiting on your manager`,
        href: `/leave/${request.id}`,
      })
    }

    const rank: Record<Urgency, number> = { action: 0, waiting: 1, info: 2 }
    return items.sort((a, b) => rank[a.urgency] - rank[b.urgency])
  }, [documents.data, requests.data, balances.data, deviceReview])

  const needsAction = todos.filter((t) => t.urgency === 'action')
  const waiting = todos.filter((t) => t.urgency !== 'action')

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={documents.isRefetching || requests.isRefetching}
          onRefresh={() => void queryClient.invalidateQueries()}
          tintColor={colour.primary}
        />
      }
    >
      <Appear index={0}>
        <View style={styles.header}>
          <Text style={styles.title}>Todos</Text>
          {!loading ? (
            <Text style={styles.sub}>
              {needsAction.length === 0
                ? 'Nothing needs you right now'
                : `${needsAction.length} thing${needsAction.length === 1 ? '' : 's'} need you`}
            </Text>
          ) : null}
        </View>
      </Appear>

      {loading ? (
        <Card>
          <Skeleton height={20} />
          <Skeleton height={56} />
        </Card>
      ) : todos.length === 0 ? (
        <Appear index={1}>
          <EmptyState
            title="You're all clear"
            body="Documents to sign, expiring leave and anything else needing your response will appear here."
          />
        </Appear>
      ) : (
        <>
          {needsAction.length > 0 ? (
            <>
              <Appear index={1}>
                <Label tone="accent">Needs you</Label>
              </Appear>
              {needsAction.map((todo, i) => (
                <Appear key={todo.key} index={2 + i}>
                  <TodoCard todo={todo} onPress={() => router.push(todo.href as never)} />
                </Appear>
              ))}
            </>
          ) : null}

          {waiting.length > 0 ? (
            <>
              <Appear index={2 + needsAction.length}>
                <Label>Waiting on someone else</Label>
              </Appear>
              {waiting.map((todo, i) => (
                <Appear key={todo.key} index={3 + needsAction.length + i}>
                  <TodoCard todo={todo} onPress={() => router.push(todo.href as never)} />
                </Appear>
              ))}
            </>
          ) : null}
        </>
      )}
    </Screen>
  )
}

function TodoCard({ todo, onPress }: { todo: Todo; onPress: () => void }) {
  const action = todo.urgency === 'action'
  return (
    <Card tone={action ? 'danger' : 'default'} onPress={onPress}>
      <View style={styles.row}>
        <View
          style={[
            styles.dot,
            { backgroundColor: action ? colour.accent : colour.warning },
          ]}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.itemTitle}>{todo.title}</Text>
          <Text style={styles.itemDetail}>{todo.detail}</Text>
        </View>
        {todo.due ? (
          <View style={styles.duePill}>
            <Text style={styles.dueText}>{todo.due}</Text>
          </View>
        ) : (
          <Text style={styles.chevron}>›</Text>
        )}
      </View>
    </Card>
  )
}

const styles = StyleSheet.create({
  header: { paddingTop: space.sm, gap: 2 },
  title: {
    fontSize: font.size.xxl,
    fontWeight: font.weight.bold,
    color: colour.text,
    letterSpacing: font.tracking.tight,
    fontFamily: font.family,
  },
  sub: { fontSize: font.size.md, color: colour.textMuted, fontFamily: font.family },

  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  dot: { width: 8, height: 8, borderRadius: 4 },
  itemTitle: {
    fontSize: font.size.md,
    fontWeight: font.weight.bold,
    color: colour.text,
    fontFamily: font.family,
  },
  itemDetail: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 19,
    fontFamily: font.family,
  },
  chevron: { fontSize: 22, color: colour.textFaint },

  duePill: {
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colour.warningSoft,
    borderWidth: 1,
    borderColor: colour.warning,
  },
  dueText: {
    fontSize: font.size.xs,
    color: colour.warning,
    fontFamily: font.mono,
    fontWeight: font.weight.bold,
  },
})
