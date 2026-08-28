import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify'
import { ZodError } from 'zod'
import { ApiError, ERROR_CODES } from '@quanti/shared'

/**
 * One error shape for the whole API: `{ code, message, details? }`.
 *
 * The offline outbox decides whether to retry from `code` alone (see
 * `isPermanent` in shared/errors), so an unclassified 500 must never be
 * returned for something the client could have fixed.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send(error.toBody())
    }

    if (error instanceof ZodError) {
      return reply.status(422).send({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Request failed validation',
        details: {
          issues: error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }

    // Fastify's own validation / parse errors.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply.status(error.statusCode).send({
        code: ERROR_CODES.VALIDATION_FAILED,
        message: error.message,
      })
    }

    request.log.error({ err: error }, 'unhandled error')
    return reply.status(500).send({
      code: ERROR_CODES.INTERNAL,
      message: 'Something went wrong on our end',
    })
  })

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ code: ERROR_CODES.NOT_FOUND, message: 'Not found' }),
  )
}
