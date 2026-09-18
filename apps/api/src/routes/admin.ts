/**
 * HR console surface (spec §11, increment 9).
 *
 * Everything here requires `hr_admin` or `owner`. Bulk import is deliberately
 * two-phase: `validate` returns a per-row preview and writes nothing, `commit`
 * applies it. A 300-row spreadsheet gets inspected before it lands.
 */

import ExcelJS from 'exceljs'
import type { FastifyInstance } from 'fastify'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  ApiError,
  ERROR_CODES,
  isISODate,
  schemas,
  type ISODate,
} from '@quanti/shared'
import {
  checkinCodes,
  coverageRules,
  departments,
  devices,
  documents,
  employees,
  leaveBalanceAdjustments,
  leaveBalances,
  leaveTypes,
  locations,
  organisations,
  users,
  workSchedules,
} from '../db/schema.js'
import type { Database, Tx } from '../db/client.js'
import { audit, redact } from '../lib/audit.js'
import { requireRole, tenant } from '../lib/context.js'
import { generateTemporaryPassword, hashPassword } from '../lib/password.js'
import { storage } from '../lib/storage.js'
import { orgClock } from '../lib/time.js'
import { ensureBalance, toLeaveTypeView } from './leave.js'
import { fullName, num, resolveSettings } from './shared.js'

