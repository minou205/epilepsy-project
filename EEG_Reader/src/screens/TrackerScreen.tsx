import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { EEGSession }        from '../hooks/useEEGSession';
import { TrackerSessionAPI } from '../hooks/useTrackerSession';
import { useAuth }           from '../services/AuthContext';

import MultiChannelChart  from '../components/MultiChannelChart';
import ProbabilityChart   from '../components/ProbabilityChart';
import BottomTabBar        from '../components/BottomTabBar';
import AlarmModal          from '../components/AlarmModal';
import SatisfactionModal   from '../components/SatisfactionModal';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

const STATUS_COLOR: Record<string, string> = {
  connected   : '#00FF88',
  connecting  : '#FFCC00',
  disconnected: '#556677',
  error       : '#FF6644',
};

function getTierColor(tier: string): string {
  if (tier === 'none')    return '#556677';
  if (tier === 'general') return '#FFCC00';
  return '#4499FF';
}

interface TrackerScreenProps {
  session: EEGSession;
  tracker: TrackerSessionAPI;
}

export default function TrackerScreen({ session, tracker }: TrackerScreenProps) {

  const { user, profile, updateProfile } = useAuth();

  const [showGraphSettings, setShowGraphSettings] = useState(false);

  const isConnected = session.status === 'connected';
  const hasModels   = tracker.currentTier !== 'none';
  const showCharts  = hasModels && (tracker.predictorHistory.length > 0 || tracker.detectorHistory.length > 0);
  const canCollect  = (profile?.consent_to_train ?? true) && profile?.role === 'patient';
  const role        = profile?.role ?? 'patient';
  const isTracking  = tracker.status === 'running' || tracker.status === 'alarm_predict' || tracker.status === 'alarm_detect';

  const hasLiveSignal = (() => {
    if (!isConnected || session.displayData.length === 0) return false;
    const TAIL = 32;
    for (const ch of session.displayData) {
      const s   = ch.data;
      const len = s.length;
      if (len === 0) continue;
      const start = Math.max(0, len - TAIL);
      for (let i = start; i < len; i++) {
        if (s[i] !== 0) return true;
      }
    }
    return false;
  })();

  const canStart    = isConnected && hasLiveSignal && !isTracking && tracker.status !== 'collecting_normal';

  useEffect(() => {
    if (isTracking) {
      activateKeepAwakeAsync('tracker').catch(() => {});
    } else {
      deactivateKeepAwake('tracker');
    }
    return () => { deactivateKeepAwake('tracker'); };
  }, [isTracking]);

  let bannerColor = '#334455';
  let bannerBg    = '#0A1020';
  let bannerText  = tracker.statusMessage;

  if (tracker.status === 'signal_lost') {
    bannerColor = '#FF4444'; bannerBg = '#1A0808';
    bannerText = 'Signal lost - please check your headset';
  } else if (isConnected && !isTracking && !hasLiveSignal) {
    bannerColor = '#FF6644'; bannerBg = '#1A0E08';
    bannerText = 'Headset is off - turn it on to start tracking';
  } else if (tracker.status === 'alarm_predict') {
    bannerColor = '#FFCC00'; bannerBg = '#1A1400';
  } else if (tracker.status === 'alarm_detect') {
    bannerColor = '#FF4444'; bannerBg = '#1A0808';
  } else if (tracker.status === 'running') {
    bannerColor = '#00FF88'; bannerBg = '#041210';
  } else if (tracker.status === 'collecting_normal') {
    bannerColor = '#4499FF'; bannerBg = '#0A1428';
  } else if (tracker.status === 'ready') {
    bannerColor = '#4499FF'; bannerBg = '#0A1428';
  } else if (tracker.status === 'stopped') {
    bannerColor = '#FFCC00'; bannerBg = '#1A1400';
  }

  const SEIZURE_NEEDED_SECS = 21 * 60;
  const bufMins  = Math.floor(session.longBufferReadySecs / 60);
  const bufSecs  = session.longBufferReadySecs % 60;
  const bufReady = session.longBufferReadySecs >= SEIZURE_NEEDED_SECS;
  const bufLabel = bufReady
    ? `Buffer ready - ${bufMins}m of rolling data`
    : `Buffer: ${bufMins}m ${bufSecs}s / 21m 0s (filling...)`;

  const handleSatisfied = async () => {
    tracker.onSatisfactionAnswer(true);
    await updateProfile({ train_next_version: false });
  };
  const handleNotSatisfied = () => {
    tracker.onSatisfactionAnswer(false);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ExpoStatusBar style="light" />

      <View style={styles.topBar}>
        <View style={styles.topLeft}>
          <View style={[
            styles.statusDot,
            { backgroundColor: STATUS_COLOR[session.status] ?? '#556677' },
          ]} />
          <Text style={styles.statusLabel} numberOfLines={1}>
            {session.status === 'connected'
              ? `${session.config?.channels.length ?? 0} ch  ·  ${session.config?.samplingRate ?? 256} Hz`
              : session.statusMessage}
          </Text>
        </View>
        <View style={styles.topRight}>
          <View style={[styles.tierBadge, { borderColor: getTierColor(tracker.currentTier) + '55' }]}>
            <Text style={[styles.tierText, { color: getTierColor(tracker.currentTier) }]}>
              {tracker.currentModelVersion}
            </Text>
          </View>
          <TouchableOpacity
            style={styles.iconBtn}
            onPress={() => setShowGraphSettings(true)}
          >
            <Text style={styles.iconBtnText}>G</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={[styles.banner, { backgroundColor: bannerBg }]}>
        <Text style={[styles.bannerText, { color: bannerColor }]} numberOfLines={2}>
          {bannerText}
        </Text>
      </View>

      {tracker.pendingAcceptance && (
        <View style={styles.acceptBanner}>
          <View style={styles.acceptTextBlock}>
            <Text style={styles.acceptTitle}>
              New {tracker.pendingTier?.toUpperCase() ?? ''} model ready
            </Text>
            <Text style={styles.acceptSubText}>
              Training complete — accept to activate your personal model
            </Text>
          </View>
          <TouchableOpacity
            style={styles.acceptBtn}
            onPress={tracker.acceptNewModel}
            activeOpacity={0.85}
          >
            <Text style={styles.acceptBtnText}>Accept</Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView
        style={styles.mainScroll}
        contentContainerStyle={styles.mainContent}
        showsVerticalScrollIndicator={false}
      >
        {showCharts && tracker.predictorHistory.length > 0 && (
          <ProbabilityChart
            title="Prediction"
            data={tracker.predictorHistory}
            threshold={tracker.predictorThreshold}
            color="#FFCC00"
          />
        )}
        {showCharts && tracker.detectorHistory.length > 0 && (
          <ProbabilityChart
            title="Detection"
            data={tracker.detectorHistory}
            threshold={tracker.detectorThreshold}
            color="#FF4444"
          />
        )}

        {!showCharts && session.graphEnabled && (
          <MultiChannelChart
            channels={session.displayData}
            isConnected={isConnected}
            graphEnabled={session.graphEnabled}
          />
        )}

        {!showCharts && !session.graphEnabled && (
          <View style={styles.hpmContainer}>
            <Text style={styles.hpmTitle}>High-Performance Mode Active</Text>
            <Text style={styles.hpmSubText}>Graph rendering is disabled</Text>
            <TouchableOpacity
              style={styles.hpmEnableBtn}
              onPress={() => session.setGraphEnabled(true)}
            >
              <Text style={styles.hpmEnableBtnText}>Enable Graph</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <View style={styles.bufRow}>
        <Text style={[styles.bufText, bufReady && { color: '#00FF88' }]}>
          {bufLabel}
        </Text>
      </View>

      <View style={styles.startStopRow}>
        {isTracking ? (
          <TouchableOpacity
            style={styles.stopBtn}
            onPress={tracker.stop}
            activeOpacity={0.85}
          >
            <View style={styles.stopIcon} />
            <Text style={styles.stopBtnText}>STOP</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.startBtn, !canStart && styles.btnDisabled]}
            onPress={tracker.start}
            disabled={!canStart}
            activeOpacity={0.85}
          >
            <View style={styles.playIcon} />
            <Text style={styles.startBtnText}>START</Text>
          </TouchableOpacity>
        )}
      </View>

      {canCollect && isTracking && (
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={styles.seizureBtn}
            onPress={tracker.reportSeizure}
            activeOpacity={0.85}
          >
            <Text style={styles.seizureBtnText}>I had a seizure</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.normalBtn,
              tracker.collectingNormal && styles.btnDisabled,
            ]}
            onPress={tracker.collectNormalData}
            disabled={tracker.collectingNormal}
            activeOpacity={0.85}
          >
            <Text style={styles.normalBtnText}>
              {tracker.collectingNormal ? 'Collecting...' : 'Collect Normal Data'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <BottomTabBar activeTab="tracker" role={role} isTracking={isTracking} />

      <AlarmModal
        alarm={tracker.activeAlarm}
        onDismiss={tracker.dismissAlarm}
        onConfirm={tracker.confirmAlarm}
        onFalseAlarm={tracker.markFalseAlarm}
      />

      <SatisfactionModal
        visible={tracker.showSatisfaction}
        seizureCount={tracker.satisfactionCount}
        onSatisfied={handleSatisfied}
        onNotSatisfied={handleNotSatisfied}
      />

      <Modal
        visible={tracker.headsetMismatch !== null}
        transparent
        animationType="fade"
        onRequestClose={tracker.clearHeadsetMismatch}
      >
        <View style={hm.overlay}>
          <View style={hm.card}>
            <Text style={hm.title}>Headset Mismatch</Text>
            <Text style={hm.body}>
              The EEG channels in this recording don't match your registered headset.
              {'\n\n'}
              Did you change your headset?
            </Text>

            {tracker.headsetMismatch && (
              <View style={hm.detailBlock}>
                <Text style={hm.detailLabel}>Registered ({tracker.headsetMismatch.expected.length} ch):</Text>
                <Text style={hm.detailText} numberOfLines={3}>
                  {tracker.headsetMismatch.expected.join(', ') || '—'}
                </Text>
                <Text style={hm.detailLabel}>This recording ({tracker.headsetMismatch.got.length} ch):</Text>
                <Text style={hm.detailText} numberOfLines={3}>
                  {tracker.headsetMismatch.got.join(', ') || '—'}
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={hm.dangerBtn}
              onPress={tracker.confirmHeadsetReset}
              activeOpacity={0.85}
            >
              <Text style={hm.dangerBtnText}>
                Yes — wipe my old data and start fresh
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={hm.safeBtn}
              onPress={tracker.clearHeadsetMismatch}
              activeOpacity={0.85}
            >
              <Text style={hm.safeBtnText}>
                No — I'll use my original headset
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showGraphSettings}
        transparent
        animationType="slide"
        onRequestClose={() => setShowGraphSettings(false)}
      >
        <View style={gs.overlay}>
          <View style={gs.card}>
            <View style={gs.header}>
              <Text style={gs.title}>Graph Settings</Text>
              <TouchableOpacity
                style={gs.closeBtn}
                onPress={() => setShowGraphSettings(false)}
              >
                <Text style={gs.closeBtnText}>X</Text>
              </TouchableOpacity>
            </View>

            <View style={gs.section}>
              <View style={gs.toggleRow}>
                <View>
                  <Text style={gs.toggleLabel}>Real-time Graph</Text>
                  <Text style={gs.toggleHint}>
                    {session.graphEnabled
                      ? 'Rendering active - uses GPU'
                      : 'Disabled - AI inference still runs'}
                  </Text>
                </View>
                <TouchableOpacity
                  style={[gs.pill, session.graphEnabled ? gs.pillOn : gs.pillOff]}
                  onPress={() => session.setGraphEnabled(!session.graphEnabled)}
                  activeOpacity={0.8}
                >
                  <Text style={[gs.pillText, session.graphEnabled ? gs.pillTextOn : gs.pillTextOff]}>
                    {session.graphEnabled ? 'ON' : 'OFF'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {session.graphEnabled && (
              <>
                <View style={gs.sectionHeader}>
                  <Text style={gs.sectionTitle}>Channels to Display</Text>
                  <View style={gs.sectionBtns}>
                    <TouchableOpacity style={gs.smallBtn} onPress={session.setAllGraphChannels}>
                      <Text style={gs.smallBtnText}>All</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={gs.smallBtn} onPress={session.clearGraphChannels}>
                      <Text style={gs.smallBtnText}>None</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <ScrollView style={gs.chList} showsVerticalScrollIndicator={false}>
                  {(session.selectedChannels.length > 0
                    ? session.selectedChannels
                    : session.config?.channels ?? []
                  ).map(ch => {
                    const checked = session.graphChannels.includes(ch);
                    return (
                      <TouchableOpacity
                        key={ch}
                        style={gs.chRow}
                        onPress={() => session.toggleGraphChannel(ch)}
                        activeOpacity={0.7}
                      >
                        <View style={[gs.checkbox, checked && gs.checkboxChecked]}>
                          {checked && <Text style={gs.checkmark}>v</Text>}
                        </View>
                        <Text style={[gs.chLabel, checked && gs.chLabelChecked]}>{ch}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </>
            )}
          </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090915' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#0D1828',
  },
  topLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusLabel: { color: '#556677', fontSize: 12, fontFamily: MONO, flex: 1 },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tierBadge: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  tierText: { fontSize: 10, fontWeight: '700', fontFamily: MONO, letterSpacing: 0.5 },
  iconBtn: { padding: 7, borderRadius: 8, backgroundColor: '#0D1828' },
  iconBtnText: { color: '#AAB8CC', fontSize: 15 },
  banner: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: '#0A1020',
    minHeight: 38, justifyContent: 'center',
  },
  bannerText: { fontSize: 13, fontFamily: MONO, fontWeight: '600', lineHeight: 18 },
  mainScroll: { flex: 1 },
  mainContent: { paddingVertical: 4 },
  hpmContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 24, paddingVertical: 40, gap: 10,
  },
  hpmTitle: { color: '#FFCC00', fontSize: 18, fontWeight: '700', fontFamily: MONO, textAlign: 'center' },
  hpmSubText: { color: '#445566', fontSize: 13, fontFamily: MONO, textAlign: 'center' },
  hpmEnableBtn: {
    marginTop: 16, paddingVertical: 10, paddingHorizontal: 28,
    borderRadius: 10, borderWidth: 1, borderColor: '#1A4066', backgroundColor: '#0A1828',
  },
  hpmEnableBtnText: { color: '#4499FF', fontSize: 14, fontWeight: '700', fontFamily: MONO },
  bufRow: { paddingHorizontal: 14, paddingVertical: 5, borderTopWidth: 1, borderTopColor: '#0A1020' },
  bufText: { color: '#2A3A50', fontSize: 10, fontFamily: MONO },
  startStopRow: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4 },
  startBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 16, borderRadius: 14,
    backgroundColor: '#002A11', borderWidth: 1.5, borderColor: '#00FF6644',
  },
  startBtnText: {
    color: '#00FF88', fontSize: 18, fontWeight: '800', fontFamily: MONO,
    letterSpacing: 2,
  },
  playIcon: {
    width: 0, height: 0, backgroundColor: 'transparent',
    borderStyle: 'solid', borderLeftWidth: 12, borderTopWidth: 7, borderBottomWidth: 7,
    borderLeftColor: '#00FF88', borderTopColor: 'transparent', borderBottomColor: 'transparent',
  },
  stopBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 16, borderRadius: 14,
    backgroundColor: '#2A0000', borderWidth: 1.5, borderColor: '#FF444444',
  },
  stopBtnText: {
    color: '#FF4444', fontSize: 18, fontWeight: '800', fontFamily: MONO,
    letterSpacing: 2,
  },
  stopIcon: {
    width: 14, height: 14, backgroundColor: '#FF4444', borderRadius: 2,
  },
  actionRow: { paddingHorizontal: 14, paddingVertical: 8, gap: 8 },
  seizureBtn: {
    paddingVertical: 13, borderRadius: 12, alignItems: 'center',
    backgroundColor: '#1A0000', borderWidth: 1, borderColor: '#FF000044',
  },
  seizureBtnText: { color: '#FF3333', fontSize: 15, fontWeight: '700', letterSpacing: 0.5 },
  normalBtn: {
    paddingVertical: 13, borderRadius: 12, alignItems: 'center',
    backgroundColor: '#0A1828', borderWidth: 1, borderColor: '#1E3060',
  },
  normalBtnText: { color: '#4499FF', fontSize: 15, fontWeight: '700', letterSpacing: 0.5 },
  btnDisabled: { opacity: 0.35 },
  acceptBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
    backgroundColor: '#0A1828', borderBottomWidth: 1, borderBottomColor: '#1A3060',
  },
  acceptTextBlock: { flex: 1, marginRight: 12 },
  acceptTitle: {
    color: '#4499FF', fontSize: 13, fontWeight: '700', fontFamily: MONO,
  },
  acceptSubText: {
    color: '#556677', fontSize: 11, fontFamily: MONO, marginTop: 2,
  },
  acceptBtn: {
    paddingVertical: 8, paddingHorizontal: 18, borderRadius: 8,
    backgroundColor: '#1A3060', borderWidth: 1, borderColor: '#4499FF55',
  },
  acceptBtnText: {
    color: '#4499FF', fontSize: 13, fontWeight: '700', fontFamily: MONO,
  },
});

const gs = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: '#000000BB', justifyContent: 'flex-end' },
  card: {
    backgroundColor: '#0D0D22', borderTopLeftRadius: 18, borderTopRightRadius: 18,
    borderTopWidth: 1, borderColor: '#1A2040', paddingBottom: 32, maxHeight: '80%',
  },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1A2040',
  },
  title: { color: '#CCDDEE', fontSize: 16, fontWeight: '700', fontFamily: MONO },
  closeBtn: { padding: 6, borderRadius: 8, backgroundColor: '#161630' },
  closeBtnText: { color: '#8899BB', fontSize: 14 },
  section: { paddingHorizontal: 18, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#0D1828' },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleLabel: { color: '#CCDDEE', fontSize: 14, fontWeight: '600', fontFamily: MONO },
  toggleHint: { color: '#445566', fontSize: 11, fontFamily: MONO, marginTop: 2 },
  pill: { paddingVertical: 6, paddingHorizontal: 18, borderRadius: 20, borderWidth: 1 },
  pillOn: { backgroundColor: '#003322', borderColor: '#00FF8860' },
  pillOff: { backgroundColor: '#1A1A0A', borderColor: '#44440A60' },
  pillText: { fontSize: 13, fontWeight: '700', fontFamily: MONO },
  pillTextOn: { color: '#00FF88' },
  pillTextOff: { color: '#888844' },
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 4,
  },
  sectionTitle: {
    color: '#8899BB', fontSize: 11, fontWeight: '700', fontFamily: MONO,
    textTransform: 'uppercase', letterSpacing: 0.8,
  },
  sectionBtns: { flexDirection: 'row', gap: 8 },
  smallBtn: {
    paddingVertical: 4, paddingHorizontal: 12, borderRadius: 6,
    borderWidth: 1, borderColor: '#2A3060', backgroundColor: '#161630',
  },
  smallBtnText: { color: '#8899BB', fontSize: 11, fontFamily: MONO },
  chList: { maxHeight: 260, paddingHorizontal: 18 },
  chRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 9,
    borderBottomWidth: 1, borderBottomColor: '#0D1020', gap: 12,
  },
  checkbox: {
    width: 20, height: 20, borderRadius: 5, borderWidth: 1,
    borderColor: '#2A3060', backgroundColor: '#0A0A18', alignItems: 'center', justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#0A2A15', borderColor: '#00FF8870' },
  checkmark: { color: '#00FF88', fontSize: 13, fontWeight: '700' },
  chLabel: { color: '#445566', fontSize: 13, fontFamily: MONO },
  chLabelChecked: { color: '#AABBCC' },
});

