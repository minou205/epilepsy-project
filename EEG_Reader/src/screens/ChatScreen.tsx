import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';

import { useAuth }       from '../services/AuthContext';
import { useNavigation } from '../navigation/NavigationContext';
import RoleBadge          from '../components/RoleBadge';
import { Message, fetchMessages, sendMessage } from '../services/CommunityService';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function ChatScreen() {
  const { user }                   = useAuth();
  const { params, goBack }         = useNavigation();
  const conversationId             = params.conversationId as string;
  const otherUser                  = params.otherUser as any;

  const [messages, setMessages]    = useState<Message[]>([]);
  const [text, setText]            = useState('');
  const [sending, setSending]      = useState(false);
  const flatListRef                = useRef<FlatList>(null);
  const pollRef                    = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadMessages = useCallback(async () => {
    if (!conversationId) return;
    try {
      const data = await fetchMessages(conversationId);
      setMessages(data);
    } catch (err) {
      console.error('[Chat] Failed to load messages:', err);
    }
  }, [conversationId]);

  useEffect(() => {
    loadMessages();
    // Poll every 3 seconds for new messages
    pollRef.current = setInterval(loadMessages, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadMessages]);

  const handleSend = async () => {
    if (!text.trim() || !conversationId || sending) return;
    setSending(true);
    try {
      await sendMessage(conversationId, text.trim());
      setText('');
      await loadMessages();
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (err: any) {
      console.error('[Chat] Send failed:', err);
    }
    setSending(false);
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isMine = item.sender_id === user?.id;
    return (
      <View style={[styles.msgRow, isMine && styles.msgRowMine]}>
        <View style={[styles.msgBubble, isMine ? styles.bubbleMine : styles.bubbleOther]}>
          <Text style={[styles.msgText, isMine && styles.msgTextMine]}>{item.content}</Text>
          <Text style={[styles.msgTime, isMine && styles.msgTimeMine]}>{formatTime(item.created_at)}</Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ExpoStatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
        <View style={styles.headerInfo}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.headerName} numberOfLines={1}>
              {otherUser?.full_name ?? 'Chat'}
            </Text>
            {otherUser?.role && <RoleBadge role={otherUser.role} />}
          </View>
          <Text style={styles.headerHandle}>@{otherUser?.username ?? '...'}</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={item => item.id}
          renderItem={renderMessage}
          contentContainerStyle={styles.msgList}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>No messages yet. Say hello!</Text>
            </View>
          }
        />

        {/* Input row */}
        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder="Type a message..."
            placeholderTextColor="#334455"
            multiline
            maxLength={2000}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!text.trim() || sending) && { opacity: 0.4 }]}
            onPress={handleSend}
            disabled={!text.trim() || sending}
          >
            <Text style={styles.sendBtnText}>Send</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090915' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#0D1828',
  },
  backBtn: { padding: 4 },
  backText: { color: '#4499FF', fontSize: 20, fontWeight: '700' },
  headerInfo: { flex: 1, gap: 2 },
  headerName: { color: '#E8F0FF', fontSize: 16, fontWeight: '700' },
  headerHandle: { color: '#445566', fontSize: 11, fontFamily: MONO },

  msgList: { paddingVertical: 10, paddingHorizontal: 12 },
  emptyContainer: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#334455', fontSize: 14, textAlign: 'center' },

  msgRow: { marginVertical: 3, flexDirection: 'row', justifyContent: 'flex-start' },
  msgRowMine: { justifyContent: 'flex-end' },
  msgBubble: {
    maxWidth: '78%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10,
  },
  bubbleOther: { backgroundColor: '#0D1828', borderBottomLeftRadius: 4 },
  bubbleMine:  { backgroundColor: '#1A3060', borderBottomRightRadius: 4 },
  msgText: { color: '#CCDDEE', fontSize: 14, lineHeight: 20 },
  msgTextMine: { color: '#E8F0FF' },
  msgTime: { color: '#445566', fontSize: 9, fontFamily: MONO, marginTop: 4, alignSelf: 'flex-end' },
  msgTimeMine: { color: '#556677' },

  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: '#0D1828',
    backgroundColor: '#090915',
  },
  input: {
    flex: 1, backgroundColor: '#0D1220', borderWidth: 1, borderColor: '#1E2E44',
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
    color: '#E8F0FF', fontSize: 14, maxHeight: 100,
  },
  sendBtn: {
    backgroundColor: '#4499FF', borderRadius: 20, paddingHorizontal: 18, paddingVertical: 10,
  },
  sendBtnText: { color: '#090915', fontWeight: '700', fontSize: 14 },
});
