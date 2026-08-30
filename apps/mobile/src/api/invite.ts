/**
 * Invite lookup.
 *
 * Quanti is invite-only: an employer adds you, and you cannot create an account
 * on your own. That single fact shapes the whole sign-up flow — the email is
 * read-only because it is the payroll identity link (L3), and an unrecognised
 * address gets an explanation rather than a signup form (L14).
 *
 * Backend status: `/v1/auth/invite` does not exist yet. Until it does this
 * resolves from whatever the invite deep link carried, and falls back to a
 * generic state rather than inventing an employer name. Wiring it up means one
 * endpoint returning `{ orgName, email, phoneHint }` for an invite token.
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
}

const UNRESOLVED: Invite = {
  orgName: 'your employer',
  email: null,
  phoneHint: null,
  found: true,
}

export function useInvite() {
  const params = useLocalSearchParams<{ invite?: string; email?: string }>()
  const token = params.invite
  const email = params.email

  return useQuery({
    queryKey: ['invite', token ?? email ?? 'none'],
    queryFn: async (): Promise<Invite> => {
      if (!token && !email) return UNRESOLVED

      try {
        const query = token ? `token=${encodeURIComponent(token)}` : `email=${encodeURIComponent(email!)}`
        const response = await fetch(`${API_BASE_URL}/v1/auth/invite?${query}`)

        // The endpoint is not built yet. Treat its absence as "unknown invite"
        // rather than "no invite" — telling someone they were never invited
        // because a route is missing would be a bad first impression.
        if (response.status === 404 || response.status === 501) return UNRESOLVED
        if (!response.ok) return UNRESOLVED

        return (await response.json()) as Invite
      } catch {
        return UNRESOLVED
      }
    },
    staleTime: Infinity,
    retry: false,
  })
}