export function registerAdminRoutes(app: FastifyInstance, db: Database): void {
  // -------------------------------------------------------------------------
  // Org configuration
  // -------------------------------------------------------------------------

  app.get('/v1/admin/org', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const result = await tenant(request, async (tx) => {
      const [org] = await tx
        .select()
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)
      if (!org) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Organisation not found', 404)
      return {
        id: org.id,
        name: org.name,
        country: org.country,
        timezone: org.timezone,
        settings: resolveSettings(org.settings),
      }
    })
    return reply.send(result)
  })

  app.patch('/v1/admin/org', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = z.object({
      name: z.string().min(1).max(200).optional(),
      timezone: z.string().min(1).max(80).optional(),
      settings: schemas.config.orgSettings.partial().optional(),
    }).parse(request.body)

    const result = await tenant(request, async (tx) => {
      const [org] = await tx
        .select()
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)
      if (!org) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Organisation not found', 404)

      const nextSettings = { ...resolveSettings(org.settings), ...(body.settings ?? {}) }
      const [updated] = await tx
        .update(organisations)
        .set({
          ...(body.name ? { name: body.name } : {}),
          ...(body.timezone ? { timezone: body.timezone } : {}),
          settings: nextSettings,
        })
        .where(eq(organisations.id, auth.orgId))
        .returning()

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'config.updated',
        entityType: 'organisation',
        entityId: auth.orgId,
        before: { settings: org.settings },
        after: { settings: nextSettings },
        ip: request.ip,
      })

      return {
        id: updated!.id,
        name: updated!.name,
        country: updated!.country,
        timezone: updated!.timezone,
        settings: resolveSettings(updated!.settings),
      }
    })

    return reply.send(result)
  })

  // -------------------------------------------------------------------------
  // Reference data
  // -------------------------------------------------------------------------

  app.get('/v1/admin/locations', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const rows = await tenant(request, (tx) => tx.select().from(locations))
    return reply.send({ locations: rows })
  })

  app.post('/v1/admin/locations', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.admin.upsertLocation.parse(request.body)

    const row = await tenant(request, async (tx) => {
      if (body.id) {
        const [updated] = await tx
          .update(locations)
          .set({
            name: body.name,
            address: body.address ?? null,
            latitude: body.latitude,
            longitude: body.longitude,
            geofenceRadiusM: body.geofenceRadiusM,
          })
          .where(eq(locations.id, body.id))
          .returning()
        if (!updated) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Location not found', 404)
        return updated
      }
      const [created] = await tx
        .insert(locations)
        .values({
          orgId: auth.orgId,
          name: body.name,
          address: body.address ?? null,
          latitude: body.latitude,
          longitude: body.longitude,
          geofenceRadiusM: body.geofenceRadiusM,
        })
        .returning()
      return created!
    })

    return reply.status(body.id ? 200 : 201).send(row)
  })

  app.get('/v1/admin/departments', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const rows = await tenant(request, (tx) => tx.select().from(departments))
    return reply.send({ departments: rows })
  })

  app.post('/v1/admin/departments', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.admin.upsertDepartment.parse(request.body)

    const row = await tenant(request, async (tx) => {
      if (body.id) {
        const [updated] = await tx
          .update(departments)
          .set({ name: body.name, parentDepartmentId: body.parentDepartmentId ?? null })
          .where(eq(departments.id, body.id))
          .returning()
        if (!updated) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Department not found', 404)
        return updated
      }
      const [created] = await tx
        .insert(departments)
        .values({
          orgId: auth.orgId,
          name: body.name,
          parentDepartmentId: body.parentDepartmentId ?? null,
        })
        .returning()
      return created!
    })

    return reply.status(body.id ? 200 : 201).send(row)
  })

  app.get('/v1/admin/schedules', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const rows = await tenant(request, (tx) => tx.select().from(workSchedules))
    return reply.send({ schedules: rows })
  })

  app.post('/v1/admin/schedules', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.admin.upsertWorkSchedule.parse(request.body)

    const row = await tenant(request, async (tx) => {
      const values = {
        name: body.name,
        workingDays: body.workingDays,
        startTime: body.startTime,
        endTime: body.endTime,
        gracePeriodMinutes: body.gracePeriodMinutes,
        checkinWindowStart: body.checkinWindowStart,
        checkinWindowEnd: body.checkinWindowEnd,
      }
      if (body.id) {
        const [updated] = await tx
          .update(workSchedules)
          .set(values)
          .where(eq(workSchedules.id, body.id))
          .returning()
        if (!updated) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Schedule not found', 404)
        return updated
      }
      const [created] = await tx
        .insert(workSchedules)
        .values({ orgId: auth.orgId, ...values })
        .returning()
      return created!
    })

    return reply.status(body.id ? 200 : 201).send(row)
  })

  // -------------------------------------------------------------------------
  // Leave configuration
  // -------------------------------------------------------------------------

  app.get('/v1/admin/leave-types', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const rows = await tenant(request, (tx) => tx.select().from(leaveTypes))
    return reply.send({ types: rows.map(toLeaveTypeView) })
  })

  app.post('/v1/admin/leave-types', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.admin.upsertLeaveType.parse(request.body)

    const row = await tenant(request, async (tx) => {
      const values = {
        name: body.name,
        accrualMethod: body.accrualMethod,
        accrualRate: String(body.accrualRate),
        maxBalance: body.maxBalance === null ? null : String(body.maxBalance),
        carryoverCap: body.carryoverCap === null ? null : String(body.carryoverCap),
        carryoverExpiryMonths: body.carryoverExpiryMonths,
        requiresDocument: body.requiresDocument,
        minNoticeDays: body.minNoticeDays,
        isPaid: body.isPaid,
        colour: body.colour,
      }
      if (body.id) {
        const [updated] = await tx
          .update(leaveTypes)
          .set(values)
          .where(eq(leaveTypes.id, body.id))
          .returning()
        if (!updated) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Leave type not found', 404)
        return updated
      }
      const [created] = await tx
        .insert(leaveTypes)
        .values({ orgId: auth.orgId, ...values })
        .returning()
      return created!
    })

    return reply.status(body.id ? 200 : 201).send(toLeaveTypeView(row))
  })

  app.get('/v1/admin/coverage-rules', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const rows = await tenant(request, (tx) => tx.select().from(coverageRules))
    return reply.send({ rules: rows })
  })

  app.post('/v1/admin/coverage-rules', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.admin.upsertCoverageRule.parse(request.body)

    const row = await tenant(request, async (tx) => {
      const [created] = await tx
        .insert(coverageRules)
        .values({
          orgId: auth.orgId,
          departmentId: body.departmentId,
          maxConcurrentAbsent: body.maxConcurrentAbsent,
          maxConcurrentPercent:
            body.maxConcurrentPercent === null ? null : String(body.maxConcurrentPercent),
          blackoutPeriods: body.blackoutPeriods,
          criticalRoleIds: body.criticalRoleIds,
        })
        .onConflictDoUpdate({
          target: [coverageRules.orgId, coverageRules.departmentId],
          set: {
            maxConcurrentAbsent: body.maxConcurrentAbsent,
            maxConcurrentPercent:
              body.maxConcurrentPercent === null ? null : String(body.maxConcurrentPercent),
            blackoutPeriods: body.blackoutPeriods,
            criticalRoleIds: body.criticalRoleIds,
          },
        })
        .returning()
      return created!
    })

    return reply.send(row)
  })

  // -------------------------------------------------------------------------
  // Employees
  // -------------------------------------------------------------------------

  app.get('/v1/admin/employees', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')

    const rows = await tenant(request, async (tx) =>
      tx
        .select({
          id: employees.id,
          employeeNumber: employees.employeeNumber,
          firstName: employees.firstName,
          lastName: employees.lastName,
          email: employees.email,
          jobTitle: employees.jobTitle,
          departmentId: employees.departmentId,
          locationId: employees.locationId,
          managerId: employees.managerId,
          employmentType: employees.employmentType,
          startDate: employees.startDate,
          endDate: employees.endDate,
          status: employees.status,
          roles: employees.roles,
          roleId: employees.roleId,
          workScheduleId: employees.workScheduleId,
        })
        .from(employees)
        .orderBy(employees.employeeNumber),
    )

    return reply.send({ employees: rows })
  })

  app.post('/v1/admin/employees', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.admin.upsertEmployee.parse(request.body)

    const row = await tenant(request, async (tx) => upsertEmployee(tx, auth.orgId, body, auth.userId))
    return reply.status(body.id ? 200 : 201).send(row)
  })

  /**
   * Two-phase bulk import. `validate` writes nothing.
   *
   * Rows are validated independently so one bad date does not hide the other
   * 40 problems in the file — HR should fix a spreadsheet once, not forty times.
   */
  /**
   * Turns an uploaded spreadsheet into the same row shape the paste box
   * produces, so `/import` stays the single validator.
   *
   * Parsing happens here rather than in the browser because the console is
   * deliberately dependency-free — pulling a spreadsheet library off a CDN into
   * a page that holds an HR session is a worse trade than one server dependency.
   *
   * This only reads. Nothing is written, and the caller still has to run the
   * result through validate and commit like any pasted CSV.
   */
  /**
   * A fresh temporary password for one employee.
   *
   * For the person who lost their Post-it, and the only way a temporary
   * password can be seen after creation — they are hashed at rest and never
   * read back. The new one forces a change on next sign-in like the first did.
   */
  app.post('/v1/admin/employees/:id/reset-password', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const { id } = request.params as { id: string }

    const temporaryPassword = generateTemporaryPassword()

    const target = await tenant(request, async (tx) => {
      const [employee] = await tx
        .select({ id: employees.id, userId: employees.userId, email: employees.email })
        .from(employees)
        .where(eq(employees.id, id))
        .limit(1)
      if (!employee?.userId) {
        throw new ApiError(ERROR_CODES.NOT_FOUND, 'No such employee', 404)
      }

      await tx
        .update(users)
        .set({
          passwordHash: await hashPassword(temporaryPassword),
          mustChangePassword: true,
          passwordChangedAt: new Date(),
        })
        .where(eq(users.id, employee.userId))

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'auth.password_reset',
        entityType: 'user',
        entityId: employee.userId,
        ip: request.ip,
      })

      return employee
    })

    return reply.send({ employeeId: target.id, email: target.email, temporaryPassword })
  })

  app.post('/v1/admin/employees/import/parse', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const body = z
      .object({
        filename: z.string().max(255),
        contentBase64: z.string().min(1),
      })
      .parse(request.body)

    const buffer = Buffer.from(body.contentBase64, 'base64')

    // A staff list is a few hundred rows. Anything much larger is a mistake or
    // an attempt to exhaust memory, and refusing early is cheaper than parsing.
    if (buffer.byteLength > 5 * 1024 * 1024) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        'That file is larger than 5MB. Export just the staff list and try again.',
        413,
      )
    }

    const workbook = new ExcelJS.Workbook()
    try {
      // Node 22 types Buffer as Buffer<ArrayBuffer>; exceljs ships older types
      // that expect the ungenericised Buffer. Cast to exactly that parameter
      // rather than to `any`, so a real signature change still breaks the build.
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0])
    } catch {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        'That file could not be read as a spreadsheet. Save it as .xlsx and try again.',
        422,
      )
    }

    const sheet = workbook.worksheets[0]
    if (!sheet) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'That workbook has no sheets', 422)
    }

    const cell = (v: unknown): string => {
      if (v === null || v === undefined) return ''
      // Dates come back as Date objects; the importer wants YYYY-MM-DD, and
      // toISOString is the only rendering that does not depend on locale.
      if (v instanceof Date) return v.toISOString().slice(0, 10)
      if (typeof v === 'object') {
        const rich = v as { text?: string; result?: unknown; hyperlink?: string }
        if (typeof rich.text === 'string') return rich.text.trim()
        if (rich.result !== undefined) return String(rich.result).trim()
      }
      return String(v).trim()
    }

    const headerRow = sheet.getRow(1)
    const columns: string[] = []
    headerRow.eachCell({ includeEmpty: true }, (c, i) => {
      // Accept the human spellings people actually save: "First Name" and
      // "first_name" are the same column.
      columns[i - 1] = cell(c.value).toLowerCase().replace(/\s+/g, '_')
    })

    if (columns.filter(Boolean).length === 0) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        'The first row of the sheet must be the column headings',
        422,
      )
    }

    const rows: Record<string, string>[] = []
    sheet.eachRow({ includeEmpty: false }, (row, index) => {
      if (index === 1) return
      const record: Record<string, string> = {}
      let empty = true
      for (let i = 0; i < columns.length; i += 1) {
        const key = columns[i]
        if (!key) continue
        const value = cell(row.getCell(i + 1).value)
        record[key] = value
        if (value) empty = false
      }
      if (!empty) rows.push(record)
    })

    return reply.send({ rows, columns: columns.filter(Boolean), sheetName: sheet.name })
  })

  app.post('/v1/admin/employees/import', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.admin.bulkImportRequest.parse(request.body)

    const result = await tenant(request, async (tx) => {
      const existing = await tx
        .select({ id: employees.id, employeeNumber: employees.employeeNumber })
        .from(employees)
      const byNumber = new Map(existing.map((e) => [e.employeeNumber, e.id]))

      const [defaultSchedule] = await tx.select().from(workSchedules).limit(1)

      const rows = body.rows.map((raw, i) => validateImportRow(raw, i + 2, byNumber))
      const errorCount = rows.filter((r) => r.result.action === 'error').length

      // Temporary passwords for every account the import created, returned
      // once so HR can hand them over. They are never retrievable again —
      // the reset endpoint issues a fresh one instead.
      const credentials: { employeeNumber: string; email: string; temporaryPassword: string }[] = []

      if (body.mode === 'commit' && errorCount === 0) {
        for (const row of rows) {
          if (!row.parsed) continue
          const saved = await upsertEmployee(
            tx,
            auth.orgId,
            {
              ...row.parsed,
              workScheduleId: row.parsed.workScheduleId ?? defaultSchedule?.id ?? null,
            },
            auth.userId,
          )
          if (saved.temporaryPassword) {
            credentials.push({
              employeeNumber: saved.employeeNumber,
              email: saved.email,
              temporaryPassword: saved.temporaryPassword,
            })
          }
        }
        await audit(tx, {
          orgId: auth.orgId,
          actorUserId: auth.userId,
          action: 'employee.imported',
          entityType: 'employee',
          entityId: null,
          after: { count: rows.length },
          ip: request.ip,
        })
      }

      return {
        mode: body.mode,
        totalRows: rows.length,
        willCreate: rows.filter((r) => r.result.action === 'create').length,
        willUpdate: rows.filter((r) => r.result.action === 'update').length,
        errorCount,
        rows: rows.map((r) => r.result),
        committed: body.mode === 'commit' && errorCount === 0,
        credentials,
      }
    })

    if (body.mode === 'commit' && result.errorCount > 0) {
      throw new ApiError(
        ERROR_CODES.VALIDATION_FAILED,
        `${result.errorCount} row(s) have errors. Nothing was imported.`,
        422,
        { rows: result.rows.filter((r) => r.action === 'error') },
      )
    }

    return reply.send(result)
  })

  // -------------------------------------------------------------------------
  // Balances, devices, documents
  // -------------------------------------------------------------------------

  app.post('/v1/admin/balances/adjust', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.admin.adjustBalance.parse(request.body)

    const result = await tenant(request, async (tx) => {
      const [employee] = await tx
        .select()
        .from(employees)
        .where(eq(employees.id, body.employeeId))
        .limit(1)
      if (!employee) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Employee not found', 404)

      const [type] = await tx
        .select()
        .from(leaveTypes)
        .where(eq(leaveTypes.id, body.leaveTypeId))
        .limit(1)
      if (!type) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Leave type not found', 404)

      const [org] = await tx
        .select()
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)
      const settings = resolveSettings(org?.settings)
      const asOf = orgClock(org?.timezone ?? 'UTC').date

      const balance = await ensureBalance(tx, { employee, leaveType: type, settings, asOf })

      await tx
        .update(leaveBalances)
        .set({ adjustment: sql`${leaveBalances.adjustment} + ${body.delta}` })
        .where(eq(leaveBalances.id, balance.id))

      await tx.insert(leaveBalanceAdjustments).values({
        orgId: auth.orgId,
        employeeId: body.employeeId,
        leaveTypeId: body.leaveTypeId,
        periodStart: balance.periodStart,
        delta: String(body.delta),
        reason: body.reason,
        createdBy: auth.userId,
      })

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'leave_balance.adjusted',
        entityType: 'leave_balance',
        entityId: balance.id,
        before: { adjustment: num(balance.adjustment) },
        after: { delta: body.delta, reason: body.reason },
        ip: request.ip,
      })

      return { ok: true, periodStart: balance.periodStart }
    })

    return reply.send(result)
  })

  app.get('/v1/admin/devices/pending', async (request, reply) => {
    requireRole(request, 'hr_admin', 'owner')
    const rows = await tenant(request, async (tx) =>
      tx
        .select({
          id: devices.id,
          employeeId: devices.employeeId,
          firstName: employees.firstName,
          lastName: employees.lastName,
          deviceId: devices.deviceId,
          platform: devices.platform,
          name: devices.name,
          requestedAt: devices.approvalRequestedAt,
        })
        .from(devices)
        .innerJoin(employees, eq(employees.id, devices.employeeId))
        .where(eq(devices.approved, false)),
    )

    return reply.send({
      devices: rows.map((r) => ({
        id: r.id,
        employeeId: r.employeeId,
        employeeName: fullName(r),
        deviceId: r.deviceId,
        platform: r.platform,
        name: r.name,
        requestedAt: r.requestedAt?.toISOString() ?? null,
      })),
    })
  })

  app.post('/v1/admin/devices/approve', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = schemas.admin.approveDeviceChange.parse(request.body)

    await tenant(request, async (tx) => {
      // Approving a new device retires the old one — an employee has one bound
      // device, otherwise binding stops meaning anything.
      await tx
        .update(devices)
        .set({ approved: false })
        .where(eq(devices.employeeId, body.employeeId))

      const [approved] = await tx
        .update(devices)
        .set({ approved: true, approvalRequestedAt: null })
        .where(
          and(eq(devices.employeeId, body.employeeId), eq(devices.deviceId, body.deviceId)),
        )
        .returning()

      if (!approved) throw new ApiError(ERROR_CODES.NOT_FOUND, 'Device not found', 404)

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'device.approved',
        entityType: 'device',
        entityId: approved.id,
        after: { deviceId: body.deviceId },
        ip: request.ip,
      })
    })

    return reply.status(204).send()
  })

  app.post('/v1/admin/documents', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner')
    const body = z.object({
      employeeId: z.string().uuid().nullable(),
      type: z.enum(['contract', 'policy', 'payslip_placeholder', 'certificate', 'letter', 'other']),
      name: z.string().min(1).max(200),
      contentType: z.string().min(3).max(120),
      /** base64 payload; the console posts small files inline. */
      content: z.string().min(1),
      requiresAcknowledgement: z.boolean().default(false),
    }).parse(request.body)

    const buffer = Buffer.from(body.content, 'base64')
    if (buffer.length > 20_000_000) {
      throw new ApiError(ERROR_CODES.VALIDATION_FAILED, 'File is larger than 20MB', 413)
    }

    const key = storage().key(auth.orgId, body.name)
    await storage().put(key, buffer, body.contentType)

    const row = await tenant(request, async (tx) => {
      const [created] = await tx
        .insert(documents)
        .values({
          orgId: auth.orgId,
          employeeId: body.employeeId,
          type: body.type,
          name: body.name,
          s3Key: key,
          contentType: body.contentType,
          sizeBytes: buffer.length,
          uploadedBy: auth.userId,
          requiresAcknowledgement: body.requiresAcknowledgement,
        })
        .returning()

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'document.uploaded',
        entityType: 'document',
        entityId: created!.id,
        after: redact({ name: body.name, type: body.type, employeeId: body.employeeId }),
        ip: request.ip,
      })

      if (body.employeeId) {
        const [employee] = await tx
          .select({ userId: employees.userId })
          .from(employees)
          .where(eq(employees.id, body.employeeId))
          .limit(1)
        if (employee?.userId) {
          const { queueNotification } = await import('../lib/notify.js')
          await queueNotification(tx, {
            orgId: auth.orgId,
            userId: employee.userId,
            event: 'document.uploaded',
            title: 'New document',
            body: `${body.name} was added to your documents.`,
            deepLink: '/documents',
            data: { documentId: created!.id },
          })
        }
      }

      return created!
    })

    return reply.status(201).send({ id: row.id, name: row.name })
  })

  /**
   * The rotating code for an office display.
   *
   * Generated on demand if the rotation job has not produced one yet, so a fresh
   * install can be tested without waiting for a scheduler tick.
   */
  app.get('/v1/admin/checkin-code/:locationId', async (request, reply) => {
    const auth = requireRole(request, 'hr_admin', 'owner', 'manager')
    const { locationId } = request.params as { locationId: string }

    const result = await tenant(request, async (tx) => {
      const [org] = await tx
        .select()
        .from(organisations)
        .where(eq(organisations.id, auth.orgId))
        .limit(1)
      const settings = resolveSettings(org?.settings)

      const [current] = await tx
        .select()
        .from(checkinCodes)
        .where(
          and(
            eq(checkinCodes.locationId, locationId),
            gte(checkinCodes.validUntil, new Date()),
          ),
        )
        .orderBy(desc(checkinCodes.validUntil))
        .limit(1)

      if (current) {
        return {
          code: current.code,
          validUntil: current.validUntil.toISOString(),
          rotationMinutes: settings.codeRotationMinutes,
        }
      }

      const { rotateCodeForLocation } = await import('../jobs/codes.js')
      const created = await rotateCodeForLocation(
        tx,
        auth.orgId,
        locationId,
        settings.codeRotationMinutes,
      )
      return {
        code: created.code,
        validUntil: created.validUntil.toISOString(),
        rotationMinutes: settings.codeRotationMinutes,
      }
    })

    return reply.send(result)
  })
}

