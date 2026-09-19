/**
 * Push notifications: registration, categories, and what a tap does.
 *
 * The server queues everything worth telling someone into `notifications`
 * and flushes it through Expo Push to whatever token the user's row holds.
 * Nothing ever arrived, because the app never sent a token. This does.
 *
 * Three jobs, all here so nothing else has to know Expo's API:
 *   - after sign-in, ask permission (if not yet decided), get the Expo push
 *     token and hand it to `/v1/auth/device` with the device id;
 *   - declare the categories whose notifications carry buttons, so the OS
 *     shows Accept / Decline on an invitation without opening the app;
 *   - when a notification is tapped, act on the button if there was one, and
 *     open the deep link either way.
 *
 * Web has no push and the whole module is a no-op there.
 */

import { Platform } from 'react-native'
import { api } from '../api/client'
import { getDeviceId } from '../store/session'

type Router = { push: (href: never) => void }

let registered = false
let listening = false

const CATEGORIES: { id: string; actions: { identifier: string; buttonTitle: string }[] }[] = [
  {
    id: 'meeting_invite',
    actions: [
      { identifier: 'accept', buttonTitle: 'Accept' },
      { identifier: 'decline', buttonTitle: 'Decline' },
    ],
  },
  {
    id: 'leave_approval',
    actions: [
      { identifier: 'approve', buttonTitle: 'Approve' },
      { identifier: 'decline', buttonTitle: 'Decline' },
    ],
  },
  { id: 'meeting_review', actions: [{ identifier: 'review', buttonTitle: 'Review' }] },
]

/** Once per session, after the session exists. Safe to call repeatedly. */
export async function registerForPush(): Promise<void> {
  if (Platform.OS === 'web' || registered) return
  try {
    const Notifications = await import('expo-notifications')
    const Device = await import('expo-device')
    const Constants = (await import('expo-constants')).default
    if (!Device.isDevice) return

    const current = await Notifications.getPermissionsAsync()
    let status = current.status
    if (status !== 'granted' && current.canAskAgain) {
      status = (await Notifications.requestPermissionsAsync()).status
    }
    if (status !== 'granted') return

    if (Platform.OS === 'android') {
      // Without a channel Android 8+ shows nothing at all.
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Quanti HR',
        importance: Notifications.AndroidImportance.HIGH,
      })
    }
    for (const c of CATEGORIES) {
      await Notifications.setNotificationCategoryAsync(c.id, c.actions)
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined))
      .data

    await api.post('/v1/auth/device', {
      pushToken: token,
      deviceId: await getDeviceId(),
      platform: Platform.OS,
    })
    registered = true
  } catch {
    // Push is a convenience; a failure here must never touch sign-in.
  }
}

/**
 * What a tap does. Buttons act without opening the screen; a plain tap, or a
 * button whose action needs a screen, opens the deep link.
 */
export async function listenForNotificationTaps(router: Router): Promise<() => void> {
  if (Platform.OS === 'web' || listening) return () => {}
  listening = true
  const Notifications = await import('expo-notifications')

  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  })

  const handle = async (response: {
    actionIdentifier: string
    notification: { request: { content: { data?: Record<string, unknown> } } }
  }) => {
    const data = response.notification.request.content.data ?? {}
    const action = response.actionIdentifier
    const meetingId = typeof data.meetingId === 'string' ? data.meetingId : null
    const deepLink = typeof data.deepLink === 'string' ? data.deepLink : null

    if (meetingId && (action === 'accept' || action === 'decline')) {
      try {
        await api.post(`/v1/meetings/${meetingId}/rsvp`, {
          response: action === 'accept' ? 'accepted' : 'declined',
        })
        return
      } catch {
        // Fall through to opening the meeting, where the buttons are again.
      }
    }
    if (deepLink) router.push(deepLink as never)
  }

  const sub = Notifications.addNotificationResponseReceivedListener((r) => void handle(r))
  // A tap that launched the app arrives before the listener existed.
  const initial = await Notifications.getLastNotificationResponseAsync()
  if (initial) void handle(initial)

  return () => {
    sub.remove()
    listening = false
  }
}
