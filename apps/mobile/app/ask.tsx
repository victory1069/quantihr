/**
 * Policy assistant — screens E14 / E15.
 *
 * The chrome is built to the design; the answering is not, and deliberately so.
 *
 * Spec §5.6 sets three non-negotiables: every answer cites the clause it came
 * from, the assistant says "I don't know" rather than improvising, and the
 * corpus is isolated per organisation at the index level. Meeting those needs
 * an embedding model, a retrieval index over uploaded policy documents, and a
 * language model — none of which exist in this build.
 *
 * The screen therefore renders the composer and the answer shapes, and states
 * plainly that it is not connected. A convincing mock would be worse than
 * nothing here: the failure mode of this feature is an employee acting on an
 * invented policy, and the fastest way to get there is a demo that answers.
 */

import { useState } from 'react'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Appear, Button, Card, Screen } from '../src/ui/components'
import { Label } from '../src/ui/primitives'
import { colour, font, radius, space } from '../src/ui/theme'
import { useMe } from '../src/api/queries'

export default function Ask() {
  const router = useRouter()
  const me = useMe()
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<string | null>(null)

  const orgName = me.data?.config.org.name ?? 'your organisation'

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
          <Appear index={1}>
            <View style={styles.question}>
              <Text style={styles.questionText}>{asked}</Text>
            </View>
          </Appear>

          {/* The designed "no answer in corpus" state (E15) is the honest one
              to show while retrieval is unbuilt. */}
          <Appear index={2}>
            <Card style={styles.answer}>
              <Text style={styles.answerText}>
                I can&apos;t answer that yet. The policy assistant is not connected in this
                build — there is no policy corpus uploaded and no retrieval index to search.
              </Text>
              <Text style={styles.answerMuted}>
                I won&apos;t guess at something that affects your pay or your standing. Ask your
                HR team directly for now.
              </Text>
            </Card>
          </Appear>

          <Appear index={3}>
            <Card>
              <Label>What this needs before it can answer</Label>
              <Text style={styles.todo}>
                · Policy documents uploaded per organisation{'\n'}
                · An embedding index, isolated per tenant{'\n'}
                · A language model to draft the cited answer
              </Text>
              <Text style={styles.answerMuted}>
                Retrieval must be isolated at the index level, not by filtering a shared index.
                One organisation&apos;s handbook surfacing in another&apos;s assistant is the
                highest-severity failure in this product.
              </Text>
            </Card>
          </Appear>
        </>
      ) : (
        <Appear index={1}>
          <Card>
            <Text style={styles.intro}>
              Ask about leave, pay, conduct or anything in your handbook. Answers cite the
              policy and clause they came from, and your own figures come from your record
              rather than from a model.
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
            onSubmitEditing={() => {
              if (question.trim()) {
                setAsked(question.trim())
                setQuestion('')
              }
            }}
            accessibilityLabel="Your question"
          />
        </View>
      </Appear>

      <Appear index={5}>
        <Button label="Back" variant="ghost" onPress={() => router.back()} />
      </Appear>
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.sm },
  aiBadge: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    backgroundColor: colour.pending,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiGlyph: { color: colour.text, fontSize: 16 },

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

  answer: { borderColor: 'rgba(123,92,255,0.35)' },
  answerText: {
    fontSize: font.size.md,
    color: colour.text,
    lineHeight: 23,
    fontFamily: font.family,
  },
  answerMuted: {
    fontSize: font.size.sm,
    color: colour.textMuted,
    lineHeight: 21,
    fontFamily: font.family,
  },
  todo: {
    fontSize: font.size.sm,
    color: colour.text,
    lineHeight: 22,
    fontFamily: font.mono,
  },

  intro: {
    fontSize: font.size.md,
    color: colour.textMuted,
    lineHeight: 23,
    fontFamily: font.family,
  },

  composer: { flexDirection: 'row', gap: space.sm },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colour.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    minHeight: 52,
    fontSize: font.size.md,
    color: colour.text,
    backgroundColor: colour.surface,
    fontFamily: font.family,
  },
})
