import React, { useState } from 'react';
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
            } catch (error) {
              Alert.alert("Error", "Failed to remove account. Please try again.");
            }
          }
        }
      ]
    );
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <Text style={styles.label}>Loading accounts...</Text>
      </View>
    );
  }

  if (availableAccounts.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.card }]}>
        <Text style={[styles.label, { color: theme.colors.text }]}>No EA connections found</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>Start an EA on MT5 to see accounts here</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.card }]}>
      <Text style={[styles.label, { color: theme.colors.text }]}>Trading Account:</Text>
      <View style={styles.row}>
        <View style={styles.pickerContainer}>
          <Picker
            selectedValue={selectedAccount || undefined}
            style={styles.picker}
            onValueChange={(itemValue: string) => setSelectedAccount(itemValue)}
          >
            {availableAccounts.map((account) => (
              <Picker.Item
                key={account}
                label={account.replace(/_/g, ' ')}
                value={account}
              />
            ))}
          </Picker>
        </View>
        {selectedAccount && (
          <TouchableOpacity
            style={styles.deleteButton}
            onPress={() => handleRemoveAccount(selectedAccount)}
          >
            <Text style={styles.deleteButtonText}>🗑️</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
    marginBottom: 16,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#666',
    textAlign: 'center',
    marginTop: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pickerContainer: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  picker: {
    height: 50,
  },
  deleteButton: {
    backgroundColor: '#ff4757',
    borderRadius: 6,
    padding: 12,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 44,
    minHeight: 44,
  },
  deleteButtonText: {
    fontSize: 18,
  },
});
