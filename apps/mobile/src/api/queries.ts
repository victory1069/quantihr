/**
 * Query and mutation hooks.
 *
 * Reads are stale-while-revalidate against a persisted cache, so every screen
 * has something to show offline. Writes go through the outbox and update the
 * cache optimistically — the two halves of the offline story stay separate
 * (spec §6).
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query'
import type {
  AttendanceStatusResponse,
  CheckConflictsResponse,
  DocumentItem,
  LeaveBalanceView,
  LeaveRequestView,
  LeaveType,
  MeResponse,
  TeamAttendanceResponse,
  TeamCalendarResponse,
  ApprovalItem,
} from '@quanti/shared'
import { api } from './client'
import { enqueue } from '../lib/outbox'
import { drainOutbox } from './sync'

export const keys = {
  me: ['me'] as const,
  attendanceStatus: ['attendance', 'status'] as const,
  attendanceHistory: (from: string, to: string) => ['attendance', 'history', from, to] as const,
  leaveTypes: ['leave', 'types'] as const,
  balances: ['leave', 'balances'] as const,
  requests: (status?: string) => ['leave', 'requests', status ?? 'all'] as const,
  documents: ['documents'] as const,
  approvals: ['team', 'approvals'] as const,
  calendar: (from: string, to: string) => ['team', 'calendar', from, to] as const,
  teamAttendance: (from: string, to: string) => ['team', 'attendance', from, to] as const,
  notifications: ['notifications'] as const,
}

/** Long stale time: these change rarely and must render instantly from cache. */
const SLOW = { staleTime: 5 * 60_000 }
const LIVE = { staleTime: 30_000 }

export function useMe(options?: Partial<UseQueryOptions<MeResponse>>) {
  return useQuery({
    queryKey: keys.me,
    queryFn: ({ signal }) => api.get<MeResponse>('/v1/me', signal),
    ...SLOW,
    ...options,
  })
}

export function useAttendanceStatus() {
  return useQuery({
    queryKey: keys.attendanceStatus,
    queryFn: ({ signal }) =>
      api.get<AttendanceStatusResponse>('/v1/attendance/status', signal),
    ...LIVE,
  })
}

export function useAttendanceHistory(from: string, to: string) {
  return useQuery({
    queryKey: keys.attendanceHistory(from, to),
    queryFn: ({ signal }) =>
      api.get<{ records: AttendanceRecordView[] }>(
        `/v1/attendance/history?from=${from}&to=${to}`,
        signal,
      ),
    ...SLOW,
  })
}

export interface AttendanceRecordView {
  id: string
  date: string
  checkedInAt: string | null
  status: string
  minutesLate: number
  recordedOffline: boolean
  rejectionReason: string | null
}

export function useLeaveTypes() {
  return useQuery({
    queryKey: keys.leaveTypes,
    queryFn: ({ signal }) => api.get<{ types: LeaveType[] }>('/v1/leave/types', signal),
    staleTime: 30 * 60_000,
  })
}

export function useBalances() {
  return useQuery({
    queryKey: keys.balances,
    queryFn: ({ signal }) =>
      api.get<{ balances: LeaveBalanceView[] }>('/v1/leave/balances', signal),
    ...SLOW,
  })
}

export function useLeaveRequests(status?: string) {
  return useQuery({
    queryKey: keys.requests(status),
    queryFn: ({ signal }) =>
      api.get<{ requests: LeaveRequestView[] }>(
        `/v1/leave/requests${status ? `?status=${status}` : ''}`,
        signal,
      ),
    ...SLOW,
  })
}

export function useDocuments() {
  return useQuery({
    queryKey: keys.documents,
    queryFn: ({ signal }) =>
      api.get<{ documents: DocumentItem[] }>('/v1/documents', signal),
    ...SLOW,
  })
}

export function useApprovals(enabled: boolean) {
  return useQuery({
    queryKey: keys.approvals,
    queryFn: ({ signal }) =>
      api.get<{ approvals: ApprovalItem[] }>('/v1/team/approvals', signal),
    enabled,
    ...LIVE,
  })
}

export function useTeamCalendar(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: keys.calendar(from, to),
    queryFn: ({ signal }) =>
      api.get<TeamCalendarResponse>(`/v1/team/calendar?from=${from}&to=${to}`, signal),
    enabled,
    ...SLOW,
  })
}

export function useTeamAttendance(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.teamAttendance(from, to),
    queryFn: ({ signal }) =>
      api.get<TeamAttendanceResponse>(`/v1/team/attendance?from=${from}&to=${to}`, signal),
    enabled,
    ...SLOW,
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CheckinInput {
  code: string
  latitude: number
  longitude: number
  accuracyM: number
  isMocked: boolean
  deviceId: string
  wifiBssid?: string
}

/**
 * Check-in.
 *
 * Queued to the outbox first, then drained immediately. If the drain fails
 * because the device is offline, the row survives and the background task
 * retries — the employee is not asked to remember to try again.
 */
export function useCheckin() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: CheckinInput) => {
      const row = await enqueue({
        endpoint: '/v1/attendance/checkin',
        method: 'POST',
        payload: {
          ...input,
          clientTimestamp: new Date().toISOString(),
          recordedOffline: false,
        },
      })
      return drainOutbox({ only: row.id })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.attendanceStatus })
    },
  })
}

export interface LeaveRequestInput {
  leaveTypeId: string
  start: string
  end: string
  halfDayStart: boolean
  halfDayEnd: boolean
  reason?: string
}

export function useCreateLeaveRequest() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (input: LeaveRequestInput) => {
      const row = await enqueue({
        endpoint: '/v1/leave/requests',
        method: 'POST',
        payload: input,
      })
      return drainOutbox({ only: row.id })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.balances })
      void queryClient.invalidateQueries({ queryKey: ['leave', 'requests'] })
    },
  })
}

export function useCheckConflicts() {
  return useMutation({
    mutationFn: (input: {
      leaveTypeId: string
      start: string
      end: string
      halfDayStart: boolean
      halfDayEnd: boolean
    }) => api.post<CheckConflictsResponse>('/v1/leave/check-conflicts', input),
  })
}

export function useCancelLeaveRequest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/v1/leave/requests/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.balances })
      void queryClient.invalidateQueries({ queryKey: ['leave', 'requests'] })
    },
  })
}

export interface DecisionInput {
  id: string
  decision: 'approve' | 'decline'
  note?: string
  overrideReason?: string
}

export function useDecideApproval() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...body }: DecisionInput) =>
      api.post<LeaveRequestView>(`/v1/team/approvals/${id}`, body),

    // Optimistically drop the card from the queue so the list feels immediate.
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: keys.approvals })
      const previous = queryClient.getQueryData<{ approvals: ApprovalItem[] }>(keys.approvals)
      queryClient.setQueryData<{ approvals: ApprovalItem[] }>(keys.approvals, (old) =>
        old ? { approvals: old.approvals.filter((a) => a.id !== id) } : old,
      )
      return { previous }
    },

    onError: (_error, _vars, context) => {
      // Put it back — an override-required rejection must not lose the card.
      if (context?.previous) queryClient.setQueryData(keys.approvals, context.previous)
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.approvals })
      void queryClient.invalidateQueries({ queryKey: ['team', 'calendar'] })
    },
  })
}

export function useUpdateMe() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<{ ok: boolean }>('/v1/me', body),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: keys.me }),
  })
}

export function useDocumentUrl() {
  return useMutation({
    mutationFn: (id: string) =>
      api.get<{ url: string; expiresAt: string }>(`/v1/documents/${id}/url`),
  })
}
