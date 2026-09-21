/**
 * Platform provisioning — how a new organisation gets onto Quanti.
 *
 * There is deliberately no public signup. One design partner does not need a
 * form that anyone on the internet can create an organisation through, and a
 * form like that needs email verification, rate limits and a story for junk
 * orgs before it is safe to expose. Instead an operator with the platform key
 * creates the organisation and its first HR admin, and that person receives a
 * sign-in link and lands in the setup wizard.
 *
 * **Authentication is a shared secret, not a JWT.** The JWT layer is tenant
 * scoped — every claim carries an org_id — and provisioning happens before an
 * org exists. The key is compared in constant time and the route refuses to
 * run at all when no key is configured, so a deployment cannot accidentally
 * expose an open org-creation endpoint by forgetting an env var.
 *
 * Creation follows the seed's pattern: pre-generate the id, set the tenant
 * claim, then insert. The organisation's own RLS policy has a WITH CHECK on
 * `id = app.org_id`, so the row passes because the claim already names it.
 * No bypass and no privileged connection.
 */

import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ApiError, ERROR_CODES } from '@quanti/shared'
import type { Database } from '../db/client.js'
import { sendEmail, welcomeEmail } from '../lib/email.js'
import { generateTemporaryPassword, hashPassword } from '../lib/password.js'
import { env } from '../lib/env.js'
import { provisionOrganisation } from '../lib/provision.js'
import { hashToken } from '../lib/tokens.js'

const provisionRequest = z.object({
  name: z.string().min(2).max(120),
  country: z.string().length(2).default('NG'),
  timezone: z.string().min(3).default('Africa/Lagos'),
  admin: z.object({
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    email: z.string().email(),
    phone: z.string().max(32).optional(),
  }),
})

/**
 * Compares the presented key against the configured one without leaking the
 * length or a prefix through timing. Both are hashed first so a mismatch in
 * length does not short-circuit before the comparison.
 */
function keyMatches(presented: string | undefined, configured: string): boolean {
  if (!presented) return false
  const a = hashToken(presented)
  const b = hashToken(configured)
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function registerPlatformRoutes(app: FastifyInstance, db: Database): void {
  app.post('/v1/platform/organisations', async (request, reply) => {
    const configured = env().PLATFORM_API_KEY
    if (!configured) {
      throw new ApiError(
        ERROR_CODES.INTERNAL,
        'Provisioning is not enabled on this deployment. Set PLATFORM_API_KEY.',
        503,
      )
    }

    const presented = request.headers['x-platform-key']
    if (!keyMatches(typeof presented === 'string' ? presented : undefined, configured)) {
      // Same shape as any other unauthenticated call. A distinct message for
      // "wrong key" versus "no key" is a hint nobody outside needs.
      throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'Not authorised', 401)
    }

    const body = provisionRequest.parse(request.body)
    const email = body.admin.email.toLowerCase().trim()

    // Email is unique across the platform, not per org: it is the sign-in
    // identity. Checking before the transaction gives a readable error rather
    // than a constraint violation surfaced as a 500.
    const existing = await db.lookup.userByEmail(email)
    if (existing) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        'That email already belongs to an account on another organisation',
        409,
      )
    }

    const temporaryPassword = generateTemporaryPassword()
    const result = await provisionOrganisation(db, {
      name: body.name,
      country: body.country,
      timezone: body.timezone,
      admin: body.admin,
      password: { hash: await hashPassword(temporaryPassword), mustChange: true },
      via: 'platform',
      ip: request.ip,
    })
    const { orgId, token } = result

    const link = `${env().APP_URL}/auth/callback?token=${token}`

    try {
      const sent = await sendEmail({ ...welcomeEmail(link, temporaryPassword), to: email })
      request.log.info(
        { orgId, messageId: sent.messageId, driver: sent.driver },
        'provisioning welcome sent',
      )
    } catch (error) {
      // The org exists either way. The operator gets the link back in the
      // response so they can hand it over by another route if mail failed.
      request.log.error({ err: error, orgId }, 'provisioning welcome failed')
    }

    return reply.status(201).send({
      organisation: {
        id: result.orgId,
        name: result.orgName,
        country: body.country,
        timezone: body.timezone,
      },
      admin: {
        employeeId: result.employeeId,
        userId: result.userId,
        email,
      },
      // Returned to the operator regardless of environment: this is an
      // authenticated platform call, not the public magic-link endpoint, and
      // the person holding the platform key is the one who would read the
      // mail log anyway. The temporary password is shown here once and is
      // hashed at rest; the HR reset endpoint issues a fresh one if it is lost.
      signInLink: link,
      temporaryPassword,
    })
  })
}
