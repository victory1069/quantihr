/**
 * Policy assistant — screens E14 / E15.
 *
 * Connected now. It answers from the policies HR uploaded during setup and
 * from nothing else, which is what makes it safe to put in front of someone
 * asking about their own pay or leave.
 *
 * Three states, and all three are designed rather than defaulted:
 *
 *   - **Answered**, with every claim tied to a named document and a quoted
 *     line. The citations are not decoration; they are what lets the employee
 *     check the assistant rather than trust it.
 *   - **Not answered** — the documents do not cover it. Rendered as a proper
 *     state (screen E15), never as an error, because "I don't know" is the
 *     correct answer to a question the handbook does not address and an
 *     employee should feel fine asking HR instead.
 *   - **Not available** — nothing uploaded yet, or the assistant is not
 *     connected on this deployment. Says which.
 */

import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Appear, Button, Card, Screen, Skeleton } from '../src/ui/components'
import { Label } from '../src/ui/primitives'
import { colour, font, radius, space } from '../src/ui/theme'
import { useAskPolicy, useMe, type AskResult } from '../src/api/queries'

export default function Ask() {
  const router = useRouter()
  const me = useMe()
  const ask = useAskPolicy()
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<string | null>(null)

  const orgName = me.data?.config.org.name ?? 'your organisation'

  const submit = () => {
    const q = question.trim()
    if (q.length < 3 || ask.isPending) return
    setAsked(q)
    setQuestion('')
    ask.mutate(q)
  }

  return (
    <Screen>
      <Appear index={0}>
        <View style={styles.header}>
          <View style={styles.aiBadge}>
            <Text style={styles.aiGlyph}>✦</Text>
          </View>
          <Label tone="violet">Ask Quanti · {orgName} policies</Label>
        </View>
      </Appear>

      {asked ? (
        <>
          <Appear index={1} from="side">
            <View style={styles.question}>
              <Text style={styles.questionText}>{asked}</Text>
            </View>
          </Appear>

          <Appear index={2}>
            {ask.isPending ? (
              <Card style={styles.answer}>
                <Skeleton height={16} />
                <Skeleton height={16} width="80%" />
                <Skeleton height={16} width="60%" />
              </Card>
            ) : ask.isError ? (
              <Card style={styles.answer}>
                <Text style={styles.answerText}>
                  That could not be answered right now. Ask your HR team directly for the
                  time being.
                </Text>
              </Card>
            ) : ask.data ? (
              <Answer result={ask.data} />
            ) : null}
          </Appear>
        </>
      ) : (
        <Appear index={1}>
          <Card>
            <Text style={styles.intro}>
              Ask about leave, pay, conduct or anything in your handbook. Every answer cites
              the policy and the line it came from, and if the policies do not cover it,
              it says so rather than guessing.
            </Text>
          </Card>
        </Appear>
      )}

      <Appear index={4}>
        <View style={styles.composer}>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            placeholder="Ask about leave, pay, conduct…"
            placeholderTextColor={colour.textFaint}
            style={styles.input}
            onSubmitEditing={submit}
            returnKeyType="send"
            editable={!ask.isPending}
            accessibilityLabel="Your question"
          />
        </View>
      </Appear>

      <Appear index={5}>
        <Button
          label="Ask"
          onPress={submit}
          disabled={question.trim().length < 3}
          loading={ask.isPending}
        />
      </Appear>

      <Appear index={6}>
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </Appear>
    </Screen>
  )
}

function Answer({ result }: { result: AskResult }) {
  if (result.documentsConsulted === 0 || result.model === null) {
    // Nothing to search, or the assistant is not connected. The server says
    // which in `answer`; either way the honest state is "ask HR".
    return (
      <Card style={styles.answer}>
        <Text style={styles.answerText}>{result.answer}</Text>
      </Card>
    )
  }

  if (!result.answered) {
    return (
      <Card style={styles.answer}>
        <Label>Not in your policies</Label>
        <Text style={styles.answerText}>{result.answer}</Text>
        <Text style={styles.answerMuted}>
          I only answer from what {`your organisation`} has uploaded, and I will not guess at
          something that affects your pay or your standing. Ask your HR team directly.
        </Text>
      </Card>
    )
  }

  return (
    <Card style={styles.answer}>
      <Text style={styles.answerText}>{result.answer}</Text>

      <View style={styles.citations}>
        <Label>From your policies</Label>
        {result.citations.map((c, i) => (
          <View key={i} style={styles.citation}>
            <Text style={styles.citationDoc}>{c.document}</Text>
            <Text style={styles.citationExcerpt}>“{c.excerpt}”</Text>
          </View>
        ))}
      </View>

      <Text style={styles.answerMuted}>
        Checked against {result.documentsConsulted}{' '}
        {result.documentsConsulted === 1 ? 'document' : 'documents'}. If something here
        looks wrong, the quoted line is what to show HR.
      </Text>
    </Card>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.sm },
  aiBadge: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colour.pendingSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiGlyph: { color: colour.pending, fontSize: 16 },

  question: {
    alignSelf: 'flex-end',
    maxWidth: '85%',
    backgroundColor: colour.primary,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  questionText: {
    fontSize: font.size.md,
    color: colour.primaryText,
    fontWeight: font.weight.semibold,
    fontFamily: font.family,
  },

  answer: { borderColor: colour.pendingSoft },
  answerText: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 21,
    fontFamily: font.family,
  },
  answerMuted: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 19,
    fontFamily: font.family,
  },

  citations: { gap: space.sm, paddingTop: space.xs },
  citation: {
    borderLeftWidth: 3,
    borderLeftColor: colour.pending,
    paddingLeft: space.md,
    gap: 2,
  },
  citationDoc: {
    fontSize: font.size.xs,
    color: colour.textMuted,
    fontFamily: font.mono,
    textTransform: 'uppercase',
    letterSpacing: font.tracking.wide,
  },
  citationExcerpt: {
    fontSize: font.size.sm,
    color: colour.text,
    lineHeight: 19,
    fontStyle: 'italic',
    fontFamily: font.family,
  },

  intro: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 21,
    fontFamily: font.family,
  },

  composer: { flexDirection: 'row', gap: space.sm },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    minHeight: 48,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surface,
    fontFamily: font.family,
  },
})
