export * as common from './common.js'
export * as auth from './auth.js'
export * as attendance from './attendance.js'
export * as leave from './leave.js'
export * as team from './team.js'
export * as documents from './documents.js'
export * as config from './config.js'
export * as admin from './admin.js'

export type { Role, LeaveRequestStatus, AttendanceStatusValue } from './common.js'
export type { JwtClaims, SessionResponse } from './auth.js'
export type { CheckinRequest, VerificationSignals, AttendanceStatusResponse } from './attendance.js'
export type {
  LeaveType,
  LeaveBalanceView,
  LeaveRequestView,
  CheckConflictsResponse,
  CreateLeaveRequest,
  ApprovalDecision,
} from './leave.js'
export type { ApprovalItem, TeamCalendarResponse, TeamAttendanceResponse } from './team.js'
export type { DocumentItem } from './documents.js'
export type { OrgSettings, ConfigResponse, MeResponse, WorkScheduleView } from './config.js'
export { DEFAULT_ORG_SETTINGS } from './config.js'
export type {
  UpsertEmployee,
  UpsertLeaveType,
  UpsertLocation,
  BulkImportResponse,
} from './admin.js'
export * as meetings from './meetings.js'

export type {
  MeetingListItem,
  MeetingDetail,
  MeetingActionView,
  MeetingParticipantView,
  MeetingSummaryView,
  MyActionItem,
  SpeakerClip,
  MeetingTypeView,
  MeetEligibility,
  MeetingSettings,
  ExtractionOutput,
  ExtractedAction,
} from './meetings.js'
export { DEFAULT_MEETING_SETTINGS } from './meetings.js'
