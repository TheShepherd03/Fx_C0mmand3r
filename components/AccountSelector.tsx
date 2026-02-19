import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { Picker } from '@react-native-picker/picker';
import { useAccount } from '@/contexts/AccountContext';
import { useTheme } from '@/contexts/ThemeContext';

export function AccountSelector() {
  const { selectedAccount, availableAccounts, setSelectedAccount, removeAccount, loading } = useAccount();
  const { theme } = useTheme();

  const handleRemoveAccount = (accountId: string) => {
    const displayName = accountId.replace(/_/g, ' ');
    Alert.alert(
      "Remove Account",
      `Are you sure you want to remove "${displayName}"? This will delete all data for this account and cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              await removeAccount(accountId);
              Alert.alert("Success", "Account removed successfully");
            } catch {
              Alert.alert("Error", "Failed to remove account. Please try again.");
            }
          }
        }
      ]
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Loading accounts...</Text>
      </View>
    );
  }

  if (availableAccounts.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
        <Text style={[styles.label, { color: theme.colors.text }]}>No EA connections found</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>Start an EA on MT5 to see accounts here</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
      <View style={styles.row}>
        <View style={[styles.pickerContainer, { backgroundColor: theme.colors.input }]}>
          <Picker
            selectedValue={selectedAccount || undefined}
            style={[styles.picker, { color: theme.colors.text }]}
            dropdownIconColor={theme.colors.textSecondary}
            onValueChange={(itemValue: string) => setSelectedAccount(itemValue)}
          >
            {availableAccounts.map((account) => (
              <Picker.Item
                key={account}
                label={account.replace(/_/g, ' ')}
                value={account}
                color={theme.colors.text}
                style={{ backgroundColor: theme.colors.card }}
              />
            ))}
          </Picker>
        </View>
        {selectedAccount && (
          <TouchableOpacity
            style={[styles.deleteButton, { backgroundColor: theme.colors.input }]}
            onPress={() => handleRemoveAccount(selectedAccount)}
          >
            <Text style={[styles.deleteButtonText, { color: theme.colors.error }]}>🗑️</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
    borderRadius: 12,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  pickerContainer: {
    flex: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  picker: {
    height: 50,
  },
  deleteButton: {
    borderRadius: 8,
    width: 50,
    height: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  deleteButtonText: {
    fontSize: 20,
  },
});
