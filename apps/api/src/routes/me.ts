/**
 * `/v1/me` and `/v1/config` — everything the client needs on launch.
 *
 * The home screen must render meaningful content with no network (spec §5), so
 * this response is deliberately self-contained: profile, roles, org config and
 * schedule in one round trip that the client can cache and hydrate from.
 */

import type { FastifyInstance } from 'fastify'
import { desc, eq } from 'drizzle-orm'
import { ApiError, ERROR_CODES, schemas } from '@quanti/shared'
import { employees, users, workSchedules } from '../db/schema.js'
import type { Database } from '../db/client.js'
import { audit } from '../lib/audit.js'
import { requireAuth, tenant } from '../lib/context.js'
import { fullName, loadEmployeeContext, resolveSettings } from './shared.js'

export function registerMeRoutes(app: FastifyInstance, _db: Database): void {
  app.get('/v1/me', async (request, reply) => {
    const auth = requireAuth(request)

    const payload = await tenant(request, async (tx) => {
      const ctx = await loadEmployeeContext(tx, auth.employeeId)
      const [user] = await tx.select().from(users).where(eq(users.id, auth.userId)).limit(1)
      if (!user) throw new ApiError(ERROR_CODES.NOT_FOUND, 'User not found', 404)

      let managerName: string | null = null
      if (ctx.employee.managerId) {
        const [manager] = await tx
          .select({ firstName: employees.firstName, lastName: employees.lastName })
          .from(employees)
          .where(eq(employees.id, ctx.employee.managerId))
          .limit(1)
        managerName = manager ? fullName(manager) : null
      }

      return {
        user: {
          id: user.id,
          email: user.email,
          biometricEnabled: user.biometricEnabled,
          notificationPreferences: user.notificationPreferences,
          hasPassword: user.passwordHash !== null,
          mustChangePassword: user.mustChangePassword,
        },
        employee: {
          id: ctx.employee.id,
          employeeNumber: ctx.employee.employeeNumber,
          firstName: ctx.employee.firstName,
          lastName: ctx.employee.lastName,
          email: ctx.employee.email,
          phone: ctx.employee.phone,
          jobTitle: ctx.employee.jobTitle,
          band: ctx.employee.band,
          departmentName: ctx.departmentName,
          locationName: ctx.location?.name ?? null,
          managerName,
          employmentType: ctx.employee.employmentType,
          startDate: ctx.employee.startDate,
          endDate: ctx.employee.endDate,
          status: ctx.employee.status,
        },
        roles: ctx.employee.roles,
        config: {
          org: {
            id: ctx.org.id,
            name: ctx.org.name,
            country: ctx.org.country,
            timezone: ctx.org.timezone,
          },
          settings: resolveSettings(ctx.org.settings),
          schedule: {
            id: ctx.employee.workScheduleId ?? '',
            name: 'Default',
            ...ctx.schedule,
          },
        },
      }
    })

    return reply.send(payload)
  })

  app.patch('/v1/me', async (request, reply) => {
    const auth = requireAuth(request)
    const body = schemas.config.updateMe.parse(request.body)

    const updated = await tenant(request, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, auth.userId)).limit(1)
      if (!user) throw new ApiError(ERROR_CODES.NOT_FOUND, 'User not found', 404)

      if (body.phone !== undefined) {
        await tx
          .update(employees)
          .set({ phone: body.phone, updatedAt: new Date() })
          .where(eq(employees.id, auth.employeeId))
      }

      const userPatch: Record<string, unknown> = {}
      if (body.biometricEnabled !== undefined) {
        userPatch.biometricEnabled = body.biometricEnabled
      }
      if (body.notificationPreferences) {
        userPatch.notificationPreferences = {
          ...(user.notificationPreferences as Record<string, boolean>),
          ...body.notificationPreferences,
        }
      }
      if (Object.keys(userPatch).length > 0) {
        await tx.update(users).set(userPatch).where(eq(users.id, auth.userId))
      }

      await audit(tx, {
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: 'employee.updated',
        entityType: 'employee',
        entityId: auth.employeeId,
        after: { fields: Object.keys(body) },
        ip: request.ip,
      })

      return { ok: true }
    })

    return reply.send(updated)
  })

  app.get('/v1/config', async (request, reply) => {
    const auth = requireAuth(request)

    const config = await tenant(request, async (tx) => {
      const ctx = await loadEmployeeContext(tx, auth.employeeId)
      return {
        org: {
          id: ctx.org.id,
          name: ctx.org.name,
          country: ctx.org.country,
          timezone: ctx.org.timezone,
        },
        settings: resolveSettings(ctx.org.settings),
        schedule: { id: ctx.employee.workScheduleId ?? '', name: 'Default', ...ctx.schedule },
      }
    })

    return reply.send(config)
  })

  app.get('/v1/notifications', async (request, reply) => {
    const auth = requireAuth(request)
    const rows = await tenant(request, async (tx) => {
      const { notifications } = await import('../db/schema.js')
      return tx
        .select()
        .from(notifications)
        .where(eq(notifications.userId, auth.userId))
        // Newest first: an inbox is read from the top.
        .orderBy(desc(notifications.createdAt))
        .limit(50)
    })
    return reply.send({
      notifications: rows.map((n) => ({
        id: n.id,
        event: n.event,
        title: n.title,
        body: n.body,
        deepLink: n.deepLink,
        // Carries the actions an event offers (accept/decline, approve/…) and
        // the ids the app needs to act on them without another round trip.
        data: n.data ?? {},
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
    })
  })
}
