import React from 'react';
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconSymbol } from '@/components/ui/icon-symbol';
import { useTheme } from '@/contexts/ThemeContext';

type IconName = React.ComponentProps<typeof IconSymbol>['name'];

export interface SignalAction {
  key: string;
  label: string;
  hint?: string;
  icon: IconName;
  destructive?: boolean;
  onPress: () => void;
}

interface Props {
  visible: boolean;
  title: string;
  subtitle?: string;
  actions: SignalAction[];
  onClose: () => void;
}

/** Bottom action sheet for a signal card's "…" menu / long-press. */
export function SignalActionSheet({ visible, title, subtitle, actions, onClose }: Props) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: theme.colors.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close menu" />
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.colors.card, paddingBottom: Math.max(insets.bottom, 12) + 12 },
          ]}>
          <View style={styles.grabber}>
            <View style={[styles.grabberBar, { backgroundColor: theme.colors.border }]} />
          </View>

          <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
            {title}
          </Text>
          {!!subtitle && (
            <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
              {subtitle}
            </Text>
          )}

          <View style={[styles.list, { borderColor: theme.colors.border }]}>
            {actions.map((a, i) => {
              const tint = a.destructive ? theme.colors.error : theme.colors.text;
              return (
                <TouchableOpacity
                  key={a.key}
                  style={[
                    styles.row,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border },
                  ]}
                  onPress={() => {
                    onClose();
                    a.onPress();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={a.label}
                  accessibilityHint={a.hint}>
                  <View
                    style={[
                      styles.iconBox,
                      { backgroundColor: a.destructive ? theme.colors.error + '1A' : theme.colors.input },
                    ]}>
                    <IconSymbol
                      name={a.icon}
                      size={18}
                      color={a.destructive ? theme.colors.error : theme.colors.textSecondary}
                    />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={[styles.label, { color: tint }]} numberOfLines={1}>
                      {a.label}
                    </Text>
                    {!!a.hint && (
                      <Text style={[styles.hint, { color: theme.colors.textTertiary }]} numberOfLines={1}>
                        {a.hint}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            style={[styles.cancel, { backgroundColor: theme.colors.input }]}
            onPress={onClose}
            accessibilityRole="button">
            <Text style={[styles.cancelText, { color: theme.colors.text }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 16,
  },
  grabber: {
    alignItems: 'center',
    paddingTop: 10,
    paddingBottom: 8,
  },
  grabberBar: {
    width: 44,
    height: 5,
    borderRadius: 3,
    opacity: 0.6,
  },
  title: {
    fontSize: 18,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 2,
  },
  list: {
    marginTop: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: {
    flex: 1,
  },
  label: {
    fontSize: 15,
    fontWeight: '700',
  },
  hint: {
    fontSize: 12,
    marginTop: 2,
  },
  cancel: {
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
