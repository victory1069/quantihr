import { z } from 'zod'
import { role, uuid } from './common.js'

export const magicLinkRequest = z.object({
  email: z.string().email().transform((v) => v.toLowerCase().trim()),
})

export const magicLinkVerify = z.object({
  token: z.string().min(16),
  /**
   * Binds this device to the employee for attendance verification (spec §9).
   * Re-registration requires HR approval, so the first device through wins.
   */
  deviceId: z.string().min(8).max(128),
  deviceName: z.string().max(120).optional(),
  platform: z.enum(['ios', 'android', 'web']).default('web'),
})

export const refreshRequest = z.object({
  refreshToken: z.string().min(16),
})

export const registerDevice = z.object({
  pushToken: z.string().min(8),
  deviceId: z.string().min(8).max(128),
  platform: z.enum(['ios', 'android', 'web']),
})

export const sessionResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
  deviceRegistered: z.boolean(),
  /** True when the device differs from the bound one and HR must approve it. */
  deviceReviewRequired: z.boolean(),
  /**
   * True after signing in with a temporary password. The client goes to the
   * change-password screen and nowhere else until this is false.
   */
  mustChangePassword: z.boolean(),
})

/** Email and password, plus the same device binding the link flow carries. */
export const passwordSignIn = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  deviceId: z.string().min(8).max(128),
  deviceName: z.string().max(120).optional(),
  platform: z.enum(['ios', 'android', 'web']).default('web'),
})

export const changePassword = z.object({
  /** Required unless the current password is a temporary one. */
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(1).max(200),
})

/** Claims carried in the access token. Every tenant-scoped query keys off `orgId`. */
export const jwtClaims = z.object({
  userId: uuid,
  orgId: uuid,
  employeeId: uuid,
  roles: z.array(role).min(1),
  deviceId: z.string().nullable(),
})

export type JwtClaims = z.infer<typeof jwtClaims>
export type SessionResponse = z.infer<typeof sessionResponse>
