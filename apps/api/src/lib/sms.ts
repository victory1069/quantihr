/**
 * Transactional SMS — the phone-verification code on the sign-up flow.
 *
 * **Why Termii is the default rather than Twilio.** Most Nigerian mobile
 * numbers are registered on the NCC's Do-Not-Disturb list, which blocks
 * A2P messages on the ordinary route. A code sent down the generic channel to a
 * DND number is accepted by the provider, billed, and never delivered — the
 * worst possible failure, because everything reports success while the employee
 * stares at a screen waiting for a code. Termii exposes a `dnd` channel that
 * reaches those numbers, and prices in Naira at roughly a tenth of what Twilio
 * charges for a Nigerian destination.
 *
 * Twilio is kept behind the same interface for anyone deploying outside
 * Nigeria, and `console` is the default in development so the flow is testable
 * without spending anything.
 */

import { env } from './env.js'

export interface SmsMessage {
  to: string
  body: string
}

export interface SentSms {
  messageId: string | null
  driver: string
}

export interface SmsDriver {
  readonly name: string
  send(message: SmsMessage): Promise<SentSms>
}

export class SmsDeliveryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SmsDeliveryError'
  }
}

/**
 * Normalises a stored number to international format without the `+`.
 *
 * HR records are typed by people, so the same employee's number arrives as
 * `08012345678`, `+234 801 234 5678` or `234-801-234-5678`. Providers accept
 * exactly one of those shapes, and a number that fails to normalise is better
 * rejected here than silently sent somewhere else.
 */
export function normalisePhone(raw: string, defaultCountryCode = '234'): string {
  const digits = raw.replace(/[^\d+]/g, '')

  if (digits.startsWith('+')) return digits.slice(1)
  if (digits.startsWith('00')) return digits.slice(2)

  // A local trunk-prefixed number: drop the leading 0, prepend the country.
  if (digits.startsWith('0')) return `${defaultCountryCode}${digits.slice(1)}`

  // Already international.
  if (digits.startsWith(defaultCountryCode)) return digits

  return `${defaultCountryCode}${digits}`
}

const consoleDriver: SmsDriver = {
  name: 'console',
  async send(message) {
    // eslint-disable-next-line no-console
    console.log(`[sms] → ${message.to}: ${message.body}`)
    return { messageId: null, driver: 'console' }
  },
}

/**
 * Termii.
 *
 * The response is a 200 with a body describing the failure in several error
 * cases, so the body is inspected rather than trusting the status code.
 */
const termiiDriver: SmsDriver = {
  name: 'termii',
  async send(message) {
    const key = env().TERMII_API_KEY
    if (!key) throw new SmsDeliveryError('TERMII_API_KEY is not set')

    const response = await fetch(`${env().TERMII_API_BASE}/api/sms/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: normalisePhone(message.to),
        from: env().TERMII_SENDER_ID,
        sms: message.body,
        type: 'plain',
        // See the note at the top of this file. `dnd` is what reaches a number
        // on the do-not-disturb register; `generic` silently will not.
        channel: env().TERMII_CHANNEL,
        api_key: key,
      }),
    })

    const body = (await response.json().catch(() => null)) as {
      message_id?: string
      message?: string
      code?: string
    } | null

    if (!response.ok || !body?.message_id) {
      throw new SmsDeliveryError(
        `Termii rejected the message: ${body?.message ?? `HTTP ${response.status}`}`,
      )
    }

    return { messageId: body.message_id, driver: 'termii' }
  },
}

const twilioDriver: SmsDriver = {
  name: 'twilio',
  async send(message) {
    const sid = env().TWILIO_ACCOUNT_SID
    const token = env().TWILIO_AUTH_TOKEN
    if (!sid || !token) {
      throw new SmsDeliveryError('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required')
    }

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          To: `+${normalisePhone(message.to)}`,
          From: env().TWILIO_FROM ?? '',
          Body: message.body,
        }),
      },
    )

    const body = (await response.json().catch(() => null)) as {
      sid?: string
      message?: string
    } | null

    if (!response.ok || !body?.sid) {
      throw new SmsDeliveryError(
        `Twilio rejected the message: ${body?.message ?? `HTTP ${response.status}`}`,
      )
    }

    return { messageId: body.sid, driver: 'twilio' }
  },
}

export function sms(): SmsDriver {
  switch (env().SMS_DRIVER) {
    case 'termii':
      return termiiDriver
    case 'twilio':
      return twilioDriver
    default:
      return consoleDriver
  }
}

let override: SmsDriver | null = null

/** Test hook — lets a suite capture sends without a network. */
export function setSmsDriver(driver: SmsDriver | null): void {
  override = driver
}

export async function sendSms(message: SmsMessage): Promise<SentSms> {
  return (override ?? sms()).send(message)
}

/**
 * The verification code message.
 *
 * Short, names the product, and carries no link. An SMS with a link in it is
 * the shape of every phishing message people are told to ignore, and the code
 * needs to be readable at a glance from the notification shade.
 */
export function verificationSms(code: string, ttlMinutes: number): string {
  return `${code} is your Quanti HR verification code. It expires in ${ttlMinutes} minutes. If you did not request it, ignore this message.`
}
