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
  payslips: ['payroll', 'payslips'] as const,
  payslip: (id: string) => ['payroll', 'payslip', id] as const,
  approvals: ['team', 'approvals'] as const,
  calendar: (from: string, to: string) => ['team', 'calendar', from, to] as const,
  teamAttendance: (from: string, to: string) => ['team', 'attendance', from, to] as const,
  notifications: ['notifications'] as const,
  meetings: (window: string) => ['meetings', window] as const,
  meeting: (id: string) => ['meetings', 'detail', id] as const,
  speakers: (id: string) => ['meetings', 'speakers', id] as const,
  tasks: (status: string) => ['tasks', status] as const,
  meetingAttendance: (source: string) => ['attendance', 'meetings', source] as const,
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

// --- Payroll ---------------------------------------------------------------

export interface PayslipSummary {
  id: string
  runId: string
  gross: number
  netPay: number
  paye: number
  periodStart: string
  periodEnd: string
  payDate: string
  status: string
}

export interface PayslipLine {
  code: string
  label: string
  amount: number
  category: 'earning' | 'statutory' | 'deduction' | 'employer_cost'
}

export interface PayslipChange {
  code: string
  label: string
  previous: number
  current: number
  delta: number
  direction: 'increase' | 'decrease' | 'new' | 'removed'
}

export interface PayslipDetail {
  id: string
  periodStart: string
  periodEnd: string
  payDate: string
  detail: {
    gross: number
    netPay: number
    paye: number
    pensionEmployee: number
    nhf: number
    totalDeductions: number
    lines: PayslipLine[]
  }
  explanation: {
    netDelta: number
    grossDelta: number
    changes: PayslipChange[]
    summary: string
  } | null
}

export function usePayslips() {
  return useQuery({
    queryKey: keys.payslips,
    queryFn: ({ signal }) =>
      api.get<{ payslips: PayslipSummary[] }>('/v1/payroll/payslips', signal),
    ...SLOW,
  })
}

export function usePayslip(id: string | undefined) {
  return useQuery({
    queryKey: keys.payslip(id ?? ''),
    queryFn: ({ signal }) => api.get<PayslipDetail>(`/v1/payroll/payslips/${id}`, signal),
    enabled: !!id,
    ...SLOW,
  })
}

export function useDocumentUrl() {
  return useMutation({
    mutationFn: (id: string) =>
      api.get<{ url: string; expiresAt: string }>(`/v1/documents/${id}/url`),
  })
}

// ---------------------------------------------------------------------------
// Meeting assistant
// ---------------------------------------------------------------------------

export interface MeetingListItemView {
  id: string
  title: string
  source: 'google_meet' | 'in_person'
  status: string
  scheduledStart: string
  scheduledEnd: string
  actualStart: string | null
  hostEmployeeId: string | null
  isHost: boolean
  awaitingYourReview: boolean
  routeToHr: boolean
  participantCount: number
  actionCount: number
}

export interface MeetingActionItem {
  id: string
  description: string
  ownerEmployeeId: string | null
  ownerName: string | null
  ownerStated: string | null
  ownerConfidence: 'explicit' | 'implied' | 'unclear'
  dueDate: string | null
  sourceQuote: string
  timestampMs: number
  status: 'draft' | 'confirmed' | 'dismissed' | 'done'
}

export interface MeetingParticipantItem {
  employeeId: string
  employeeName: string
  attendanceStatus: string | null
  minutesLate: number
  inviteStatus: string
  isOptional: boolean
  firstJoinAt: string | null
  totalDurationSeconds: number
  source: string | null
  expected: boolean
}

export interface MeetingDetailView {
  id: string
  title: string
  source: 'google_meet' | 'in_person'
  status: string
  scheduledStart: string
  scheduledEnd: string
  actualStart: string | null
  actualEnd: string | null
  hostEmployeeId: string | null
  isHost: boolean
  routeToHr: boolean
  meetingTypeName: string | null
  attendanceResolution: 'did_not_occur' | 'too_short' | 'recorded' | null
  summary: {
    overview: string
    decisions: { decision: string; context: string; timestamp_ms: number }[]
    topics: { topic: string; points: string[] }[]
    openQuestions: string[]
    model: string
    tokensUsed: number
    generatedAt: string
  } | null
  participants: MeetingParticipantItem[]
  actions: MeetingActionItem[]
  unresolvedSpeakers: string[]
}

export interface TaskItem extends MeetingActionItem {
  meetingId: string
  meetingTitle: string
  meetingDate: string
}

export interface SpeakerClipView {
  speakerLabel: string
  startMs: number
  endMs: number
  text: string
  employeeId: string | null
}