// ---------------------------------------------------------------------------

type EmployeeInput = ReturnType<typeof schemas.admin.upsertEmployee.parse>

async function upsertEmployee(
  tx: Tx,
  orgId: string,
  body: EmployeeInput,
  actorUserId: string,
) {
  // Every employee needs a user row to sign in with; email is the link.
  const [existingUser] = await tx
    .select()
    .from(users)
    .where(eq(users.email, body.email))
    .limit(1)

  let userId = existingUser?.id
  // Only a brand-new account gets a temporary password. Updating an existing
  // employee must never rotate their credential underneath them.
  let temporaryPassword: string | null = null
  if (!userId) {
    temporaryPassword = generateTemporaryPassword()
    const [created] = await tx
      .insert(users)
      .values({
        orgId,
        email: body.email,
        passwordHash: await hashPassword(temporaryPassword),
        mustChangePassword: true,
        notificationPreferences: {
          leaveDecisions: true,
          checkinReminders: true,
          balanceExpiry: true,
          documents: true,
        },
      })
      .returning()
    userId = created!.id
  }

  const values = {
    userId,
    employeeNumber: body.employeeNumber,
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    phone: body.phone ?? null,
    departmentId: body.departmentId ?? null,
    locationId: body.locationId ?? null,
    managerId: body.managerId ?? null,
    jobTitle: body.jobTitle ?? null,
    band: body.band ?? null,
    roleId: body.roleId ?? null,
    employmentType: body.employmentType,
    startDate: body.startDate,
    endDate: body.endDate ?? null,
    status: body.status,
    workScheduleId: body.workScheduleId ?? null,
    roles: body.roles,
    updatedAt: new Date(),
  }

  const [row] = await tx
    .insert(employees)
    .values({ orgId, ...values })
    .onConflictDoUpdate({
      target: [employees.orgId, employees.employeeNumber],
      set: values,
    })
    .returning()

  await audit(tx, {
    orgId,
    actorUserId,
    action: body.id ? 'employee.updated' : 'employee.created',
    entityType: 'employee',
    entityId: row!.id,
    after: redact({ ...values, phone: values.phone }),
  })

  return { ...row!, temporaryPassword }
}

