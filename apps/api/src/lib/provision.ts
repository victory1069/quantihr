/**
 * Creating an organisation and its first HR admin.
 *
 * Two doors lead here: an operator with the platform key, and a company
 * signing itself up after proving it controls its hr@ address. Both end
 * with the same rows — an organisation, a default schedule, one user with
 * one employee record holding the owner and hr_admin roles, and a 24-hour
 * sign-in link — so the setup wizard that follows never has to care which
 * door was used.
 *
 * Follows the seed's pattern: pre-generate the org id, set the tenant claim,
 * then insert. The organisation's own RLS policy has a WITH CHECK on
 * `id = app.org_id`, so the row passes because the claim already names it.
 */

import { randomUUID } from 'node:crypto'
import { DEFAULT_ORG_SETTINGS } from '@quanti/shared'
import { employees, magicLinkTokens, organisations, users, workSchedules } from '../db/schema.js'
import type { Database } from '../db/client.js'
import { audit } from './audit.js'
import { expiryFromNow, hashToken, randomToken } from './tokens.js'

export interface ProvisionInput {
  name: string
  country?: string
  timezone?: string
  admin: { firstName: string; lastName: string; email: string; phone?: string | null }
  /** Already hashed. Temporary passwords force a change on first sign-in. */
  password: { hash: string; mustChange: boolean }
  /** Where the sign-in link came from, for the audit row. */
  via: 'platform' | 'signup'
  ip?: string
}

export interface Provisioned {
  orgId: string
  orgName: string
  userId: string
  employeeId: string
  /** Raw magic-link token — the caller puts it in the welcome email. */
  token: string
}

export async function provisionOrganisation(db: Database, input: ProvisionInput): Promise<Provisioned> {
  const orgId = randomUUID()
  const token = randomToken()
  const email = input.admin.email.toLowerCase().trim()

  return db.withTenant(orgId, async (tx) => {
    const [org] = await tx
      .insert(organisations)
      .values({
        id: orgId,
        name: input.name.trim(),
        country: input.country ?? 'NG',
        timezone: input.timezone ?? 'Africa/Lagos',
        settings: { ...DEFAULT_ORG_SETTINGS },
        onboardingSteps: [],
      })
      .returning()

    // One schedule so the first employee record has something to point at.
    // The wizard lets them change it; an org with no schedule at all cannot
    // compute lateness and every check-in would fail in a confusing way.
    const [schedule] = await tx
      .insert(workSchedules)
      .values({
        orgId,
        name: 'Standard weekday',
        workingDays: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '17:00',
        gracePeriodMinutes: 10,
        checkinWindowStart: '06:00',
        checkinWindowEnd: '11:00',
      })
      .returning()

    const [user] = await tx
      .insert(users)
      .values({
        orgId,
        email,
        passwordHash: input.password.hash,
        mustChangePassword: input.password.mustChange,
        notificationPreferences: {
          leaveDecisions: true,
          checkinReminders: true,
          balanceExpiry: true,
          documents: true,
        },
      })
      .returning()

    const [admin] = await tx
      .insert(employees)
      .values({
        orgId,
        userId: user!.id,
        employeeNumber: 'QH-001',
        firstName: input.admin.firstName.trim(),
        lastName: input.admin.lastName.trim(),
        email,
        phone: input.admin.phone ?? null,
        jobTitle: 'HR Administrator',
        employmentType: 'full_time',
        startDate: new Date().toISOString().slice(0, 10),
        status: 'active',
        workScheduleId: schedule!.id,
        // Owner as well as hr_admin: the first person in is the one who can
        // later hand the org to someone else.
        roles: ['employee', 'hr_admin', 'owner'],
      })
      .returning()

    await tx.insert(magicLinkTokens).values({
      orgId,
      userId: user!.id,
      tokenHash: hashToken(token),
      // Longer than the usual 15 minutes. This link arrives in a welcome
      // email that may not be opened the same hour it is sent.
      expiresAt: expiryFromNow(24 * 60 * 60),
    })

    await audit(tx, {
      orgId,
      actorUserId: null,
      action: 'org.provisioned',
      entityType: 'organisation',
      entityId: orgId,
      after: { name: org!.name, adminEmail: email, via: input.via },
      ip: input.ip,
    })

    return { orgId, orgName: org!.name, userId: user!.id, employeeId: admin!.id, token }
  })
}