export function useMeetings(window: 'upcoming' | 'past' = 'past') {
  return useQuery({
    queryKey: keys.meetings(window),
    queryFn: ({ signal }) =>
      api.get<{ meetings: MeetingListItemView[] }>(`/v1/meetings?window=${window}`, signal),
    ...LIVE,
  })
}

export function useMeeting(id: string | undefined) {
  return useQuery({
    queryKey: keys.meeting(id ?? ''),
    queryFn: ({ signal }) => api.get<MeetingDetailView>(`/v1/meetings/${id}`, signal),
    enabled: !!id,
    ...LIVE,
  })
}

export function useTasks(status: 'open' | 'done' | 'all' = 'open') {
  return useQuery({
    queryKey: keys.tasks(status),
    queryFn: ({ signal }) =>
      api.get<{ tasks: TaskItem[] }>(`/v1/tasks?status=${status}`, signal),
    ...LIVE,
  })
}

export function useSpeakers(id: string | undefined) {
  return useQuery({
    queryKey: keys.speakers(id ?? ''),
    queryFn: ({ signal }) =>
      api.get<{
        speakers: SpeakerClipView[]
        attendees: { employeeId: string; employeeName: string }[]
      }>(`/v1/meetings/${id}/speakers`, signal),
    enabled: !!id,
  })
}

/**
 * Host review.
 *
 * Sent as one call for the whole set rather than one per action, because the
 * screen's target is fifteen seconds and a round trip per row does not fit
 * inside that.
 */
export function useSubmitReview(meetingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: {
      decisions: {
        actionId: string
        decision: 'confirm' | 'dismiss'
        description?: string
        ownerEmployeeId?: string | null
        dueDate?: string | null
      }[]
      overview?: string
    }) => api.post<{ confirmed: number; dismissed: number }>(
      `/v1/meetings/${meetingId}/review`,
      body,
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.meeting(meetingId) })
      void queryClient.invalidateQueries({ queryKey: keys.meetings('past') })
      void queryClient.invalidateQueries({ queryKey: keys.tasks('open') })
    },
  })
}

export function useTagSpeakers(meetingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (mappings: { speakerLabel: string; employeeId: string | null }[]) =>
      api.post(`/v1/meetings/${meetingId}/speakers`, { mappings }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.meeting(meetingId) })
      void queryClient.invalidateQueries({ queryKey: keys.speakers(meetingId) })
    },
  })
}

export function useCompleteTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post(`/v1/tasks/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.tasks('open') })
    },
  })
}

export function useRaiseDispute(meetingId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (reason: string) =>
      api.post(`/v1/meetings/${meetingId}/disputes`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.meeting(meetingId) })
    },
  })
}

/** Recording controls. Chunks upload as they complete, not as one file at the end. */
export function useRecording(meetingId: string) {
  const queryClient = useQueryClient()

  const start = useMutation({
    mutationFn: () => api.post(`/v1/meetings/${meetingId}/recording/start`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.meeting(meetingId) })
    },
  })

  const uploadChunk = useMutation({
    mutationFn: (chunk: { sequence: number; audio: string; durationMs: number }) =>
      api.post(`/v1/meetings/${meetingId}/recording/chunk`, chunk),
  })

  const stop = useMutation({
    mutationFn: () =>
      api.post<{ status: string; speakersToTag?: number; transcription?: string }>(
        `/v1/meetings/${meetingId}/recording/stop`,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.meeting(meetingId) })
    },
  })

  const offRecord = useMutation({
    mutationFn: (atMs: number) =>
      api.post(`/v1/meetings/${meetingId}/off-record`, { atMs }),
  })

  return { start, uploadChunk, stop, offRecord }
}

export interface MeetingAttendanceRow {
  meetingId: string
  title: string
  source: 'google_meet' | 'in_person'
  scheduledStart: string
  actualStart: string | null
  attendanceStatus: 'present' | 'late' | 'absent' | 'excused' | 'void' | null
  minutesLate: number
  firstJoinAt: string | null
  totalDurationSeconds: number
  resolution: 'did_not_occur' | 'too_short' | 'recorded' | null
  expected: boolean
}

export interface MeetingAttendanceResponse {
  records: MeetingAttendanceRow[]
  attended: number
  late: number
  missed: number
  totalMinutesLate: number
}

/** The caller's own attendance for one meeting source. */
export function useMeetingAttendance(source: 'in_person' | 'google_meet') {
  return useQuery({
    queryKey: keys.meetingAttendance(source),
    queryFn: ({ signal }) =>
      api.get<MeetingAttendanceResponse>(`/v1/attendance/meetings?source=${source}`, signal),
    ...SLOW,
  })
}
