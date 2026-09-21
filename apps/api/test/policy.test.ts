/**
 * The policy library and the self-service assistant.
 *
 * Extraction runs against real documents built in the test, not mocks — a
 * parser that works on the fixture but not on a PDF from Word is the kind of
 * failure that only shows up with a customer's file. The model is stubbed, as
 * everywhere, but the stub is shaped as the SDK response so the safety net
 * over its output is exercised rather than bypassed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../src/server.js'
import type { Database } from '../src/db/client.js'
import { policyDocuments } from '../src/db/schema.js'
import { setAnthropicClient } from '../src/lib/anthropic.js'
import { resetEnvCache } from '../src/lib/env.js'
import { extractPolicyText, renderCorpus } from '../src/lib/policy.js'
import { signAccessToken } from '../src/lib/tokens.js'
import { bearer, makeDatabase, makeOrg, type TestOrg } from './helpers.js'

let db: Database
let app: FastifyInstance
let org: TestOrg
let other: TestOrg
let hrToken: string
let otherHrToken: string

function stubAnswer(output: unknown): void {
  setAnthropicClient({
    messages: {
      async parse() {
        return {
          stop_reason: 'end_turn',
          stop_details: null,
          parsed_output: output,
          usage: {
            input_tokens: 9000,
            output_tokens: 200,
            cache_read_input_tokens: 8800,
            cache_creation_input_tokens: 0,
          },
        }
      },
    },
  } as never)
}

/** A one-page PDF containing the given text, built without a PDF library. */
function tinyPdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, (c) => `\\${c}`)
  const stream = `BT /F1 12 Tf 40 750 Td (${safe}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key-a-stub-answers'
  resetEnvCache()

  db = await makeDatabase()
  org = await makeOrg(db, 'acme')
  other = await makeOrg(db, 'globex')
  app = await buildServer(db)
  await app.ready()

  const hr = (o: TestOrg, device: string) =>
    signAccessToken({
      userId: o.managerUserId,
      orgId: o.orgId,
      employeeId: o.managerEmployeeId,
      roles: ['employee', 'hr_admin'],
      deviceId: device,
    })
  hrToken = await hr(org, 'hr-acme')
  otherHrToken = await hr(other, 'hr-globex')
})

afterAll(async () => {
  setAnthropicClient(null)
  delete process.env.ANTHROPIC_API_KEY
  resetEnvCache()
  await app.close()
  await db.close()
})

beforeEach(async () => {
  for (const o of [org, other]) {
    await db.withTenant(o.orgId, async (tx) => {
      await tx.delete(policyDocuments)
    })
  }
})

const upload = (token: string, title: string, filename: string, mimeType: string, buf: Buffer) =>
  app.inject({
    method: 'POST',
    url: '/v1/admin/policies',
    headers: bearer(token),
    payload: { title, filename, mimeType, contentBase64: buf.toString('base64') },
  })

describe('extraction', () => {
  it('reads text out of a real PDF', async () => {
    const text = await extractPolicyText(
      tinyPdf('Annual leave is 20 working days per year.'),
      'pdf',
    )
    expect(text).toContain('Annual leave is 20 working days')
  })

  it('reads text out of a real Word document', async () => {
    // Built with a different library from the one that reads it: docx writes,
    // mammoth reads. Not as strong as a file saved from Word, but it exercises
    // the real container rather than a mock.
    const { Document, Packer, Paragraph } = await import('docx')

    const doc = new Document({
      sections: [{ children: [new Paragraph('Sick leave requires a medical certificate after two days.')] }],
    })
    const buf = Buffer.from(await Packer.toBuffer(doc))
    const text = await extractPolicyText(buf, 'docx')
    expect(text).toContain('medical certificate')
  })

  it('returns empty rather than throwing on a broken file', async () => {
    expect(await extractPolicyText(Buffer.from('not a pdf at all'), 'pdf')).toBe('')
  })

  it('fences documents so citations can name them', () => {
    const rendered = renderCorpus([
      { id: '1', title: 'Leave Policy', text: 'Twenty days.' },
      { id: '2', title: 'Conduct "Code"', text: 'Be kind.' },
    ])
    expect(rendered).toContain('<document index="1" title="Leave Policy">')
    // A quote in a title would break the attribute, so it is softened.
    expect(rendered).toContain(`title="Conduct 'Code'"`)
  })
})

describe('policy library', () => {
  it('stores an upload with its extracted text', async () => {
    const response = await upload(
      hrToken,
      'Leave Policy',
      'leave.txt',
      'text/plain',
      Buffer.from('Annual leave: 20 days. Notice: 7 days.'),
    )

    expect(response.statusCode).toBe(201)
    expect(response.json().status).toBe('ready')
    expect(response.json().charCount).toBeGreaterThan(20)

    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/policies',
      headers: bearer(hrToken),
    })
    expect(list.json().documents).toHaveLength(1)
  })

  it('flags a document that produced no text rather than hiding it', async () => {
    const response = await upload(
      hrToken,
      'Scanned handbook',
      'scan.pdf',
      'application/pdf',
      Buffer.from('this is not really a pdf'),
    )
    expect(response.statusCode).toBe(201)
    // HR sees "empty" and can fix it; the assistant never reads it.
    expect(response.json().status).toBe('empty')
  })

  it('refuses a file type it cannot read', async () => {
    const response = await upload(
      hrToken,
      'Spreadsheet',
      'rota.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      Buffer.from('x'),
    )
    expect(response.statusCode).toBe(422)
  })

  it('is HR-only to upload', async () => {
    const response = await upload(
      org.accessToken,
      'Sneaky',
      'x.txt',
      'text/plain',
      Buffer.from('x'),
    )
    expect(response.statusCode).toBe(403)
  })
})

describe('asking', () => {
  it('says so when nothing has been uploaded', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers: bearer(org.accessToken),
      payload: { question: 'How much annual leave do I get?' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().answered).toBe(false)
    expect(response.json().documentsConsulted).toBe(0)
  })

  it('answers with citations from the org corpus', async () => {
    await upload(hrToken, 'Leave Policy', 'leave.txt', 'text/plain',
      Buffer.from('Every employee is entitled to 20 working days of annual leave per year.'))

    stubAnswer({
      answered: true,
      answer: 'You get 20 working days of annual leave each year.',
      citations: [
        { document: 'Leave Policy', excerpt: '20 working days of annual leave per year' },
      ],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers: bearer(org.accessToken),
      payload: { question: 'How much annual leave do I get?' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.answered).toBe(true)
    expect(body.citations).toHaveLength(1)
    expect(body.citations[0].document).toBe('Leave Policy')
    expect(body.documentsConsulted).toBe(1)
  })

  it('downgrades an uncited "answer" to not answered', async () => {
    await upload(hrToken, 'Leave Policy', 'leave.txt', 'text/plain', Buffer.from('Some policy.'))

    // A model that claims to answer but cites nothing has broken rule 2. The
    // route catches it before it reaches an employee.
    stubAnswer({ answered: true, answer: 'Probably 20 days.', citations: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers: bearer(org.accessToken),
      payload: { question: 'How much leave?' },
    })

    expect(response.json().answered).toBe(false)
  })

  it('never lets one org question reach another org documents', async () => {
    // Globex uploads a handbook; Acme asks a question. Acme must see zero
    // documents — not a filtered set, none at all.
    await upload(otherHrToken, 'Globex Handbook', 'g.txt', 'text/plain',
      Buffer.from('Globex staff get 30 days of leave.'))

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers: bearer(org.accessToken),
      payload: { question: 'How much leave?' },
    })

    expect(response.json().documentsConsulted).toBe(0)
    expect(response.json().answered).toBe(false)
  })
})
