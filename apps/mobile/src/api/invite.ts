/**
 * Invite lookup.
 *
 * Quanti is invite-only: an employer adds you, and you cannot create an account
 * on your own. That single fact shapes the whole sign-up flow — the email is
 * read-only because it is the payroll identity link (L3), and an unrecognised
 * address gets an explanation rather than a signup form (L14).
 *
 * Backed by `GET /v1/auth/invite`, which is rate-limited because it confirms
 * whether an address belongs to an employee. A network failure resolves to an
 * unknown state rather than "no invite" — telling someone they were never
 * invited because a request timed out would be a bad first impression.
 */

import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { API_BASE_URL } from './client'

export interface Invite {
  orgName: string
  email: string | null
  /** Masked tail of the number on the HR record, e.g. `+234 803 •••• 41`. */
  phoneHint: string | null
  /** False when the address is not on any people list — drives screen L14. */
  found: boolean
  /** Employment has ended; sign-up is closed but the archive may be open (X4). */
  ended?: boolean
  /** The lookup could not be completed. Distinct from `found: false`. */
  unknown?: boolean
}

const UNRESOLVED: Invite = {
  orgName: 'Your employer',
  email: null,
  phoneHint: null,
  found: true,
  unknown: true,
}

export function useInvite(emailOverride?: string) {
  const params = useLocalSearchParams<{ invite?: string; email?: string }>()
  const token = params.invite
  const email = emailOverride ?? params.email

  return useQuery({
    queryKey: ['invite', token ?? email ?? 'none'],
    queryFn: async (): Promise<Invite> => {
      if (!token && !email) return UNRESOLVED

      try {
        const query = token
          ? `token=${encodeURIComponent(token)}`
          : `email=${encodeURIComponent(email!)}`
        const response = await fetch(`${API_BASE_URL}/v1/auth/invite?${query}`)

        // Anything other than a clean answer is "unknown", never "no invite".
        if (!response.ok) return UNRESOLVED

        const body = (await response.json()) as Invite
        return { ...body, orgName: body.orgName ?? 'Your employer' }
      } catch {
        return UNRESOLVED
      }
    },
    staleTime: Infinity,
    retry: false,
  })
}