interface ImportRowOutcome {
  result: ReturnType<typeof schemas.admin.bulkImportRowResult.parse>
  parsed: EmployeeInput | null
}

const REQUIRED_COLUMNS = ['employee_number', 'first_name', 'last_name', 'email', 'start_date']

function validateImportRow(
  raw: Record<string, string>,
  rowNumber: number,
  byNumber: Map<string, string>,
): ImportRowOutcome {
  const errors: { field: string; message: string }[] = []
  const get = (k: string) => (raw[k] ?? '').trim()

  for (const column of REQUIRED_COLUMNS) {
    if (!get(column)) errors.push({ field: column, message: 'Required' })
  }

  const email = get('email').toLowerCase()
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    errors.push({ field: 'email', message: 'Not a valid email address' })
  }

  const startDate = get('start_date')
  if (startDate && !isISODate(startDate)) {
    errors.push({ field: 'start_date', message: 'Use YYYY-MM-DD' })
  }

  const endDate = get('end_date')
  if (endDate && !isISODate(endDate)) {
    errors.push({ field: 'end_date', message: 'Use YYYY-MM-DD' })
  }
  if (startDate && endDate && isISODate(startDate) && isISODate(endDate) && endDate < startDate) {
    errors.push({ field: 'end_date', message: 'End date is before start date' })
  }

  const employmentType = get('employment_type') || 'full_time'
  if (!['full_time', 'part_time', 'contract', 'intern'].includes(employmentType)) {
    errors.push({ field: 'employment_type', message: 'Unknown employment type' })
  }

  const employeeNumber = get('employee_number')
  const name = [get('first_name'), get('last_name')].filter(Boolean).join(' ') || null

  if (errors.length > 0) {
    return {
      result: { rowNumber, action: 'error', employeeNumber: employeeNumber || null, name, errors },
      parsed: null,
    }
  }

  return {
    result: {
      rowNumber,
      action: byNumber.has(employeeNumber) ? 'update' : 'create',
      employeeNumber,
      name,
      errors: [],
    },
    parsed: {
      employeeNumber,
      firstName: get('first_name'),
      lastName: get('last_name'),
      email,
      phone: get('phone') || null,
      jobTitle: get('job_title') || null,
      band: get('band') || null,
      roleId: get('role_id') || null,
      employmentType: employmentType as EmployeeInput['employmentType'],
      startDate: startDate as ISODate,
      endDate: (endDate || null) as ISODate | null,
      status: 'active',
      roles: ['employee'],
      departmentId: null,
      locationId: null,
      managerId: null,
      workScheduleId: null,
    },
  }
}
