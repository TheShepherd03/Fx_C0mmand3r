import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { IconSymbol } from '@/components/ui/icon-symbol';

export function LoginScreen() {
  const { signIn } = useAuth();
  const { theme } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!email || !password) { setError('Enter your email and password.'); return; }
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      // onAuthStateChanged will flip the app to the main view.
    } catch (e: any) {
      const code = e?.code || '';
      if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found'))
        setError('Incorrect email or password.');
      else if (code.includes('invalid-email')) setError('That email address looks invalid.');
      else if (code.includes('too-many-requests')) setError('Too many attempts. Try again shortly.');
      else if (code.includes('network')) setError('Network error. Check your connection.');
      else setError('Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <View style={styles.content}>
          <View style={[styles.logo, { backgroundColor: theme.colors.primary }]}>
            <IconSymbol name="bolt.fill" size={32} color="#fff" />
          </View>
          <Text style={[styles.title, { color: theme.colors.text }]}>Command0r</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>Sign in to your account</Text>

          <View style={styles.form}>
            <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Email</Text>
            <TextInput
              style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.text, borderColor: theme.colors.border }]}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={theme.colors.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              editable={!busy}
            />

            <Text style={[styles.label, { color: theme.colors.textSecondary, marginTop: 16 }]}>Password</Text>
            <TextInput
              style={[styles.input, { backgroundColor: theme.colors.card, color: theme.colors.text, borderColor: theme.colors.border }]}
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              placeholderTextColor={theme.colors.textTertiary}
              secureTextEntry
              autoCapitalize="none"
              editable={!busy}
              onSubmitEditing={onSubmit}
              returnKeyType="go"
            />

            {error && <Text style={[styles.error, { color: theme.colors.error }]}>{error}</Text>}

            <TouchableOpacity
              style={[styles.button, { backgroundColor: theme.colors.primary, opacity: busy ? 0.7 : 1 }]}
              onPress={onSubmit}
              disabled={busy}
            >
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign In</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  logo: { width: 64, height: 64, borderRadius: 18, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 16 },
  title: { fontSize: 28, fontWeight: '800', textAlign: 'center' },
  subtitle: { fontSize: 15, textAlign: 'center', marginTop: 4, marginBottom: 32 },
  form: {},
  label: { fontSize: 13, fontWeight: '600', marginBottom: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 14, fontSize: 16 },
  error: { fontSize: 14, marginTop: 14, textAlign: 'center', fontWeight: '600' },
  button: { marginTop: 24, paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
