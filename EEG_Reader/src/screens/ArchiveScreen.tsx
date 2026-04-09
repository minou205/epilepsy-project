import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  Platform,
  RefreshControl,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';

import { useAuth }        from '../services/AuthContext';
import { useAppSettings } from '../hooks/useAppSettings';
import BottomTabBar        from '../components/BottomTabBar';
import ProbabilityChart    from '../components/ProbabilityChart';
import { loadArchive, getArchiveStats, ArchivedAlarm, ArchiveStats } from '../services/ArchiveStorage';
import { fetchHelperPatients } from '../services/CommunityService';
import { UserProfile } from '../services/supabaseClient';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

type PatientChip = Pick<UserProfile, 'id' | 'full_name' | 'username' | 'avatar_url' | 'role'>;

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function ArchiveScreen() {
  const { profile, user } = useAuth();
  const { settings } = useAppSettings();
  const role = profile?.role ?? 'patient';

  const [events,     setEvents    ] = useState<ArchivedAlarm[]>([]);
  const [stats,      setStats     ] = useState<ArchiveStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded,   setExpanded  ] = useState<string | null>(null);

  // Helper patient picker
  const [patients,       setPatients      ] = useState<PatientChip[]>([]);
  const [selectedPatient, setSelectedPatient] = useState<string | null>(null);

  const isHelper = role === 'helper';

  // Load helper's patients
  useEffect(() => {
    if (!isHelper || !user?.id) return;
    fetchHelperPatients(user.id)
      .then(data => {
        setPatients(data);
        if (data.length > 0 && !selectedPatient) {
          setSelectedPatient(data[0].id);
        }
      })
      .catch(err => console.error('[Archive] Failed to load patients:', err));
  }, [isHelper, user?.id]);

  // Determine which patient's archive to show
  const patientId = isHelper ? (selectedPatient ?? '') : settings.patientId;

  const load = useCallback(async () => {
    if (!patientId) return;
    try {
      const [archive, archiveStats] = await Promise.all([
        loadArchive(patientId),
        getArchiveStats(patientId),
      ]);
      setEvents(archive);
      setStats(archiveStats);
    } catch (err) {
      console.error('[Archive] Load failed:', err);
    }
  }, [patientId]);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const renderEvent = ({ item }: { item: ArchivedAlarm }) => {
    const isExpanded    = expanded === item.id;
    const isPrediction  = item.type === 'prediction';
    const accentColor   = isPrediction ? '#FFCC00' : '#FF4444';
    const confirmedText = item.confirmed === true ? 'Confirmed' : item.confirmed === false ? 'Not confirmed' : 'Pending';
    const confirmedColor = item.confirmed === true ? '#FF4444' : item.confirmed === false ? '#00FF88' : '#556677';

    return (
      <TouchableOpacity
        style={styles.eventCard}
        onPress={() => setExpanded(isExpanded ? null : item.id)}
        activeOpacity={0.8}
      >
        {/* Header row */}
        <View style={styles.eventHeader}>
          <View style={[styles.typeBadge, { backgroundColor: accentColor + '22', borderColor: accentColor + '55' }]}>
            <Text style={[styles.typeBadgeText, { color: accentColor }]}>
              {isPrediction ? 'PREDICT' : 'DETECT'}
            </Text>
          </View>
          <Text style={styles.eventDate}>{formatDate(item.timestamp)}</Text>
        </View>

        {/* Details */}
        <View style={styles.eventDetails}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Tier</Text>
            <Text style={styles.detailValue}>{item.tier}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Result</Text>
            <Text style={[styles.detailValue, { color: confirmedColor }]}>{confirmedText}</Text>
          </View>
        </View>

        {/* Expanded: probability trace chart */}
        {isExpanded && item.probabilityTrace && item.probabilityTrace.predictorProbs.length > 0 && (
          <View style={styles.expandedChart}>
            <ProbabilityChart
              title="Predictor Trace"
              data={item.probabilityTrace.predictorProbs}
              threshold={0.5}
              color="#FFCC00"
              height={80}
              maxPoints={item.probabilityTrace.predictorProbs.length}
            />
            {item.probabilityTrace.detectorProbs.length > 0 && (
              <ProbabilityChart
                title="Detector Trace"
                data={item.probabilityTrace.detectorProbs}
                threshold={0.5}
                color="#FF4444"
                height={80}
                maxPoints={item.probabilityTrace.detectorProbs.length}
              />
            )}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ExpoStatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Archive</Text>
      </View>

      {/* Helper patient picker */}
      {isHelper && patients.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.patientPicker}
        >
          {patients.map(p => {
            const isSelected = p.id === selectedPatient;
            return (
              <TouchableOpacity
                key={p.id}
                style={[styles.patientChip, isSelected && styles.patientChipSelected]}
                onPress={() => setSelectedPatient(p.id)}
                activeOpacity={0.7}
              >
                <Text style={[styles.patientChipText, isSelected && styles.patientChipTextSelected]}>
                  {p.full_name || p.username}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {isHelper && patients.length === 0 && (
        <View style={styles.noPatients}>
          <Text style={styles.noPatientsText}>No patients associated with your account.</Text>
        </View>
      )}

      {/* Stats row */}
      {stats && (
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{stats.totalAlarms}</Text>
            <Text style={styles.statLabel}>Total</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statNum, { color: '#FFCC00' }]}>{stats.predictions}</Text>
            <Text style={styles.statLabel}>Predictions</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statNum, { color: '#FF4444' }]}>{stats.detections}</Text>
            <Text style={styles.statLabel}>Detections</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statNum, { color: '#00FF88' }]}>{stats.confirmedReal}</Text>
            <Text style={styles.statLabel}>Real</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statNum, { color: '#556677' }]}>{stats.falseAlarms}</Text>
            <Text style={styles.statLabel}>False</Text>
          </View>
        </View>
      )}

      {/* Event list */}
      <FlatList
        data={events}
        keyExtractor={item => item.id}
        renderItem={renderEvent}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#4499FF" />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No alarm events recorded yet.</Text>
          </View>
        }
      />

      <BottomTabBar activeTab="archive" role={role} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090915' },
  header: {
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#0D1828',
  },
  headerTitle: { color: '#E8F0FF', fontSize: 20, fontWeight: '700', fontFamily: MONO },

  // Patient picker
  patientPicker: {
    paddingHorizontal: 12, paddingVertical: 10, gap: 8,
    borderBottomWidth: 1, borderBottomColor: '#0D1828',
  },
  patientChip: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20,
    borderWidth: 1, borderColor: '#1E2E44', backgroundColor: '#0D1220',
    marginRight: 8,
  },
  patientChipSelected: {
    borderColor: '#4499FF', backgroundColor: '#4499FF22',
  },
  patientChipText: { color: '#556677', fontSize: 13, fontWeight: '600', fontFamily: MONO },
  patientChipTextSelected: { color: '#4499FF' },
  noPatients: { padding: 20, alignItems: 'center' },
  noPatientsText: { color: '#334455', fontSize: 13 },

  // Stats
  statsRow: {
    flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#0D1828', gap: 4,
  },
  statBox: { flex: 1, alignItems: 'center', gap: 2 },
  statNum: { color: '#E8F0FF', fontSize: 20, fontWeight: '700', fontFamily: MONO },
  statLabel: { color: '#445566', fontSize: 9, fontFamily: MONO, textTransform: 'uppercase', letterSpacing: 0.5 },
  listContent: { paddingVertical: 8 },
  emptyContainer: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#334455', fontSize: 14, textAlign: 'center' },

  // Event card
  eventCard: {
    marginHorizontal: 12, marginVertical: 4,
    backgroundColor: '#0D1220', borderRadius: 12,
    borderWidth: 1, borderColor: '#1E2E44', padding: 14, gap: 10,
  },
  eventHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  typeBadge: {
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1,
  },
  typeBadgeText: { fontSize: 10, fontWeight: '700', fontFamily: MONO, letterSpacing: 0.5 },
  eventDate: { color: '#556677', fontSize: 11, fontFamily: MONO },
  eventDetails: { gap: 4 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between' },
  detailLabel: { color: '#445566', fontSize: 12, fontFamily: MONO },
  detailValue: { color: '#AAB8CC', fontSize: 12, fontFamily: MONO, fontWeight: '600' },
  expandedChart: { marginTop: 6 },
});
