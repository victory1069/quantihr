/**
 * Self-serve company signup.
 *
 * A company creates itself on Quanti by proving it controls its HR mailbox.
 * The address has to start with "hr" — the one address a company owns that
 * an individual employee does not — and a six-digit code is sent to it. Only
 * when the code comes back is anything created: until then the signup is a
 * pending row holding a hashed password and a hashed code, and it expires.
 *
 * On verification the organisation is provisioned exactly as an operator
 * would have done it, the person is signed in, and the console drops them
 * into the setup wizard, which they cannot leave until it is finished.
 *
 * Rate-limited per address and per IP: the code endpoint is the one place
 * on the platform that sends email to an address nobody has proven yet.
 */

import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { ApiError, ERROR_CODES, schemas } from '@quanti/shared'
import type { Database } from '../db/client.js'
import { sendEmail, signupCodeEmail, signupWelcomeEmail } from '../lib/email.js'
import { env } from '../lib/env.js'
import { hashPassword, passwordProblem } from '../lib/password.js'
import { provisionOrganisation } from '../lib/provision.js'
import { hashToken } from '../lib/tokens.js'
import { RateLimiter } from './invite.js'

const CODE_TTL_MS = 15 * 60_000
const MAX_ATTEMPTS = 5

const startByIp = new RateLimiter(10, 60 * 60_000)
const startByEmail = new RateLimiter(3, 60 * 60_000)
const verifyByIp = new RateLimiter(30, 60_000)

const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

export function registerSignupRoutes(app: FastifyInstance, db: Database): void {
  app.post('/v1/signup/start', async (request, reply) => {
    // Checked before the schema so the person gets the reason in words
    // rather than a generic "failed validation" with the reason buried in
    // details. This is the one rule most people will trip on.
    const raw = (request.body ?? {}) as { email?: unknown }
    const local = typeof raw.email === 'string' ? raw.email.toLowerCase().trim().split('@')[0] : ''
    if (!local?.startsWith('hr')) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        "Use your company's HR mailbox — an address that starts with hr (hr@, hr.team@, hrdesk@…). It proves the company, not just a person, is signing up.",
        422,
      )
    }
    const body = schemas.auth.signupStart.parse(request.body)

    if (!startByIp.check(request.ip) || !startByEmail.check(body.email)) {
      throw new ApiError(ERROR_CODES.RATE_LIMITED, 'Too many attempts. Try again in an hour.', 429)
    }
    const problem = passwordProblem(body.password, body.email)
    if (problem) throw new ApiError(ERROR_CODES.VALIDATION_FAILED, problem, 422)

    // Unlike sign-in, signup may say an address is taken: the person typing
    // it claims to own it, and "already registered — sign in" is the help
    // they need.
    if (await db.lookup.userByEmail(body.email)) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        'That address already has an account. Sign in instead.',
        409,
      )
    }

    const code = newCode()
    const signupId = await db.lookup.signupCreate({
      email: body.email,
      orgName: body.orgName.trim(),
      firstName: body.firstName.trim(),
      lastName: body.lastName.trim(),
      passwordHash: await hashPassword(body.password),
      codeHash: hashToken(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    })

    await deliverCode(request, signupId, body.email, body.orgName, code)

    return reply.status(201).send({
      signupId,
      message: `We sent a 6-digit code to ${body.email}. Enter it to confirm the address.`,
      ...(env().NODE_ENV !== 'production' ? { devCode: code } : {}),
    })
  })

  app.post('/v1/signup/resend', async (request, reply) => {
    const { signupId } = schemas.auth.signupResend.parse(request.body)
    const signup = await db.lookup.signupById(signupId)
    if (!signup || signup.verifiedAt) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Start again', 404)
    if (!startByEmail.check(signup.email)) {
      throw new ApiError(ERROR_CODES.RATE_LIMITED, 'Too many codes sent. Try again in an hour.', 429)
    }

    const code = newCode()
    await db.lookup.signupUpdate(signupId, {
      codeHash: hashToken(code),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      attempts: 0,
    })
    await deliverCode(request, signupId, signup.email, signup.orgName, code)

    return reply.send({
      message: `A new code is on its way to ${signup.email}.`,
      ...(env().NODE_ENV !== 'production' ? { devCode: code } : {}),
    })
  })

  app.post('/v1/signup/verify', async (request, reply) => {
    const body = schemas.auth.signupVerify.parse(request.body)
    if (!verifyByIp.check(request.ip)) {
      throw new ApiError(ERROR_CODES.RATE_LIMITED, 'Too many attempts. Wait a minute.', 429)
    }

    const signup = await db.lookup.signupById(body.signupId)
    if (!signup) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Start again', 404)
    if (signup.verifiedAt && signup.orgId) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'Already verified — sign in.', 409)
    }
    if (signup.expiresAt.getTime() < Date.now()) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'That code has expired. Send a new one.', 410)
    }
    if (signup.attempts >= MAX_ATTEMPTS) {
      throw new ApiError(
        ERROR_CODES.RATE_LIMITED,
        'Too many wrong codes. Send a new one to try again.',
        429,
      )
    }
    if (hashToken(body.code) !== signup.codeHash) {
      await db.lookup.signupUpdate(signup.id, { attempts: signup.attempts + 1 })
      const left = MAX_ATTEMPTS - signup.attempts - 1
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        left > 0
          ? `That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`
          : 'That code is not right. Send a new one to try again.',
        422,
      )
    }

    // The address may have been registered between start and verify.
    if (await db.lookup.userByEmail(signup.email)) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        'That address already has an account. Sign in instead.',
        409,
      )
    }

    const result = await provisionOrganisation(db, {
      name: signup.orgName,
      admin: { firstName: signup.firstName, lastName: signup.lastName, email: signup.email },
      // They chose this password themselves; nothing to force.
      password: { hash: signup.passwordHash, mustChange: false },
      via: 'signup',
      ip: request.ip,
    })
    await db.lookup.signupUpdate(signup.id, { verifiedAt: new Date(), orgId: result.orgId })

    const link = `${env().APP_URL}/auth/callback?token=${result.token}`
    void sendEmail({ ...signupWelcomeEmail(link, result.orgName), to: signup.email })
      .then((sent) =>
        request.log.info({ orgId: result.orgId, messageId: sent.messageId }, 'signup welcome sent'),
      )
      .catch((err: unknown) =>
        request.log.error({ err, orgId: result.orgId }, 'signup welcome failed'),
      )

    return reply.status(201).send({
      organisation: { id: result.orgId, name: result.orgName },
      email: signup.email,
    })
  })
}

async function deliverCode(
  request: { log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void } },
  signupId: string,
  email: string,
  orgName: string,
  code: string,
): Promise<void> {
  try {
    const sent = await sendEmail({ ...signupCodeEmail(code, orgName), to: email })
    request.log.info({ signupId, messageId: sent.messageId, driver: sent.driver }, 'signup code sent')
  } catch (err) {
    request.log.error({ err, signupId }, 'signup code delivery failed')
    throw new ApiError(
      ERROR_CODES.INTERNAL,
      'We could not send the code just now. Try again in a moment.',
      502,
    )
  }
}
