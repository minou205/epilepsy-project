import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlarmEvent, ModelTier } from '../types/tracker';
import RatingWidget from './RatingWidget';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function isPersonalTier(tier: ModelTier): boolean {
  return tier !== 'none' && tier !== 'general';
}

function modelVersionLabel(tier: ModelTier): string {
  if (tier === 'none')    return 'No models';
  if (tier === 'general') return 'General';
  return tier.toUpperCase();
}

interface AlarmModalProps {
  alarm         : AlarmEvent | null;
  onDismiss     : () => void;
  onConfirm     : (alarmId: string, confirmed: boolean) => void;
  onRate        : (alarmId: string, rating: number) => void;
  onFalseAlarm ?: (alarmId: string) => void;
}

export default function AlarmModal({
  alarm,
  onDismiss,
  onConfirm,
  onRate,
  onFalseAlarm,
}: AlarmModalProps) {
  const insets  = useSafeAreaInsets();
  const visible = alarm !== null;

  // Countdown timer
  const [remainingMs, setRemainingMs] = useState(0);

  useEffect(() => {
    if (!alarm) return;
    const deadline = alarm.confirmationDeadline;
    const update = () => setRemainingMs(Math.max(0, deadline - Date.now()));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [alarm]);

  if (!alarm) return null;

  const isPrediction  = alarm.type === 'prediction';
  const isPersonal    = isPersonalTier(alarm.tier);
  const alreadyMarked = alarm.isFalseAlarm === true;
  const isConfirmed   = alarm.confirmed !== null;

  const accentColor = isPrediction ? '#FFCC00' : '#FF4444';
  const icon        = isPrediction ? '!' : '!!';
  const typeLabel   = isPrediction ? 'SEIZURE PREDICTED' : 'SEIZURE DETECTED';

  const remainingMin = Math.floor(remainingMs / 60000);
  const remainingSec = Math.floor((remainingMs % 60000) / 1000);
  const countdownText = `Auto-dismiss in ${remainingMin}:${remainingSec.toString().padStart(2, '0')}`;

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
        <View style={[styles.card, { borderColor: accentColor + '66' }]}>

          {/* Header */}
          <View style={[styles.iconCircle, { backgroundColor: accentColor + '22' }]}>
            <Text style={[styles.icon, { color: accentColor }]}>{icon}</Text>
          </View>

          <Text style={[styles.typeLabel, { color: accentColor }]}>{typeLabel}</Text>
          <Text style={styles.message}>{alarm.message}</Text>

          {/* Active model version */}
          <View style={styles.tierRow}>
            <Text style={styles.tierLabel}>Active Model: </Text>
            <Text style={[styles.tierValue, { color: accentColor }]}>
              {modelVersionLabel(alarm.tier)}
            </Text>
          </View>

          {/* Countdown */}
          {!isConfirmed && (
            <Text style={styles.countdown}>{countdownText}</Text>
          )}

          {/* Confirmation buttons */}
          {!isConfirmed && !alreadyMarked && (
            <View style={styles.confirmRow}>
              <TouchableOpacity
                style={styles.yesBtn}
                onPress={() => onConfirm(alarm.id, true)}
                activeOpacity={0.85}
              >
                <Text style={styles.yesBtnText}>Yes, I had a seizure</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.noBtn}
                onPress={() => onConfirm(alarm.id, false)}
                activeOpacity={0.85}
              >
                <Text style={styles.noBtnText}>No, false alarm</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Rating (only for personal models) */}
          {isPersonal && !alreadyMarked && (
            <RatingWidget
              alarmId={alarm.id}
              current={alarm.rating}
              onRate={onRate}
            />
          )}

          {/* False Alarm feedback button */}
          {isPersonal && !alreadyMarked && !isConfirmed && onFalseAlarm && (
            <TouchableOpacity
              style={styles.falseAlarmBtn}
              onPress={() => onFalseAlarm(alarm.id)}
              activeOpacity={0.8}
            >
              <Text style={styles.falseAlarmText}>Send EEG Feedback for Retraining</Text>
            </TouchableOpacity>
          )}

          {/* Confirmation that false alarm was sent */}
          {alreadyMarked && (
            <View style={styles.markedRow}>
              <Text style={styles.markedText}>
                Marked as False Alarm - EEG segment sent for retraining
              </Text>
            </View>
          )}

          {/* Dismiss */}
          <TouchableOpacity
            style={[styles.dismissBtn, { borderColor: accentColor + '55' }]}
            onPress={onDismiss}
            activeOpacity={0.8}
          >
            <Text style={[styles.dismissText, { color: accentColor }]}>
              Dismiss
            </Text>
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
    padding        : 28,
    alignItems     : 'center',
    gap            : 12,
    width          : '100%',
    maxWidth       : 400,
  },
  iconCircle: {
    width         : 72,
    height        : 72,
    borderRadius  : 36,
    justifyContent: 'center',
    alignItems    : 'center',
    marginBottom  : 4,
  },
  icon: {
    fontSize  : 36,
    fontWeight: '800',
  },
  typeLabel: {
    fontSize     : 20,
    fontWeight   : '800',
    letterSpacing: 1.5,
    textAlign    : 'center',
    fontFamily   : MONO,
  },
  message: {
    color        : '#AAB8CC',
    fontSize     : 15,
    lineHeight   : 22,
    textAlign    : 'center',
    marginVertical: 4,
  },
  tierRow: {
    flexDirection: 'row',
    alignItems   : 'center',
  },
  tierLabel: {
    color   : '#556677',
    fontSize: 13,
  },
  tierValue: {
    fontSize  : 13,
    fontWeight: '700',
  },
  countdown: {
    color     : '#556677',
    fontSize  : 12,
    fontFamily: MONO,
  },
  confirmRow: {
    width: '100%',
    gap  : 10,
  },
  yesBtn: {
    width          : '100%',
    paddingVertical: 13,
    borderRadius   : 12,
    backgroundColor: '#1A0000',
    borderWidth    : 1,
    borderColor    : '#FF000044',
    alignItems     : 'center',
  },
  yesBtnText: {
    color     : '#FF3333',
    fontSize  : 15,
    fontWeight: '700',
  },
  noBtn: {
    width          : '100%',
    paddingVertical: 13,
    borderRadius   : 12,
    backgroundColor: '#0A1828',
    borderWidth    : 1,
    borderColor    : '#1E3060',
    alignItems     : 'center',
  },
  noBtnText: {
    color     : '#4499FF',
    fontSize  : 15,
    fontWeight: '700',
  },
  falseAlarmBtn: {
    width            : '100%',
    paddingVertical  : 11,
    borderRadius     : 12,
    borderWidth      : 1,
    borderColor      : '#55443366',
    backgroundColor  : '#1A1000',
    alignItems       : 'center',
  },
  falseAlarmText: {
    color     : '#CC8833',
    fontSize  : 14,
    fontWeight: '600',
  },
  markedRow: {
    width           : '100%',
    paddingVertical : 10,
    paddingHorizontal: 12,
    borderRadius    : 10,
    backgroundColor : '#0A1A0A',
    borderWidth     : 1,
    borderColor     : '#1A4020',
    alignItems      : 'center',
  },
  markedText: {
    color     : '#44AA66',
    fontSize  : 12,
    textAlign : 'center',
    fontWeight: '600',
  },
  dismissBtn: {
    marginTop        : 4,
    width            : '100%',
    paddingVertical  : 13,
    borderRadius     : 12,
    borderWidth      : 1,
    alignItems       : 'center',
  },
  dismissText: {
    fontSize  : 15,
    fontWeight: '700',
  },
});
