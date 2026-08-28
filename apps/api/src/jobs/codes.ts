/**
 * Rotating check-in code generation (spec §7).
 *
 * A code is generated per location per rotation window. The previous code stays
 * readable for one further rotation on the validation side, so an employee who
 * reads the code at the door and reaches the app thirty seconds later is not
 * refused — the tolerance lives in the check-in handler, not here.
 *
 * This is a deterrent, not proof: a screenshot defeats it in eleven seconds.
 * Rotation just bounds how long a leaked code stays useful.
 */

import { and, desc, eq, gte } from 'drizzle-orm'
import { checkinCodes, locations } from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { generateCheckinCode } from '../lib/tokens.js'
import { resolveSettings } from '../routes/shared.js'

export interface RotatedCode {
  code: string
  validFrom: Date
  validUntil: Date
}

export async function rotateCodeForLocation(
  tx: Tx,
  orgId: string,
  locationId: string,
  rotationMinutes: number,
): Promise<RotatedCode> {
  const now = new Date()
  const validUntil = new Date(now.getTime() + rotationMinutes * 60_000)

  const [created] = await tx
    .insert(checkinCodes)
    .values({
      orgId,
      locationId,
      code: generateCheckinCode(),
      validFrom: now,
      validUntil,
    })
    .returning()

  return {
    code: created!.code,
    validFrom: created!.validFrom,
    validUntil: created!.validUntil,
  }
}

/** Ensures every location has a live code. Safe to run on a short interval. */
export async function rotateCodes(db: Database): Promise<number> {
  const orgs = await db.lookup.orgs()
  let rotated = 0

  for (const org of orgs) {
    const settings = resolveSettings(org.settings)
    await db.withTenant(org.orgId, async (tx) => {
      const sites = await tx.select({ id: locations.id }).from(locations)
      for (const site of sites) {
        const [live] = await tx
          .select({ id: checkinCodes.id })
          .from(checkinCodes)
          .where(
            and(
              eq(checkinCodes.locationId, site.id),
              gte(checkinCodes.validUntil, new Date()),
            ),
          )
          .orderBy(desc(checkinCodes.validUntil))
          .limit(1)

        if (!live) {
          await rotateCodeForLocation(tx, org.orgId, site.id, settings.codeRotationMinutes)
          rotated += 1
        }
      }
    })
  }

  return rotated
}
