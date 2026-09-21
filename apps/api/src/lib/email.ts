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

/**
 * First-sign-in email for a provisioned HR admin.
 *
 * Carries both doors: the link, and the temporary password for when the link
 * cannot be opened on the device they are setting up. Either one lands them
 * on the change-password screen before anything else.
 */
export function welcomeEmail(link: string, temporaryPassword: string): EmailMessage {
  return {
    to: '',
    subject: 'Your Quanti HR account is ready',
    html: shell(
      'Your account is ready',
      `<p style="font-size:15px;line-height:23px;color:#22333f;margin:0 0 20px;">
         Tap the button to sign in. The link works once and lasts 24 hours.
       </p>
       <a href="${link}"
          style="display:inline-block;background:#06111A;color:#ffffff;text-decoration:none;
                 font-size:15px;font-weight:600;padding:14px 28px;border-radius:10px;">
         Sign in
       </a>
       <p style="font-size:14px;line-height:22px;color:#22333f;margin:28px 0 6px;">
         Or sign in with your email and this temporary password:
       </p>
       <p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;letter-spacing:2px;
                 color:#06111A;background:#f4f6f8;padding:12px 16px;border-radius:8px;display:inline-block;margin:0;">
         ${temporaryPassword}
       </p>
       <p style="font-size:13px;line-height:20px;color:#6b7f8d;margin:20px 0 0;">
         You will be asked to choose your own password the first time you sign in.
       </p>`,
      `If you were not expecting this, ignore it — nothing happens until the link is opened
       or the password is used, and both stop working once you have chosen your own.`,
    ),
    text: `Your Quanti HR account is ready

Sign in with this link (works once, lasts 24 hours):
${link}

Or sign in with your email and this temporary password:
${temporaryPassword}

You will be asked to choose your own password the first time you sign in.`,
  }
}

/** The six-digit code that proves someone controls the company's hr@ address. */
export function signupCodeEmail(code: string, orgName: string): EmailMessage {
  const spaced = code.split('').join(' ')
  return {
    to: '',
    subject: `${code} is your Quanti HR verification code`,
    html: shell(
      'Confirm your HR address',
      `<p style="font-size:15px;line-height:23px;color:#22333f;margin:0 0 20px;">
         Enter this code to finish creating <strong>${orgName}</strong> on Quanti HR.
         It expires in 15 minutes.
       </p>
       <p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;letter-spacing:8px;
                 color:#06111A;background:#f4f6f8;padding:16px 20px;border-radius:8px;display:inline-block;margin:0;">
         ${spaced}
       </p>`,
      `If you did not start creating a company on Quanti HR, ignore this email — nothing is
       created until the code is entered.`,
    ),
    text: `Confirm your HR address

Enter this code to finish creating ${orgName} on Quanti HR. It expires in 15 minutes.

${code}

If you did not start this, ignore this email.`,
  }
}

/** After a self-serve signup: they chose their own password, so just the way in. */
export function signupWelcomeEmail(link: string, orgName: string): EmailMessage {
  return {
    to: '',
    subject: `${orgName} is set up on Quanti HR`,
    html: shell(
      `Welcome to Quanti HR`,
      `<p style="font-size:15px;line-height:23px;color:#22333f;margin:0 0 20px;">
         <strong>${orgName}</strong> is ready. Sign in with the password you chose, or tap the
         button — the link works once and lasts 24 hours. The setup wizard walks you through
         your company details, leave policy, managers and team before anyone else is let in.
       </p>
       <a href="${link}"
          style="display:inline-block;background:#06111A;color:#ffffff;text-decoration:none;
                 font-size:15px;font-weight:600;padding:14px 28px;border-radius:10px;">
         Open the console
       </a>`,
      `You are receiving this because this address was used to create ${orgName} on Quanti HR.`,
    ),
    text: `Welcome to Quanti HR

${orgName} is ready. Sign in with the password you chose, or open this link (works once, lasts 24 hours):
${link}

The setup wizard walks you through your company details, leave policy, managers and team.`,
  }
}

/**
 * Two mails for a new team member, sent together. The first says what
 * Quanti is; the second is the one they keep — their sign-in and the
 * temporary password. Split so the credentials mail is short enough to
 * read on a phone and forward to nobody.
 */
