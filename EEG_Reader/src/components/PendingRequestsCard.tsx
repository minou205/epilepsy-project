import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import { useAuth } from '../services/AuthContext';
import {
  HelperRequest,
  fetchIncomingRequests,
  respondToHelperRequest,
} from '../services/AssociationService';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export default function PendingRequestsCard() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<HelperRequest[]>([]);
  const [busyId,   setBusyId  ] = useState<string | null>(null);
  const [loading,  setLoading ] = useState(true);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    const rows = await fetchIncomingRequests(user.id);
    setRequests(rows);
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  const respond = async (id: string, accept: boolean) => {
    setBusyId(id);
    const res = await respondToHelperRequest(id, accept);
    setBusyId(null);
    if (!res.ok) {
      console.warn('[PendingRequestsCard] respond failed:', res.error);
      return;
    }
    setRequests(prev => prev.filter(r => r.id !== id));
  };

  if (loading) return null;
  if (requests.length === 0) return null;

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Pending Requests</Text>
      {requests.map(req => {
        const other = req.other_user;
        const name  = other?.full_name || other?.username || 'Unknown user';
        const description = req.initiated_by === 'patient'
          ? `${name} (patient) wants you as their helper`
          : `${name} (${other?.role ?? 'helper'}) wants to help you`;
        return (
          <View key={req.id} style={styles.card}>
            <Text style={styles.cardBody}>{description}</Text>
            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.btn, styles.acceptBtn, busyId === req.id && styles.btnDisabled]}
                disabled={busyId === req.id}
                onPress={() => respond(req.id, true)}
                activeOpacity={0.85}
              >
                {busyId === req.id
                  ? <ActivityIndicator size="small" color="#00FF88" />
                  : <Text style={styles.acceptText}>Accept</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btn, styles.rejectBtn, busyId === req.id && styles.btnDisabled]}
                disabled={busyId === req.id}
                onPress={() => respond(req.id, false)}
                activeOpacity={0.85}
              >
                <Text style={styles.rejectText}>Reject</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  title: {
    color: '#8899BB', fontSize: 11, fontWeight: '700', fontFamily: MONO,
    textTransform: 'uppercase', letterSpacing: 0.8, marginLeft: 4,
  },
  card: {
    backgroundColor: '#0A1A30', borderRadius: 12,
    borderWidth: 1, borderColor: '#1E3060',
    padding: 14, gap: 10,
  },
  cardBody: { color: '#CCDDEE', fontSize: 13, lineHeight: 18 },
  row: { flexDirection: 'row', gap: 8 },
  btn: {
    flex: 1, paddingVertical: 10, borderRadius: 8,
    alignItems: 'center', borderWidth: 1,
  },
  btnDisabled: { opacity: 0.5 },
  acceptBtn: { backgroundColor: '#003322', borderColor: '#00FF8855' },
  rejectBtn: { backgroundColor: '#1A0808', borderColor: '#FF444455' },
  acceptText: { color: '#00FF88', fontSize: 13, fontWeight: '700', fontFamily: MONO },
  rejectText: { color: '#FF6644', fontSize: 13, fontWeight: '700', fontFamily: MONO },
});
