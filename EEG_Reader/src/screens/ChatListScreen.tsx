import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';

import { useAuth }      from '../services/AuthContext';
import { useNavigation } from '../navigation/NavigationContext';
import BottomTabBar       from '../components/BottomTabBar';
import RoleBadge          from '../components/RoleBadge';
import { Conversation, fetchConversations, deleteConversation } from '../services/CommunityService';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export default function ChatListScreen() {
  const { profile }       = useAuth();
  const { navigate, goBack } = useNavigation();
  const role = profile?.role ?? 'patient';

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [refreshing, setRefreshing]       = useState(false);
  const [loading, setLoading]             = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchConversations();
      setConversations(data);
    } catch (err) {
      console.error('[ChatList] Failed to load conversations:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const handleDeleteConversation = (convId: string) => {
    Alert.alert('Delete Chat', 'Delete this entire conversation?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await deleteConversation(convId);
            setConversations(prev => prev.filter(c => c.id !== convId));
          } catch (err: any) {
            Alert.alert('Error', err?.message ?? 'Failed to delete conversation');
          }
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: Conversation }) => (
    <TouchableOpacity
      style={styles.convItem}
      onPress={() => navigate('chat', { conversationId: item.id, otherUser: item.other_user })}
      onLongPress={() => handleDeleteConversation(item.id)}
      activeOpacity={0.7}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>
          {(item.other_user?.full_name ?? '?')[0].toUpperCase()}
        </Text>
      </View>
      <View style={styles.convInfo}>
        <View style={styles.convTopRow}>
          <Text style={styles.convName} numberOfLines={1}>
            {item.other_user?.full_name ?? 'Unknown'}
          </Text>
          {item.other_user?.role && <RoleBadge role={item.other_user.role} />}
          {item.last_at && (
            <Text style={styles.convTime}>{timeAgo(item.last_at)}</Text>
          )}
        </View>
        <Text style={styles.convHandle}>@{item.other_user?.username ?? '...'}</Text>
        {item.last_message && (
          <Text style={styles.convPreview} numberOfLines={1}>{item.last_message}</Text>
        )}
      </View>
      <TouchableOpacity
        style={styles.deleteBtn}
        onPress={() => handleDeleteConversation(item.id)}
        activeOpacity={0.7}
      >
        <Text style={styles.deleteBtnText}>X</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ExpoStatusBar style="light" />

      <View style={styles.header}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Chats</Text>
      </View>

      <FlatList
        data={conversations}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#4499FF" />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {loading ? 'Loading...' : 'No conversations yet.\nTap someone\'s avatar in Community to start a chat.'}
            </Text>
          </View>
        }
      />

      <BottomTabBar activeTab="community" role={role} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090915' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#0D1828',
  },
  backBtn: { padding: 4 },
  backText: { color: '#4499FF', fontSize: 20, fontWeight: '700' },
  headerTitle: { color: '#E8F0FF', fontSize: 20, fontWeight: '700', fontFamily: MONO },
  listContent: { paddingVertical: 4 },
  emptyContainer: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#334455', fontSize: 14, textAlign: 'center', lineHeight: 22 },

  convItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#0D1828',
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: '#1A2840',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#4499FF', fontSize: 18, fontWeight: '700' },
  convInfo: { flex: 1, gap: 2 },
  convTopRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  convName: { color: '#CCDDEE', fontSize: 14, fontWeight: '600', flexShrink: 1 },
  convTime: { color: '#334455', fontSize: 10, fontFamily: MONO, marginLeft: 'auto' },
  convHandle: { color: '#445566', fontSize: 11, fontFamily: MONO },
  convPreview: { color: '#556677', fontSize: 12, marginTop: 2 },
  deleteBtn: {
    width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#FF664418', borderWidth: 1, borderColor: '#FF664444',
  },
  deleteBtnText: { color: '#FF6644', fontSize: 12, fontWeight: '700' },
});
