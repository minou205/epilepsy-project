import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Platform,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';

import { useAuth }       from '../services/AuthContext';
import { useNavigation } from '../navigation/NavigationContext';
import BottomTabBar       from '../components/BottomTabBar';
import RoleBadge          from '../components/RoleBadge';
import {
  Post,
  fetchPosts,
  deletePost,
  fetchUserProfile,
  getOrCreateConversation,
  uploadImageToStorage,
} from '../services/CommunityService';
import { UserProfile } from '../services/supabaseClient';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export default function ProfileScreen() {
  const { profile: myProfile, user, updateProfile } = useAuth();
  const { navigate, goBack, params } = useNavigation();

  const targetUserId = (params.userId as string) || user?.id;
  const isOwnProfile = !params.userId || params.userId === user?.id;

  const [profileData, setProfileData] = useState<UserProfile | null>(isOwnProfile ? myProfile : null);
  const [posts, setPosts]             = useState<Post[]>([]);
  const [loading, setLoading]         = useState(true);

  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue]       = useState('');

  const role = myProfile?.role ?? 'patient';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (isOwnProfile) {
          setProfileData(myProfile);
        } else if (targetUserId) {
          const prof = await fetchUserProfile(targetUserId);
          if (!cancelled) setProfileData(prof);
        }
        if (targetUserId) {
          const allPosts = await fetchPosts(50);
          if (!cancelled) setPosts(allPosts.filter(p => p.author_id === targetUserId));
        }
      } catch (err) {
        console.error('[Profile] Load error:', err);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [targetUserId, isOwnProfile, myProfile]);

  const startEdit = (field: string, currentValue: string) => {
    if (!isOwnProfile) return;
    setEditingField(field);
    setEditValue(currentValue);
  };

  const saveEdit = async () => {
    if (!editingField || !isOwnProfile) return;
    const trimmed = editValue.trim();
    try {
      const updates: Partial<UserProfile> = {};
      if (editingField === 'full_name') {
        updates.full_name = trimmed;
        updates.patient_name = trimmed;
      } else if (editingField === 'username') {
        updates.username = trimmed.toLowerCase();
      } else if (editingField === 'bio') {
        updates.bio = trimmed;
      }
      await updateProfile(updates);
      setEditingField(null);
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to save');
    }
  };

  const cancelEdit = () => { setEditingField(null); };

  const handlePickAvatar = async () => {
    if (!isOwnProfile) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;
    try {
      const uri = result.assets[0].uri;
      const path = `avatars/${user?.id}_${Date.now()}.jpg`;
      const publicUrl = await uploadImageToStorage(uri, 'avatars', path);
      await updateProfile({ avatar_url: publicUrl });
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to upload avatar');
    }
  };

  const handlePickBackground = async () => {
    if (!isOwnProfile) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [16, 9],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;
    try {
      const uri = result.assets[0].uri;
      const path = `backgrounds/${user?.id}_${Date.now()}.jpg`;
      const publicUrl = await uploadImageToStorage(uri, 'backgrounds', path);
      await updateProfile({ background_url: publicUrl });
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to upload background');
    }
  };

  const handleSendMessage = async () => {
    if (!targetUserId || isOwnProfile) return;
    try {
      const conversationId = await getOrCreateConversation(targetUserId);
      navigate('chat', {
        conversationId,
        otherUser: profileData
          ? { id: profileData.id, full_name: profileData.full_name, username: profileData.username, avatar_url: profileData.avatar_url, role: profileData.role }
          : null,
      });
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to start conversation');
    }
  };

  const handleDeletePost = (postId: string) => {
    if (!isOwnProfile) return;
    Alert.alert('Delete Post', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await deletePost(postId);
            setPosts(prev => prev.filter(p => p.id !== postId));
          } catch (err: any) {
            Alert.alert('Error', err?.message ?? 'Failed to delete post');
          }
        },
      },
    ]);
  };

  if (!profileData && !loading) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        <View style={styles.headerBar}>
          <TouchableOpacity onPress={goBack} style={styles.backBtn}>
            <Text style={styles.backText}>{'<'}</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Profile</Text>
        </View>
        <View style={styles.emptyRoot}>
          <Text style={styles.emptyText}>User not found.</Text>
        </View>
        <BottomTabBar activeTab="community" role={role} />
      </SafeAreaView>
    );
  }

  const EditableField = ({ field, value, placeholder, style: textStyle, multiline }: {
    field: string; value: string; placeholder: string; style: any; multiline?: boolean;
  }) => {
    if (editingField === field) {
      return (
        <View style={styles.editRow}>
          <TextInput
            style={[styles.editInput, multiline && { minHeight: 60, textAlignVertical: 'top' }]}
            value={editValue}
            onChangeText={setEditValue}
            placeholder={placeholder}
            placeholderTextColor="#334455"
            autoFocus
            multiline={multiline}
            autoCapitalize={field === 'username' ? 'none' : 'words'}
          />
          <View style={styles.editBtns}>
            <TouchableOpacity style={styles.editSaveBtn} onPress={saveEdit}>
              <Text style={styles.editSaveBtnText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={cancelEdit}>
              <Text style={styles.editCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    return (
      <TouchableOpacity
        onPress={() => isOwnProfile && startEdit(field, value)}
        activeOpacity={isOwnProfile ? 0.6 : 1}
      >
        <Text style={textStyle}>{value || placeholder}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ExpoStatusBar style="light" />

      <View style={styles.headerBar}>
        <TouchableOpacity onPress={goBack} style={styles.backBtn}>
          <Text style={styles.backText}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Profile</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <TouchableOpacity
          style={styles.bgContainer}
          onPress={isOwnProfile ? handlePickBackground : undefined}
          activeOpacity={isOwnProfile ? 0.7 : 1}
        >
          {profileData?.background_url ? (
            <Image source={{ uri: profileData.background_url }} style={styles.bgImage} resizeMode="cover" />
          ) : (
            <View style={styles.bgPlaceholder}>
              {isOwnProfile && <Text style={styles.bgHint}>Tap to set background</Text>}
            </View>
          )}
        </TouchableOpacity>

        <View style={styles.profileHeader}>
          <TouchableOpacity
            onPress={isOwnProfile ? handlePickAvatar : undefined}
            activeOpacity={isOwnProfile ? 0.7 : 1}
          >
            {profileData?.avatar_url ? (
              <Image source={{ uri: profileData.avatar_url }} style={styles.avatarLarge} />
            ) : (
              <View style={styles.avatarLargePlaceholder}>
                <Text style={styles.avatarLargeText}>
                  {(profileData?.full_name || profileData?.patient_name || '?')[0].toUpperCase()}
                </Text>
              </View>
            )}
            {isOwnProfile && <Text style={styles.changeAvatarHint}>Change</Text>}
          </TouchableOpacity>

          <EditableField
            field="full_name"
            value={profileData?.full_name || profileData?.patient_name || ''}
            placeholder="Your name"
            style={styles.profileName}
          />

          <EditableField
            field="username"
            value={profileData?.username ? `@${profileData.username}` : ''}
            placeholder="@username"
            style={styles.profileHandle}
          />

          <RoleBadge role={profileData?.role ?? 'patient'} size="medium" />

          <EditableField
            field="bio"
            value={profileData?.bio || ''}
            placeholder={isOwnProfile ? 'Tap to add bio...' : 'No bio'}
            style={styles.bioText}
            multiline
          />

          <View style={styles.actionRow}>
            {!isOwnProfile && (
              <TouchableOpacity
                style={styles.messageBtn}
                onPress={handleSendMessage}
                activeOpacity={0.7}
              >
                <Text style={styles.messageBtnText}>Send Message</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{posts.length}</Text>
            <Text style={styles.statLabel}>Posts</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>{isOwnProfile ? 'MY POSTS' : 'POSTS'}</Text>
        {posts.length === 0 ? (
          <Text style={styles.emptyText}>No posts yet.</Text>
        ) : (
          posts.map(p => (
            <View key={p.id} style={styles.postCard}>
              <Text style={styles.postContent}>{p.content}</Text>
              {p.image_url && (
                <Image source={{ uri: p.image_url }} style={styles.postImage} resizeMode="cover" />
              )}
              <View style={styles.postFooter}>
                <Text style={styles.postMeta}>
                  {new Date(p.created_at).toLocaleDateString()} - {p.like_count} likes - {p.comment_count} comments
                </Text>
                {isOwnProfile && (
                  <TouchableOpacity onPress={() => handleDeletePost(p.id)}>
                    <Text style={styles.postDeleteText}>Delete</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <BottomTabBar activeTab="community" role={role} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090915' },
  headerBar: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#0D1828',
  },
  backBtn: { padding: 4 },
  backText: { color: '#4499FF', fontSize: 20, fontWeight: '700' },
  headerTitle: { color: '#E8F0FF', fontSize: 20, fontWeight: '700', fontFamily: MONO },
  content: { paddingBottom: 20 },
  emptyRoot: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  bgContainer: { width: '100%', height: 140 },
  bgImage: { width: '100%', height: 140 },
  bgPlaceholder: {
    width: '100%', height: 140, backgroundColor: '#0D1828',
    alignItems: 'center', justifyContent: 'center',
  },
  bgHint: { color: '#334455', fontSize: 12 },

  profileHeader: { alignItems: 'center', marginTop: -40, paddingBottom: 16, gap: 8 },
  avatarLarge: {
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 3, borderColor: '#090915',
  },
  avatarLargePlaceholder: {
    width: 80, height: 80, borderRadius: 40, backgroundColor: '#1A2840',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: '#090915',
  },
  avatarLargeText: { color: '#4499FF', fontSize: 32, fontWeight: '700' },
  changeAvatarHint: { color: '#4499FF', fontSize: 10, textAlign: 'center', marginTop: 2 },
  profileName: { color: '#E8F0FF', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  profileHandle: { color: '#556677', fontSize: 14, fontFamily: MONO, textAlign: 'center' },
  bioText: {
    color: '#AAB8CC', fontSize: 13, textAlign: 'center',
    paddingHorizontal: 30, lineHeight: 20,
  },

  editRow: { width: '80%', gap: 6, alignItems: 'center' },
  editInput: {
    width: '100%', backgroundColor: '#080D18', borderWidth: 1, borderColor: '#4499FF55',
    borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12,
    color: '#E8F0FF', fontSize: 14, fontFamily: MONO, textAlign: 'center',
  },
  editBtns: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  editSaveBtn: {
    paddingHorizontal: 16, paddingVertical: 6, borderRadius: 8, backgroundColor: '#4499FF',
  },
  editSaveBtnText: { color: '#090915', fontSize: 12, fontWeight: '700' },
  editCancelText: { color: '#556677', fontSize: 12 },

  actionRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  messageBtn: {
    paddingHorizontal: 24, paddingVertical: 10, borderRadius: 10,
    backgroundColor: '#4499FF',
  },
  messageBtnText: { color: '#090915', fontSize: 13, fontWeight: '700' },

  statsRow: {
    flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1,
    borderColor: '#0D1828', paddingVertical: 14, marginHorizontal: 16,
  },
  statBox: { flex: 1, alignItems: 'center', gap: 2 },
  statNum: { color: '#E8F0FF', fontSize: 20, fontWeight: '700', fontFamily: MONO },
  statLabel: { color: '#445566', fontSize: 10, fontFamily: MONO, textTransform: 'uppercase' },
  sectionTitle: {
    color: '#334455', fontSize: 10, fontWeight: '700', letterSpacing: 1.4,
    fontFamily: MONO, marginTop: 20, marginBottom: 8, marginHorizontal: 16,
  },
  emptyText: { color: '#334455', textAlign: 'center', padding: 20 },

  postCard: {
    marginHorizontal: 16, marginVertical: 4, backgroundColor: '#0D1220',
    borderRadius: 12, borderWidth: 1, borderColor: '#1E2E44', padding: 14, gap: 6,
  },
  postContent: { color: '#AAB8CC', fontSize: 14, lineHeight: 20 },
  postImage: { width: '100%', height: 160, borderRadius: 8, backgroundColor: '#0D1828' },
  postFooter: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  postMeta: { color: '#445566', fontSize: 11, fontFamily: MONO },
  postDeleteText: { color: '#FF6644', fontSize: 11, fontWeight: '600' },
});
