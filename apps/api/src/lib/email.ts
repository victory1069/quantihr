/**
 * Transactional email.
 *
 * The magic link IS the authentication mechanism (spec §9), so this is not a
 * notification channel that can degrade quietly — if mail stops, nobody can
 * sign in. That shapes three decisions here:
 *
 *   1. **Three drivers, one interface.** `ses` is the cheap production default
 *      at $0.10 per thousand. `smtp` covers Resend, Postmark, Mailgun and
 *      anything else with SMTP credentials, which matters because a new AWS
 *      account starts in the SES sandbox and can only mail verified addresses
 *      until support lifts it — usually a day, sometimes longer. Being able to
 *      launch on Resend and move to SES later is worth thirty lines.
 *   2. **Every send is logged with its provider message id.** When someone says
 *      the link never arrived, the first question is whether it left.
 *   3. **Plain text alongside HTML, always.** A text/html-only message with a
 *      single link is a spam-filter signature.
 */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'
import { createTransport, type Transporter } from 'nodemailer'
import { env } from './env.js'

export interface EmailMessage {
  to: string
  subject: string
  html: string
  text: string
}

export interface SentEmail {
  /** Provider message id, for tracing a delivery complaint back to a send. */
  messageId: string | null
  driver: string
}

export interface EmailDriver {
  readonly name: string
  send(message: EmailMessage): Promise<SentEmail>
}

const consoleDriver: EmailDriver = {
  name: 'console',
  async send(message) {
    // eslint-disable-next-line no-console
    console.log(`[email] → ${message.to}: ${message.subject}\n${message.text}`)
    return { messageId: null, driver: 'console' }
  },
}

let ses: SESv2Client | null = null

const sesDriver: EmailDriver = {
  name: 'ses',
  async send(message) {
    ses ??= new SESv2Client({ region: env().AWS_REGION })

    const result = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: env().EMAIL_FROM,
        Destination: { ToAddresses: [message.to] },
        // A configuration set is what routes bounces and complaints to SNS.
        // Without one, a hard bounce is invisible and the address keeps being
        // mailed until SES throttles the whole account.
        ...(env().SES_CONFIGURATION_SET
          ? { ConfigurationSetName: env().SES_CONFIGURATION_SET }
          : {}),
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: message.html, Charset: 'UTF-8' },
              Text: { Data: message.text, Charset: 'UTF-8' },
            },
          },
        },
      }),
    )

    return { messageId: result.MessageId ?? null, driver: 'ses' }
  },
}

let transporter: Transporter | null = null

const smtpDriver: EmailDriver = {
  name: 'smtp',
  async send(message) {
    if (!transporter) {
      const host = env().SMTP_HOST
      if (!host) {
        throw new Error('SMTP_HOST is required when EMAIL_DRIVER=smtp')
      }
      transporter = createTransport({
        host,
        port: env().SMTP_PORT,
        // 465 is implicit TLS; 587 upgrades with STARTTLS.
        secure: env().SMTP_PORT === 465,
        auth: env().SMTP_USER
          ? { user: env().SMTP_USER!, pass: env().SMTP_PASSWORD ?? '' }
          : undefined,
      })
    }

    const result = await transporter.sendMail({
      from: env().EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    })

    return { messageId: result.messageId ?? null, driver: 'smtp' }
  },
}

export function email(): EmailDriver {
  switch (env().EMAIL_DRIVER) {
    case 'ses':
      return sesDriver
    case 'smtp':
      return smtpDriver
    default:
      return consoleDriver
  }
}

/** Test hook — lets a suite capture sends without a network. */
let override: EmailDriver | null = null

export function setEmailDriver(driver: EmailDriver | null): void {
  override = driver
  ses = null
  transporter = null
}

export async function sendEmail(message: EmailMessage): Promise<SentEmail> {
  return (override ?? email()).send(message)
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * One shell for every transactional email.
 *
 * Deliberately plain: a table-free, image-free, single-column message renders
 * the same in Outlook as in Gmail, and there is nothing here worth the risk of
 * a layout that collapses on a phone. Inline styles because email clients strip
 * `<style>` blocks.
 */
function shell(heading: string, body: string, footer: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <div style="font-size:18px;font-weight:700;color:#06111A;letter-spacing:-0.3px;">Quanti HR</div>
      <h1 style="font-size:20px;font-weight:600;color:#06111A;margin:24px 0 12px;">${heading}</h1>
      ${body}
      <hr style="border:none;border-top:1px solid #e6ebef;margin:28px 0 16px;" />
      <div style="font-size:12px;line-height:18px;color:#6b7f8d;">${footer}</div>
    </div>
  </body>
</html>`
}

export function magicLinkEmail(link: string, ttlMinutes: number): EmailMessage {
  const expiry = `${ttlMinutes} minute${ttlMinutes === 1 ? '' : 's'}`

  return {
    to: '',
    subject: 'Your Quanti HR sign-in link',
    html: shell(
      'Sign in to Quanti HR',
      `<p style="font-size:15px;line-height:23px;color:#22333f;margin:0 0 24px;">
         Tap the button below to sign in. The link works once and expires in ${expiry}.
       </p>
       <a href="${link}"
          style="display:inline-block;background:#06111A;color:#ffffff;text-decoration:none;
                 font-size:15px;font-weight:600;padding:14px 28px;border-radius:10px;">
         Sign in
       </a>
       <p style="font-size:13px;line-height:20px;color:#6b7f8d;margin:24px 0 0;">
         If the button does not work, paste this into your browser:<br />
         <span style="color:#22333f;word-break:break-all;">${link}</span>
       </p>`,
      `You are receiving this because someone asked for a sign-in link for this address.
       If that was not you, ignore this email — the link cannot be used without opening it,
       and nobody has access to your account.`,
    ),
    text: `Sign in to Quanti HR

Open this link to sign in. It works once and expires in ${expiry}.

${link}

If you did not ask for this, ignore this email.`,
  }
}
