import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

interface SatisfactionModalProps {
  visible       : boolean;
  seizureCount  : number;
  onSatisfied   : () => void;   // "Yes" -> stop collection
  onNotSatisfied: () => void;   // "No" -> continue
}

export default function SatisfactionModal({
  visible,
  seizureCount,
  onSatisfied,
  onNotSatisfied,
}: SatisfactionModalProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={[
        styles.overlay,
        { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 },
      ]}>
        <View style={styles.card}>

          <View style={styles.iconCircle}>
            <Text style={styles.icon}>?</Text>
          </View>

          <Text style={styles.title}>Training Check</Text>

          <Text style={styles.body}>
            You've reported {seizureCount} seizures. Are you satisfied with
            the prediction accuracy?
          </Text>

          <Text style={styles.hint}>
            Choosing "Yes" will stop data collection and training.
            You can re-enable it in Settings at any time.
          </Text>

          <TouchableOpacity
            style={styles.satisfiedBtn}
            onPress={onSatisfied}
            activeOpacity={0.85}
          >
            <Text style={styles.satisfiedText}>Yes, I'm satisfied</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.continueBtn}
            onPress={onNotSatisfied}
            activeOpacity={0.85}
          >
            <Text style={styles.continueText}>No, keep improving</Text>
          </TouchableOpacity>

        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex             : 1,
    backgroundColor  : 'rgba(0,0,0,0.88)',
    justifyContent   : 'center',
    alignItems       : 'center',
    paddingHorizontal: 24,
  },
  card: {
    backgroundColor: '#0D1220',
    borderRadius   : 20,
    borderWidth    : 1,
    borderColor    : '#1E3060',
    padding        : 28,
    alignItems     : 'center',
    gap            : 14,
    width          : '100%',
    maxWidth       : 400,
  },
  iconCircle: {
    width          : 64,
    height         : 64,
    borderRadius   : 32,
    backgroundColor: '#4499FF22',
    justifyContent : 'center',
    alignItems     : 'center',
  },
  icon: {
    fontSize  : 32,
    color     : '#4499FF',
    fontWeight: '800',
  },
  title: {
    color        : '#E8F0FF',
    fontSize     : 20,
    fontWeight   : '700',
    fontFamily   : MONO,
    letterSpacing: 0.5,
  },
  body: {
    color     : '#AAB8CC',
    fontSize  : 15,
    lineHeight: 22,
    textAlign : 'center',
  },
  hint: {
    color     : '#445566',
    fontSize  : 12,
    lineHeight: 18,
    textAlign : 'center',
  },
  satisfiedBtn: {
    width          : '100%',
    paddingVertical: 14,
    borderRadius   : 12,
    backgroundColor: '#003322',
    borderWidth    : 1,
    borderColor    : '#00FF8840',
    alignItems     : 'center',
  },
  satisfiedText: {
    color     : '#00FF88',
    fontSize  : 16,
    fontWeight: '700',
  },
  continueBtn: {
    width          : '100%',
    paddingVertical: 14,
    borderRadius   : 12,
    backgroundColor: '#0A1828',
    borderWidth    : 1,
    borderColor    : '#1E3060',
    alignItems     : 'center',
  },
  continueText: {
    color     : '#4499FF',
    fontSize  : 16,
    fontWeight: '700',
  },
});
