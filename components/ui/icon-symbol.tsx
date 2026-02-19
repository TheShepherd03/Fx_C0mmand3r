// Fallback for using MaterialIcons on Android and web.

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { ComponentProps } from 'react';
import { OpaqueColorValue, type StyleProp, type TextStyle } from 'react-native';

type IconMapping = Record<string, ComponentProps<typeof MaterialIcons>['name']>;
type IconSymbolName = keyof typeof MAPPING;

/**
 * Add your SF Symbols to Material Icons mappings here.
 * - see Material Icons in the [Icons Directory](https://icons.expo.fyi).
 * - see SF Symbols in the [SF Symbols](https://developer.apple.com/sf-symbols/) app.
 */
const MAPPING: IconMapping = {
  // Navigation & General
  'house.fill': 'home',
  'paperplane.fill': 'send',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.right': 'chevron-right',
  'list.bullet': 'list',
  'antenna.radiowaves.left.and.right': 'settings-input-antenna',
  'bolt.fill': 'flash-on',
  'arrow.left': 'arrow-back',
  'xmark': 'close',
  'gear': 'settings',
  'checkmark': 'check',
  'info.circle': 'info',
  'exclamationmark.triangle.fill': 'warning',
  'tray': 'inbox',

  // Dashboard
  'building.columns.fill': 'account-balance',
  'chart.line.uptrend.xyaxis': 'show-chart',
  'lock.open.fill': 'lock-open',
  'percent': 'pie-chart',

  // Signals
  'magnifyingglass': 'search',
  'slider.horizontal.3': 'tune',
  'antenna.radiowaves.left.and.right.slash': 'signal-cellular-off',

  // Trade Control & Actions
  'clock.arrow.circlepath': 'history',
  'exclamationmark.shield.fill': 'security',
  'cpu': 'memory',
  'arrow.triangle.2.circlepath': 'sync',
  'chart.line.downtrend.xyaxis': 'trending-down',
  'clock.badge.exclamationmark': 'pending-actions',
  'clock.fill': 'schedule',
  'anchor': 'anchor',
  'banknote': 'attach-money',

  // Modal / Management
  'scalemass': 'compare-arrows', // Representing balance/break-even
  'scissors': 'content-cut',
  'chart.bar.fill': 'bar-chart',
  'clock': 'schedule',
  'trash': 'delete',
} as IconMapping;

/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 * This ensures a consistent look across platforms, and optimal resource usage.
 * Icon `name`s are based on SF Symbols and require manual mapping to Material Icons.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
}) {
  return <MaterialIcons color={color} size={size} name={MAPPING[name]} style={style} />;
}
