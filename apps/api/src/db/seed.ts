/**
 * Development seed: one org with enough shape to exercise every screen.
 *
 * Note the trick for creating the tenancy root: `organisations` has an RLS
 * policy of `id = app.org_id`, so the row cannot be inserted without already
 * knowing its own id. We generate the uuid client-side and open the tenant
 * context with it, and the WITH CHECK passes. No bypass, no special case.
 */

import { randomUUID } from 'node:crypto'
import {
  DEFAULT_ORG_SETTINGS,
  addDays,
  computeLeaveDays,
  type ISODate,
} from '@quanti/shared'
import { createDatabase, type Database } from './client.js'
import {
  attendanceRecords,
  coverageRules,
  departments,
  devices,
  documents,
  employees,
  leaveRequests,
  leaveTypes,
  locations,
  organisations,
  users,
  workSchedules,
} from './schema.js'
import { orgClock } from '../lib/time.js'

const TIMEZONE = 'Africa/Lagos'

const SCHEDULE = {
  workingDays: [1, 2, 3, 4, 5],
  startTime: '09:00',
  endTime: '17:00',
  gracePeriodMinutes: 10,
  checkinWindowStart: '06:00',
  checkinWindowEnd: '11:00',
}

interface SeedPerson {
  number: string
  first: string
  last: string
  email: string
  title: string
  roles: string[]
  department: 'Operations' | 'Finance' | 'Engineering'
  managerNumber: string | null
  startDate: ISODate
  roleId: string | null
}

const PEOPLE: SeedPerson[] = [
  {
    number: 'QH-001', first: 'Amaka', last: 'Obi', email: 'amaka@kanjufoods.test',
    title: 'Head of People', roles: ['employee', 'hr_admin', 'owner'],
    department: 'Operations', managerNumber: null, startDate: '2019-03-01', roleId: null,
  },
  {
    number: 'QH-002', first: 'Tunde', last: 'Bello', email: 'tunde@kanjufoods.test',
    title: 'Operations Manager', roles: ['employee', 'manager'],
    department: 'Operations', managerNumber: 'QH-001', startDate: '2020-06-15', roleId: null,
  },
  {
    number: 'QH-003', first: 'Ngozi', last: 'Eze', email: 'ngozi@kanjufoods.test',
    title: 'Shift Supervisor', roles: ['employee'],
    department: 'Operations', managerNumber: 'QH-002', startDate: '2021-01-11', roleId: 'supervisor',
  },
  {
    number: 'QH-004', first: 'Musa', last: 'Ibrahim', email: 'musa@kanjufoods.test',
    title: 'Logistics Coordinator', roles: ['employee'],
    department: 'Operations', managerNumber: 'QH-002', startDate: '2022-09-05', roleId: null,
  },
  {
    number: 'QH-005', first: 'Blessing', last: 'Okafor', email: 'blessing@kanjufoods.test',
    title: 'Quality Lead', roles: ['employee'],
    department: 'Operations', managerNumber: 'QH-002', startDate: '2023-02-20', roleId: 'supervisor',
  },
  {
    number: 'QH-006', first: 'Chidi', last: 'Nwosu', email: 'chidi@kanjufoods.test',
    title: 'Warehouse Assistant', roles: ['employee'],
    // A mid-year joiner, so the pro-rating shows up on the balance screen.
    department: 'Operations', managerNumber: 'QH-002', startDate: '2026-07-01', roleId: null,
  },
  {
    number: 'QH-007', first: 'Fatima', last: 'Yusuf', email: 'fatima@kanjufoods.test',
    title: 'Financial Analyst', roles: ['employee'],
    department: 'Finance', managerNumber: 'QH-001', startDate: '2021-11-02', roleId: null,
  },
  {
    number: 'QH-008', first: 'Segun', last: 'Adeyemi', email: 'segun@kanjufoods.test',
    title: 'Software Engineer', roles: ['employee'],
    department: 'Engineering', managerNumber: 'QH-001', startDate: '2024-04-08', roleId: null,
  },
]

