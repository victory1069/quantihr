/**
 * Request authentication and role guards.
 *
 * `request.auth` is the only source of tenancy in a handler. Handlers must never
 * read an org id from the body, the query string or a path parameter — that is
 * how a tenant-isolation bug gets written, and RLS would be the only thing left
 * standing between it and a data leak.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ApiError, ERROR_CODES, type JwtClaims, type Role } from '@quanti/shared'
import { verifyAccessToken } from './tokens.js'
import type { Database, Tx } from '../db/client.js'

declare module 'fastify' {
  interface FastifyRequest {
    auth?: JwtClaims
    db: Database
  }
}

export function requireAuth(request: FastifyRequest): JwtClaims {
  if (!request.auth) {
    throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'Authentication required', 401)
  }
  return request.auth
}

export function requireRole(request: FastifyRequest, ...allowed: Role[]): JwtClaims {
  const auth = requireAuth(request)
  if (!auth.roles.some((r) => allowed.includes(r))) {
    throw new ApiError(
      ERROR_CODES.AUTH_FORBIDDEN,
      'You do not have permission to do that',
      403,
    )
  }
  return auth
}

export const isManager = (auth: JwtClaims): boolean =>
  auth.roles.some((r) => r === 'manager' || r === 'hr_admin' || r === 'owner')

export const isHrAdmin = (auth: JwtClaims): boolean =>
  auth.roles.some((r) => r === 'hr_admin' || r === 'owner')

/** Convenience: run inside the caller's tenant context. */
export function tenant<T>(request: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const auth = requireAuth(request)
  return request.db.withTenant(auth.orgId, fn)
}

const PUBLIC_ROUTES = new Set([
  'POST:/v1/auth/magic-link',
  'POST:/v1/auth/verify',
  'POST:/v1/auth/refresh',
  // The password door. Rate-limited per IP in the route; the change endpoint
  // is deliberately NOT here — it needs the session the sign-in issued.
  'POST:/v1/auth/password',
  // Pre-tenant sign-up lookups; rate-limited in the route.
  'GET:/v1/auth/invite',
  'POST:/v1/auth/otp/request',
  'POST:/v1/auth/otp/verify',
  'GET:/health',
  // Authenticated by the platform key in the route, not by a tenant JWT —
  // provisioning happens before an org exists to scope a token to.
  'POST:/v1/platform/organisations',
  // Static console shell. It holds no data — everything it shows is fetched
  // over the same authenticated /v1 endpoints the mobile client uses.
  'GET:/console',
  'GET:/console/',
  'GET:/console/hero.mp4',
  // Development document download: authenticated by the HMAC signature in the
  // query string, because the browser opens this URL directly with no header.
  'GET:/v1/documents/download',
])

export function registerAuth(app: FastifyInstance, db: Database): void {
  app.addHook('onRequest', async (request: FastifyRequest, _reply: FastifyReply) => {
    request.db = db

    const key = `${request.method}:${request.routeOptions?.url ?? request.url}`
    if (PUBLIC_ROUTES.has(key)) return

    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError(ERROR_CODES.AUTH_INVALID_TOKEN, 'Authentication required', 401)
    }
    request.auth = await verifyAccessToken(header.slice('Bearer '.length))
  })
}
