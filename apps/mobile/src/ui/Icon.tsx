/**
 * Line icons, drawn with Views.
 *
 * The brand pack's icons are stroked SVG paths, and `react-native-svg` is not
 * installed. Rather than ship the improvised text glyphs that were here before
 * (`⌂ ◎ ≡ ₦ ▤ ◍` — which looked like placeholder characters, because they were),
 * these rebuild the same shapes from bordered Views at the same 24px grid and
 * 2px stroke weight as the source set.
 *
 * They are geometric by necessity, which suits the mark. When
 * `react-native-svg` is available, swap this file for the real paths — the
 * component API is deliberately identical so nothing else changes.
 */

import { View, type ViewStyle } from 'react-native'
import { colour } from './theme'

export type IconName =
  | 'home'
  | 'time'
  | 'leave'
  | 'payroll'
  | 'documents'
  | 'profile'
  | 'approvals'
  | 'calendar'
  | 'insights'
  | 'todos'
  | 'team'

interface IconProps {
  name: IconName
  size?: number
  color?: string
  /** Secondary stroke. Defaults to none; pass a palette colour to tint it. */
  accent?: string
}

export function Icon({ name, size = 24, color = colour.textMuted, accent }: IconProps) {
  const s = size / 24
  const stroke = Math.max(1.6, 2 * s)
  const tint = accent ?? color
  const box: ViewStyle = { width: size, height: size }

  const line = (style: ViewStyle): ViewStyle => ({
    position: 'absolute',
    backgroundColor: color,
    borderRadius: stroke,
    ...style,
  })

  switch (name) {
    // Ring of dots echoing the brand mark, at nav scale.
    case 'home':
      return (
        <View style={box}>
          <View
            style={{
              position: 'absolute',
              left: 3 * s,
              top: 3 * s,
              width: 18 * s,
              height: 18 * s,
              borderRadius: 9 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: 10 * s,
              top: 10 * s,
              width: 4 * s,
              height: 4 * s,
              borderRadius: 2 * s,
              backgroundColor: tint,
            }}
          />
        </View>
      )

    // Clock: circle with two hands.
    case 'time':
      return (
        <View style={box}>
          <View
            style={{
              position: 'absolute',
              left: 3 * s,
              top: 3 * s,
              width: 18 * s,
              height: 18 * s,
              borderRadius: 9 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View style={line({ left: 11.2 * s, top: 7 * s, width: stroke, height: 6 * s })} />
          <View style={line({ left: 11.2 * s, top: 11.4 * s, width: 4.5 * s, height: stroke })} />
        </View>
      )

    // Calendar with a tick.
    case 'leave':
      return (
        <View style={box}>
          <View
            style={{
              position: 'absolute',
              left: 3.5 * s,
              top: 5 * s,
              width: 17 * s,
              height: 16 * s,
              borderRadius: 4 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View style={line({ left: 7.5 * s, top: 2.5 * s, width: stroke, height: 4 * s })} />
          <View style={line({ left: 15.5 * s, top: 2.5 * s, width: stroke, height: 4 * s })} />
          <View
            style={{
              position: 'absolute',
              left: 8 * s,
              top: 12.5 * s,
              width: 7 * s,
              height: 3.6 * s,
              borderLeftWidth: stroke,
              borderBottomWidth: stroke,
              borderColor: tint,
              transform: [{ rotate: '-45deg' }],
            }}
          />
        </View>
      )

    // Card with a magnetic stripe.
    case 'payroll':
      return (
        <View style={box}>
          <View
            style={{
              position: 'absolute',
              left: 2.5 * s,
              top: 5.5 * s,
              width: 19 * s,
              height: 13 * s,
              borderRadius: 3.5 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View style={line({ left: 2.5 * s, top: 10 * s, width: 19 * s, height: stroke })} />
          <View
            style={{
              position: 'absolute',
              left: 6 * s,
              top: 13.6 * s,
              width: 2.8 * s,
              height: 2.8 * s,
              borderRadius: 1.4 * s,
              backgroundColor: tint,
            }}
          />
        </View>
      )

    // Document with folded corner.
    case 'documents':
      return (
        <View style={box}>
          <View
            style={{
              position: 'absolute',
              left: 5 * s,
              top: 2.5 * s,
              width: 14 * s,
              height: 19 * s,
              borderRadius: 3 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View style={line({ left: 8 * s, top: 9 * s, width: 8 * s, height: stroke })} />
          <View style={line({ left: 8 * s, top: 13 * s, width: 8 * s, height: stroke })} />
          <View style={line({ left: 8 * s, top: 17 * s, width: 5 * s, height: stroke, backgroundColor: tint })} />
        </View>
      )

    // Head and shoulders.
    case 'profile':
      return (
        <View style={box}>
          <View
            style={{
              position: 'absolute',
              left: 8 * s,
              top: 3 * s,
              width: 8 * s,
              height: 8 * s,
              borderRadius: 4 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: 4 * s,
              top: 14 * s,
              width: 16 * s,
              height: 14 * s,
              borderRadius: 8 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
        </View>
      )

    // Shield with a check — same construction as the brand's compliance icon.
    case 'approvals':
      return (
        <View style={box}>
          <View
            style={{
              position: 'absolute',
              left: 4.5 * s,
              top: 3.5 * s,
              width: 15 * s,
              height: 15 * s,
              borderRadius: 4 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: 8.5 * s,
              top: 9.5 * s,
              width: 7 * s,
              height: 3.6 * s,
              borderLeftWidth: stroke,
              borderBottomWidth: stroke,
              borderColor: tint,
              transform: [{ rotate: '-45deg' }],
            }}
          />
        </View>
      )

    case 'calendar':
      return (
        <View style={box}>
          <View
            style={{
              position: 'absolute',
              left: 3.5 * s,
              top: 5 * s,
              width: 17 * s,
              height: 16 * s,
              borderRadius: 4 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View style={line({ left: 3.5 * s, top: 9.5 * s, width: 17 * s, height: stroke })} />
          <View style={line({ left: 7.5 * s, top: 2.5 * s, width: stroke, height: 4 * s })} />
          <View style={line({ left: 15.5 * s, top: 2.5 * s, width: stroke, height: 4 * s })} />
          <View
            style={{
              position: 'absolute',
              left: 7 * s,
              top: 13 * s,
              width: 3 * s,
              height: 3 * s,
              borderRadius: 1.5 * s,
              backgroundColor: tint,
            }}
          />
        </View>
      )

    // Checklist: three ticked lines.
    case 'todos':
      return (
        <View style={box}>
          {[6, 12, 18].map((y, i) => (
            <View key={y}>
              <View
                style={{
                  position: 'absolute',
                  left: 3 * s,
                  top: (y - 2) * s,
                  width: 4.5 * s,
                  height: 2.4 * s,
                  borderLeftWidth: stroke,
                  borderBottomWidth: stroke,
                  borderColor: i === 0 ? tint : color,
                  transform: [{ rotate: '-45deg' }],
                }}
              />
              <View style={line({ left: 11 * s, top: (y - 1) * s, width: 10 * s, height: stroke })} />
            </View>
          ))}
        </View>
      )

    // Two people — the manager's team.
    case 'team':
      return (
        <View style={box}>
          <View
            style={{
              position: 'absolute',
              left: 4.5 * s,
              top: 3.5 * s,
              width: 7 * s,
              height: 7 * s,
              borderRadius: 3.5 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: 1.5 * s,
              top: 13 * s,
              width: 13 * s,
              height: 11 * s,
              borderRadius: 6.5 * s,
              borderWidth: stroke,
              borderColor: color,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: 13.5 * s,
              top: 5.5 * s,
              width: 6 * s,
              height: 6 * s,
              borderRadius: 3 * s,
              borderWidth: stroke,
              borderColor: tint,
            }}
          />
          <View
            style={{
              position: 'absolute',
              left: 13 * s,
              top: 14 * s,
              width: 9.5 * s,
              height: 9 * s,
              borderRadius: 5 * s,
              borderWidth: stroke,
              borderColor: tint,
            }}
          />
        </View>
      )

    // Ascending bars with a marker dot.
    case 'insights':
      return (
        <View style={box}>
          <View style={line({ left: 4 * s, top: 12 * s, width: stroke, height: 8 * s })} />
          <View style={line({ left: 10 * s, top: 7 * s, width: stroke, height: 13 * s })} />
          <View style={line({ left: 16 * s, top: 10 * s, width: stroke, height: 10 * s })} />
          <View
            style={{
              position: 'absolute',
              left: 18.5 * s,
              top: 4 * s,
              width: 3.2 * s,
              height: 3.2 * s,
              borderRadius: 1.6 * s,
              backgroundColor: tint,
            }}
          />
        </View>
      )
  }
}