export async function seed(db: Database): Promise<{ orgId: string }> {
  const orgId = randomUUID()

  await db.withTenant(orgId, async (tx) => {
    await tx.insert(organisations).values({
      id: orgId,
      name: 'Kanju Foods',
      country: 'NG',
      timezone: TIMEZONE,
      settings: {
        ...DEFAULT_ORG_SETTINGS,
        leaveYearStart: '01-01',
        proRataRounding: 'nearest_half',
        codeRotationMinutes: 5,
        latenessThreshold: 3,
        publicHolidays: ['2026-10-01', '2026-12-25', '2026-12-26'],
      },
    })

    const [schedule] = await tx
      .insert(workSchedules)
      .values({ orgId, name: 'Standard weekday', ...SCHEDULE })
      .returning()

    const [site] = await tx
      .insert(locations)
      .values({
        orgId,
        name: 'Victoria Island HQ',
        address: '12 Adeola Odeku St, Victoria Island, Lagos',
        latitude: 6.4281,
        longitude: 3.4219,
        geofenceRadiusM: 150,
      })
      .returning()

    const deptRows = await tx
      .insert(departments)
      .values([
        { orgId, name: 'Operations' },
        { orgId, name: 'Finance' },
        { orgId, name: 'Engineering' },
      ])
      .returning()
    const deptByName = new Map(deptRows.map((d) => [d.name, d.id]))

    const typeRows = await tx
      .insert(leaveTypes)
      .values([
        {
          orgId, name: 'Annual Leave', accrualMethod: 'annual_fixed', accrualRate: '20',
          maxBalance: '30', carryoverCap: '5', carryoverExpiryMonths: 3,
          requiresDocument: false, minNoticeDays: 7, isPaid: true, colour: '#2563EB',
        },
        {
          orgId, name: 'Sick Leave', accrualMethod: 'annual_fixed', accrualRate: '10',
          maxBalance: '10', carryoverCap: null, carryoverExpiryMonths: null,
          requiresDocument: true, minNoticeDays: null, isPaid: true, colour: '#DC2626',
        },
        {
          orgId, name: 'Casual Leave', accrualMethod: 'monthly', accrualRate: '0.5',
          maxBalance: '6', carryoverCap: null, carryoverExpiryMonths: null,
          requiresDocument: false, minNoticeDays: 2, isPaid: true, colour: '#059669',
        },
        {
          orgId, name: 'Study Leave', accrualMethod: 'annual_anniversary', accrualRate: '5',
          maxBalance: '5', carryoverCap: null, carryoverExpiryMonths: null,
          requiresDocument: true, minNoticeDays: 30, isPaid: false, colour: '#7C3AED',
        },
      ])
      .returning()

    // Two passes: everyone must exist before manager_id can point at them.
    const byNumber = new Map<string, string>()

    for (const person of PEOPLE) {
      const [user] = await tx
        .insert(users)
        .values({
          orgId,
          email: person.email,
          notificationPreferences: {
            leaveDecisions: true,
            checkinReminders: true,
            balanceExpiry: true,
            documents: true,
          },
        })
        .returning()

      const [employee] = await tx
        .insert(employees)
        .values({
          orgId,
          userId: user!.id,
          employeeNumber: person.number,
          firstName: person.first,
          lastName: person.last,
          email: person.email,
          departmentId: deptByName.get(person.department) ?? null,
          locationId: site!.id,
          jobTitle: person.title,
          roleId: person.roleId,
          employmentType: 'full_time',
          startDate: person.startDate,
          status: 'active',
          workScheduleId: schedule!.id,
          roles: person.roles,
        })
        .returning()

      byNumber.set(person.number, employee!.id)
    }

    for (const person of PEOPLE) {
      if (!person.managerNumber) continue
      const { eq } = await import('drizzle-orm')
      await tx
        .update(employees)
        .set({ managerId: byNumber.get(person.managerNumber)! })
        .where(eq(employees.id, byNumber.get(person.number)!))
    }

    await tx.insert(coverageRules).values({
      orgId,
      departmentId: deptByName.get('Operations')!,
      maxConcurrentAbsent: 2,
      maxConcurrentPercent: '40',
      blackoutPeriods: [
        { name: 'Year-end stock count', start: '2026-12-18', end: '2026-12-31' },
      ],
      criticalRoleIds: ['supervisor'],
    })

    // Every seeded person is signed in on the web preview, so bind a device.
    for (const [, employeeId] of byNumber) {
      await tx.insert(devices).values({
        orgId,
        employeeId,
        deviceId: `seed-device-${employeeId.slice(0, 8)}`,
        platform: 'web',
        name: 'Seeded device',
        approved: true,
      })
    }

    const today = orgClock(TIMEZONE).date as ISODate
    const annual = typeRows.find((t) => t.name === 'Annual Leave')!
    const sick = typeRows.find((t) => t.name === 'Sick Leave')!

    // A pending request for the manager's approval queue, and one that trips the
    // coverage rule so the override path is visible immediately.
    const pending: { employee: string; type: string; start: ISODate; end: ISODate }[] = [
      { employee: 'QH-003', type: annual.id, start: addDays(today, 10), end: addDays(today, 14) },
      { employee: 'QH-004', type: annual.id, start: addDays(today, 11), end: addDays(today, 15) },
      { employee: 'QH-005', type: annual.id, start: addDays(today, 12), end: addDays(today, 13) },
    ]

    for (const p of pending) {
      const days = computeLeaveDays({
        start: p.start,
        end: p.end,
        halfDayStart: false,
        halfDayEnd: false,
        schedule: SCHEDULE,
      })
      if (days.daysCount === 0) continue

      await tx.insert(leaveRequests).values({
        orgId,
        employeeId: byNumber.get(p.employee)!,
        leaveTypeId: p.type,
        startDate: p.start,
        endDate: p.end,
        daysCount: String(days.daysCount),
        reason: 'Family commitments',
        status: 'pending',
      })
    }

    // One approved request in the past, so the calendar and history are not empty.
    const pastStart = addDays(today, -21)
    const pastDays = computeLeaveDays({
      start: pastStart,
      end: addDays(today, -19),
      halfDayStart: false,
      halfDayEnd: false,
      schedule: SCHEDULE,
    })
    if (pastDays.daysCount > 0) {
      await tx.insert(leaveRequests).values({
        orgId,
        employeeId: byNumber.get('QH-007')!,
        leaveTypeId: sick.id,
        startDate: pastStart,
        endDate: addDays(today, -19),
        daysCount: String(pastDays.daysCount),
        reason: 'Recovering',
        status: 'approved',
        decidedAt: new Date(),
      })
    }

    // Four weeks of attendance history, including a few late arrivals so the
    // manager view has something to flag.
    const records: (typeof attendanceRecords.$inferInsert)[] = []
    for (const [number, employeeId] of byNumber) {
      for (let back = 1; back <= 28; back++) {
        const date = addDays(today, -back)
        const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
        if (!SCHEDULE.workingDays.includes(dow)) continue

        const late = number === 'QH-004' && back % 5 === 0
        const minutesLate = late ? 18 : 0
        records.push({
          orgId,
          employeeId,
          date,
          checkedInAt: new Date(`${date}T${late ? '08:18' : '07:45'}:00Z`),
          checkinMethod: 'geofence_code',
          verificationSignals: { seeded: true },
          latitude: 6.4281,
          longitude: 3.4219,
          accuracyM: 12,
          status: late ? 'late' : 'present',
          minutesLate,
        })
      }
    }
    for (let i = 0; i < records.length; i += 100) {
      await tx.insert(attendanceRecords).values(records.slice(i, i + 100))
    }

    await tx.insert(documents).values([
      {
        orgId,
        employeeId: null,
        type: 'policy',
        name: 'Employee Handbook 2026.pdf',
        s3Key: `${orgId}/seed-handbook.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 248_000,
        requiresAcknowledgement: true,
      },
      {
        orgId,
        employeeId: byNumber.get('QH-003')!,
        type: 'contract',
        name: 'Employment Contract — N Eze.pdf',
        s3Key: `${orgId}/seed-contract-ngozi.pdf`,
        contentType: 'application/pdf',
        sizeBytes: 96_000,
      },
    ])
  })

  return { orgId }
}

export async function seedIfEmpty(db: Database): Promise<void> {
  const orgs = await db.lookup.orgs()
  if (orgs.length > 0) return
  const { orgId } = await seed(db)
  // eslint-disable-next-line no-console
  console.log(`[seed] created demo org ${orgId} — sign in as amaka@kanjufoods.test`)
}

// Direct invocation: `npm run seed`
if (process.argv[1]?.endsWith('seed.ts')) {
  const db = await createDatabase()
  await db.applySchema()
  const { orgId } = await seed(db)
  // eslint-disable-next-line no-console
  console.log(`Seeded org ${orgId}`)
  await db.close()
}