const hm = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: '#000000DD',
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 22,
  },
  card: {
    width: '100%', maxWidth: 420, backgroundColor: '#0D0D22',
    borderRadius: 16, borderWidth: 1, borderColor: '#3A1A1A',
    paddingHorizontal: 20, paddingVertical: 22, gap: 14,
  },
  title: {
    color: '#FF6644', fontSize: 18, fontWeight: '800',
    fontFamily: MONO, textAlign: 'center',
  },
  body: {
    color: '#CCDDEE', fontSize: 14, lineHeight: 20,
    textAlign: 'center', fontFamily: MONO,
  },
  detailBlock: {
    backgroundColor: '#0A0A18', borderRadius: 10, borderWidth: 1,
    borderColor: '#1A2040', paddingHorizontal: 12, paddingVertical: 10, gap: 4,
  },
  detailLabel: {
    color: '#8899BB', fontSize: 11, fontWeight: '700',
    fontFamily: MONO, textTransform: 'uppercase', letterSpacing: 0.6,
    marginTop: 4,
  },
  detailText: {
    color: '#AABBCC', fontSize: 11, fontFamily: MONO, lineHeight: 16,
  },
  dangerBtn: {
    paddingVertical: 13, borderRadius: 12, alignItems: 'center',
    backgroundColor: '#1A0000', borderWidth: 1, borderColor: '#FF000055',
  },
  dangerBtnText: {
    color: '#FF4444', fontSize: 14, fontWeight: '700',
    fontFamily: MONO, letterSpacing: 0.3,
  },
  safeBtn: {
    paddingVertical: 13, borderRadius: 12, alignItems: 'center',
    backgroundColor: '#0A1828', borderWidth: 1, borderColor: '#1E3060',
  },
  safeBtnText: {
    color: '#4499FF', fontSize: 14, fontWeight: '700',
    fontFamily: MONO, letterSpacing: 0.3,
  },
});