export function memberWelcomeEmail(firstName: string, orgName: string): EmailMessage {
  return {
    to: '',
    subject: `Welcome to Quanti HR, ${firstName}`,
    html: shell(
      `Welcome, ${firstName}`,
      `<p style="font-size:15px;line-height:23px;color:#22333f;margin:0 0 16px;">
         <strong>${orgName}</strong> runs its HR on Quanti. This is where you will check in,
         book leave, read your payslips, keep your documents, plan your training and ask
         questions about company policy — from your phone, with no forms and no waiting.
       </p>
       <p style="font-size:15px;line-height:23px;color:#22333f;margin:0 0 16px;">
         A second email is on its way with your sign-in details. Install the Quanti HR app,
         sign in once, and choose your own password. After that your fingerprint or face
         is enough.
       </p>
       <p style="font-size:13px;line-height:20px;color:#6b7f8d;margin:0;">
         ${orgName} can see your leave, attendance and payroll data. It cannot see your
         location outside a check-in, or anything else on your phone.
       </p>`,
      `You are receiving this because ${orgName} added you to its team on Quanti HR.`,
    ),
    text: `Welcome, ${firstName}

${orgName} runs its HR on Quanti. This is where you will check in, book leave, read your payslips, keep your documents, plan your training and ask questions about company policy.

A second email is on its way with your sign-in details. Install the Quanti HR app, sign in once, and choose your own password.

${orgName} can see your leave, attendance and payroll data. It cannot see your location outside a check-in, or anything else on your phone.`,
  }
}

export function memberCredentialsEmail(input: {
  firstName: string
  orgName: string
  email: string
  temporaryPassword: string
  offerLetter: boolean
  appUrl: string
}): EmailMessage {
  const offer = input.offerLetter
    ? `<p style="font-size:15px;line-height:23px;color:#22333f;margin:20px 0 0;">
         <strong>Your offer letter is waiting in the app.</strong> Read it and acknowledge it
         to complete your onboarding — your acknowledgement is recorded with the date.
       </p>`
    : ''
  return {
    to: '',
    subject: `You have been added to ${input.orgName} on Quanti HR`,
    html: shell(
      `You are on the team`,
      `<p style="font-size:15px;line-height:23px;color:#22333f;margin:0 0 20px;">
         Sign in to the Quanti HR app with these. You will be asked to choose your own
         password the first time; this one stops working after that.
       </p>
       <table style="border-collapse:collapse;font-size:15px;color:#22333f;">
         <tr><td style="padding:4px 16px 4px 0;color:#6b7f8d;">Email</td><td style="padding:4px 0;"><strong>${input.email}</strong></td></tr>
         <tr><td style="padding:4px 16px 4px 0;color:#6b7f8d;">Temporary password</td>
             <td style="padding:4px 0;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;letter-spacing:2px;"><strong>${input.temporaryPassword}</strong></td></tr>
       </table>
       ${offer}
       <p style="font-size:13px;line-height:20px;color:#6b7f8d;margin:20px 0 0;">
         On a computer you can also use ${input.appUrl}.
       </p>`,
      `Keep this email to yourself. If you did not expect it, tell ${input.orgName}'s HR team.`,
    ),
    text: `You are on the team

Sign in to the Quanti HR app with these. You will be asked to choose your own password the first time; this one stops working after that.

Email: ${input.email}
Temporary password: ${input.temporaryPassword}
${input.offerLetter ? '\nYour offer letter is waiting in the app. Read it and acknowledge it to complete your onboarding.\n' : ''}
On a computer you can also use ${input.appUrl}.

Keep this email to yourself.`,
  }
}

export function passwordResetEmail(firstName: string, temporaryPassword: string): EmailMessage {
  return {
    to: '',
    subject: 'Your Quanti HR password was reset',
    html: shell(
      `A new temporary password, ${firstName}`,
      `<p style="font-size:15px;line-height:23px;color:#22333f;margin:0 0 20px;">
         Your HR team reset your password. Sign in with this one and you will be asked to
         choose your own straight away.
       </p>
       <p style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:20px;letter-spacing:2px;
                 color:#06111A;background:#f4f6f8;padding:12px 16px;border-radius:8px;display:inline-block;margin:0;">
         ${temporaryPassword}
       </p>`,
      `If you did not ask for this, tell your HR team — the old password no longer works.`,
    ),
    text: `Your HR team reset your Quanti HR password. Sign in with this temporary password and choose your own straight away:

${temporaryPassword}

If you did not ask for this, tell your HR team.`,
  }
}
