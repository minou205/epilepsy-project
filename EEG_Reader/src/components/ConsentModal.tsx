import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface ConsentModalProps {
  visible  : boolean;
  onAccept : () => void;
  onDecline: () => void;
}

export default function ConsentModal({ visible, onAccept, onDecline }: ConsentModalProps) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={[styles.card, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={styles.title}>Data Sharing Consent</Text>

          <ScrollView
            style={styles.scroll}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.body}>
              To improve epilepsy detection and prediction for all patients, we would like to use
              your anonymised EEG data (including recorded seizures and normal brain activity) to
              train and improve our AI models.
            </Text>
            <Text style={styles.body}>
              Your data will be:
            </Text>
            <Text style={styles.bullet}>• Stored securely on our servers</Text>
            <Text style={styles.bullet}>• Used only for medical AI research</Text>
            <Text style={styles.bullet}>• Never sold or shared with third parties</Text>
            <Text style={styles.bullet}>• Associated only with your anonymous patient ID</Text>
            <Text style={styles.body}>
              You can change this decision at any time in Settings.
            </Text>
          </ScrollView>

          <View style={styles.btnRow}>
            <TouchableOpacity
              style={[styles.btn, styles.btnDecline]}
              onPress={onDecline}
              activeOpacity={0.8}
            >
              <Text style={styles.btnDeclineText}>Decline</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, styles.btnAccept]}
              onPress={onAccept}
              activeOpacity={0.8}
            >
              <Text style={styles.btnAcceptText}>I Accept</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex           : 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent : 'flex-end',
  },
  card: {
    backgroundColor: '#0D1220',
    borderTopLeftRadius : 20,
    borderTopRightRadius: 20,
    borderTopWidth  : 1,
    borderTopColor  : '#1E2E40',
    padding         : 24,
    maxHeight       : '80%',
  },
  title: {
    color        : '#E8F0FF',
    fontSize     : 19,
    fontWeight   : '700',
    marginBottom : 16,
    letterSpacing: 0.3,
  },
  scroll: {
    maxHeight: 260,
  },
  body: {
    color     : '#8899AA',
    fontSize  : 14,
    lineHeight: 22,
    marginBottom: 10,
  },
  bullet: {
    color     : '#8899AA',
    fontSize  : 14,
    lineHeight: 22,
    marginLeft: 8,
    marginBottom: 4,
  },
  btnRow: {
    flexDirection: 'row',
    gap          : 12,
    marginTop    : 20,
  },
  btn: {
    flex           : 1,
    paddingVertical: 13,
    borderRadius   : 12,
    alignItems     : 'center',
  },
  btnDecline: {
    borderWidth : 1,
    borderColor : '#FF664444',
    backgroundColor: '#FF664412',
  },
  btnDeclineText: {
    color     : '#FF6644',
    fontSize  : 15,
    fontWeight: '600',
  },
  btnAccept: {
    backgroundColor: '#00FF88',
  },
  btnAcceptText: {
    color     : '#090915',
    fontSize  : 15,
    fontWeight: '700',
  },
});
