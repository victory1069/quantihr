/**
 * My actions — tasks assigned to you out of meetings (spec §9).
 *
 * Every row carries the meeting it came from and the line that was actually
 * said. That quote is not decoration: it is how someone decides whether a task
 * is really theirs without having to relitigate the meeting, and it is what
 * makes a wrongly-assigned action obvious instead of arguable.
 *
 * Nothing reaches this screen before the host has confirmed it.
 */

import { RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  Appear,
  Badge,
  Button,
  Card,
  EmptyState,
  Screen,
  Skeleton,
} from '../src/ui/components'
import { Label } from '../src/ui/primitives'
import { colour, font, radius, space } from '../src/ui/theme'
import { keys, useCompleteTask, useTasks, type TaskItem } from '../src/api/queries'

export default function Tasks() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const tasks = useTasks('open')
  const complete = useCompleteTask()

  const rows = tasks.data?.tasks ?? []
  const overdue = rows.filter(isOverdue)

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={tasks.isRefetching}
          onRefresh={() => queryClient.invalidateQueries({ queryKey: keys.tasks('open') })}
          tintColor={colour.primary}
        />
      }
    >
      <Appear index={0}>
        <Label>
          {rows.length === 0
            ? 'Nothing outstanding'
            : `${rows.length} open${overdue.length > 0 ? ` · ${overdue.length} overdue` : ''}`}
        </Label>
      </Appear>

      {tasks.isLoading ? (
        <>
          <Skeleton height={120} />
          <Skeleton height={120} />
        </>
      ) : rows.length === 0 ? (
        <Appear index={1}>
          <EmptyState
            title="Nothing on your plate"
            body="Tasks you take on in a meeting land here once the host has confirmed them."
          />
        </Appear>
      ) : (
        rows.map((task, index) => (
          <Appear key={task.id} index={1 + index}>
            <Card>
              <View style={styles.head}>
                <Text style={styles.description}>{task.description}</Text>
                {isOverdue(task) ? (
                  <Badge label="Overdue" tone="danger" />
                ) : task.dueDate ? (
                  <Badge label={formatDue(task.dueDate)} tone="neutral" />
                ) : null}
              </View>

              {/* The verbatim line. If this does not sound like something you
                  said, that is the signal to push back on it. */}
              <View style={styles.quote}>
                <Text style={styles.quoteText}>“{task.sourceQuote}”</Text>
              </View>

              <Text
                style={styles.source}
                accessibilityRole="link"
                onPress={() => router.push(`/meetings/${task.meetingId}`)}
              >
                {task.meetingTitle} · {formatDate(task.meetingDate)}
              </Text>

              <Button
                label="Mark done"
                variant="secondary"
                loading={complete.isPending && complete.variables === task.id}
                onPress={() => complete.mutate(task.id)}
              />
            </Card>
          </Appear>
        ))
      )}
    </Screen>
  )
}

function isOverdue(task: TaskItem): boolean {
  if (!task.dueDate) return false
  return task.dueDate < new Date().toISOString().slice(0, 10)
}

function formatDue(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  description: {
    flex: 1,
    fontSize: font.size.md,
    color: colour.text,
    fontWeight: font.weight.semibold,
    lineHeight: 22,
    fontFamily: font.family,
  },

  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colour.borderStrong,
    paddingLeft: space.md,
    borderRadius: radius.sm,
  },
  quoteText: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 21,
    fontStyle: 'italic',
    fontFamily: font.family,
  },

  source: {
    fontSize: font.size.sm,
    color: colour.primary,
    fontFamily: font.family,
  },
})
