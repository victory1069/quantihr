import { randomUUID } from 'node:crypto'
import { createPgliteDatabase, type Database } from '../src/db/client.js'
import {
  employees,
  leaveRequests,
  leaveTypes,
  locations,
  organisations,
  users,
  workSchedules,
} from '../src/db/schema.js'
import { signAccessToken } from '../src/lib/tokens.js'

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-secret-that-is-at-least-32-characters-long'

export interface TestOrg {
  orgId: string
  userId: string
  employeeId: string
  managerEmployeeId: string
  managerUserId: string
  leaveTypeId: string
  locationId: string
  scheduleId: string
  accessToken: string
  managerToken: string
}

export async function makeDatabase(): Promise<Database> {
  const db = await createPgliteDatabase()
  await db.applySchema()
  return db
}

/**
 * Builds a self-contained org: one manager, one report, one leave type.
 *
 * Two of these in the same database is the fixture the isolation suite needs —
 * every assertion is "org A must not see org B", which is only meaningful when
 * both actually exist and both have data.
 */
export async function makeOrg(db: Database, name: string): Promise<TestOrg> {
  const orgId = randomUUID()

  const built = await db.withTenant(orgId, async (tx) => {
    await tx.insert(organisations).values({
      id: orgId,
      name,
      country: 'NG',
      timezone: 'Africa/Lagos',
      settings: {},
    })

    const [schedule] = await tx
      .insert(workSchedules)
      .values({
        orgId,
        name: 'Standard',
        workingDays: [1, 2, 3, 4, 5],
        startTime: '09:00',
        endTime: '17:00',
        gracePeriodMinutes: 10,
        checkinWindowStart: '06:00',
        checkinWindowEnd: '11:00',
      })
      .returning()

    const [site] = await tx
      .insert(locations)
      .values({
        orgId,
        name: `${name} HQ`,
        latitude: 6.4281,
        longitude: 3.4219,
        geofenceRadiusM: 150,
      })
      .returning()

    const prefs = {
      leaveDecisions: true,
      checkinReminders: true,
      balanceExpiry: true,
      documents: true,
    }

    const [managerUser] = await tx
      .insert(users)
      .values({ orgId, email: `manager@${name}.test`, notificationPreferences: prefs })
      .returning()

    const [manager] = await tx
      .insert(employees)
      .values({
        orgId,
        userId: managerUser!.id,
        employeeNumber: 'M-001',
        firstName: 'Manager',
        lastName: name,
        email: `manager@${name}.test`,
        locationId: site!.id,
        workScheduleId: schedule!.id,
        employmentType: 'full_time',
        startDate: '2020-01-01',
        status: 'active',
        roles: ['employee', 'manager'],
      })
      .returning()

    const [staffUser] = await tx
      .insert(users)
      .values({ orgId, email: `staff@${name}.test`, notificationPreferences: prefs })
      .returning()

    const [staff] = await tx
      .insert(employees)
      .values({
        orgId,
        userId: staffUser!.id,
        employeeNumber: 'E-001',
        firstName: 'Staff',
        lastName: name,
        email: `staff@${name}.test`,
        locationId: site!.id,
        managerId: manager!.id,
        workScheduleId: schedule!.id,
        employmentType: 'full_time',
        startDate: '2021-01-01',
        status: 'active',
        roles: ['employee'],
      })
      .returning()

    const [type] = await tx
      .insert(leaveTypes)
      .values({
        orgId,
        name: 'Annual Leave',
        accrualMethod: 'annual_fixed',
        accrualRate: '20',
        colour: '#2563EB',
      })
      .returning()

    // A request each side, so cross-tenant reads have something to wrongly find.
    await tx.insert(leaveRequests).values({
      orgId,
      employeeId: staff!.id,
      leaveTypeId: type!.id,
      startDate: '2026-11-02',
      endDate: '2026-11-06',
      daysCount: '5',
      status: 'pending',
      reason: `secret-${name}`,
    })

    return {
      orgId,
      userId: staffUser!.id,
      employeeId: staff!.id,
      managerUserId: managerUser!.id,
      managerEmployeeId: manager!.id,
      leaveTypeId: type!.id,
      locationId: site!.id,
      scheduleId: schedule!.id,
    }
  })

  return {
    ...built,
    accessToken: await signAccessToken({
      userId: built.userId,
      orgId,
      employeeId: built.employeeId,
      roles: ['employee'],
      deviceId: 'test-device-0001',
    }),
    managerToken: await signAccessToken({
      userId: built.managerUserId,
      orgId,
      employeeId: built.managerEmployeeId,
      roles: ['employee', 'manager'],
      deviceId: 'test-device-0002',
    }),
  }
}

export function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}
