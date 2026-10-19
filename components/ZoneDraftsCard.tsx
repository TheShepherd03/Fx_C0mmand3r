import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { DRAFT_COLOR } from '@/components/ZoneChart';

/**
 * A zone proposed by the zone refresh, awaiting the user's decision.
 * Stored at zoneDrafts/{account}/{symbolKey}/items/{id}. Only approved zones go
 * live for the EA; every decision is saved to zoneFeedback and the refresh's
 * style model retrains on them.
 */
export interface ZoneDraft {
  id: string;
  hi: number;
  lo: number;
  side?: string;     // supply / demand when drafted
  layer?: string;    // ltf / htf / yours
  score?: number;    // style-model match 0..1
  reason?: string;   // fresh | replacement | yours
  status: string;    // pending | approved | rejected
  origin?: number;
  f?: number[] | null;
  fv?: number;
}

const REASON: Record<string, string> = {
  fresh: 'New',
  replacement: 'Replaces a choppy zone',
  expired: 'Replaces an expired zone',
  yours: 'Your earlier zone',
};

/** Decimal places to show: the EA's digits when known, else what the numbers carry (max 5). */
export const draftDigits = (drafts: ZoneDraft[], known?: number) => {
  if (known && known > 0) return known;
  let d = 0;
  for (const z of drafts) {
    for (const v of [z.hi, z.lo]) {
      const s = String(v);
      const i = s.indexOf('.');
      if (i >= 0) d = Math.max(d, s.length - i - 1);
    }
  }
  return Math.min(d, 5);
};

export function ZoneDraftsCard({
  drafts,
  price,
  digits,
  selectedId,
  busy,
  onSelect,
  onDecide,
}: {
  drafts: ZoneDraft[];
  price: number | null;
  digits: number;
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onDecide: (items: ZoneDraft[], decision: 'approved' | 'rejected') => void;
}) {
  const { theme } = useTheme();
  if (drafts.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: theme.colors.card, borderColor: DRAFT_COLOR + '66' }]}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: DRAFT_COLOR }]} />
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {drafts.length} draft{drafts.length === 1 ? '' : 's'} to review
        </Text>
        {busy && <ActivityIndicator size="small" color={DRAFT_COLOR} />}
      </View>
      <Text style={[styles.sub, { color: theme.colors.textSecondary }]}>
        Shown dashed on the chart. Approve to send a zone live to the EA; each choice teaches the drafts your style.
      </Text>

      {drafts.map((z) => {
        const mid = (z.hi + z.lo) / 2;
        const demand = price != null ? price >= mid : z.side === 'demand';
        const roleColor = demand ? theme.colors.profit : theme.colors.loss;
        const dist = price != null ? Math.abs(mid - price) : null;
        const pct = price ? (dist! / price) * 100 : null;
        const sel = z.id === selectedId;
        return (
          <TouchableOpacity
            key={z.id}
            activeOpacity={0.8}
            onPress={() => onSelect(z.id)}
            style={[
              styles.row,
              { borderColor: sel ? DRAFT_COLOR : theme.colors.border, backgroundColor: sel ? DRAFT_COLOR + '14' : 'transparent' },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`${demand ? 'Demand' : 'Supply'} zone ${z.hi} to ${z.lo}. Tap to highlight on the chart.`}
          >
            <View style={styles.info}>
              <View style={styles.line1}>
                <Text style={[styles.role, { color: roleColor }]}>{demand ? 'DEMAND' : 'SUPPLY'}</Text>
                <Text style={[styles.range, { color: theme.colors.text }]} numberOfLines={1}>
                  {z.hi.toFixed(digits)} – {z.lo.toFixed(digits)}
                </Text>
              </View>
              <Text style={[styles.meta, { color: theme.colors.textSecondary }]} numberOfLines={2}>
                {[
                  REASON[z.reason ?? ''] ?? 'New',
                  dist != null ? `${dist.toFixed(digits)} away (${pct!.toFixed(2)}%)` : '',
                  z.score ? `style match ${Math.round(z.score * 100)}%` : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.colors.input }]}
              onPress={() => onDecide([z], 'rejected')}
              disabled={busy}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Reject this zone"
            >
              <IconSymbol name="xmark" size={16} color={theme.colors.error} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: theme.colors.success + '22' }]}
              onPress={() => onDecide([z], 'approved')}
              disabled={busy}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel="Approve this zone"
            >
              <IconSymbol name="checkmark" size={18} color={theme.colors.success} />
            </TouchableOpacity>
          </TouchableOpacity>
        );
      })}

      {drafts.length > 1 && (
        <View style={styles.allRow}>
          <TouchableOpacity
            style={[styles.allBtn, { borderColor: theme.colors.border }]}
            onPress={() => onDecide(drafts, 'rejected')}
            disabled={busy}
          >
            <Text style={[styles.allText, { color: theme.colors.textSecondary }]}>Reject all</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.allBtn, { backgroundColor: theme.colors.success, borderColor: theme.colors.success }]}
            onPress={() => onDecide(drafts, 'approved')}
            disabled={busy}
          >
            <Text style={[styles.allText, { color: '#FFF' }]}>Approve all</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 14,
    marginBottom: 16,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  title: {
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
  },
  sub: {
    fontSize: 12,
    lineHeight: 16,
    marginTop: 4,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 8,
  },
  info: {
    flex: 1,
  },
  line1: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  role: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  range: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  meta: {
    fontSize: 11,
    marginTop: 2,
  },
  btn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  allRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  allBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  allText: {
    fontSize: 14,
    fontWeight: '700',
  },
});
