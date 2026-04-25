import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  TextInput,
  RefreshControl,
  Platform,
  Modal,
  KeyboardAvoidingView,
  Alert,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';

import { useAuth }       from '../services/AuthContext';
import { useNavigation } from '../navigation/NavigationContext';
import BottomTabBar          from '../components/BottomTabBar';
import RoleBadge             from '../components/RoleBadge';
import PendingRequestsCard   from '../components/PendingRequestsCard';
import {
  Post,
  Comment,
  fetchPosts,
  createPost,
  deletePost,
  updatePost,
  toggleLike,
  fetchComments,
  addComment,
  uploadImageToStorage,
} from '../services/CommunityService';

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function CommunityScreen() {
  const { profile, user } = useAuth();
  const { navigate }      = useNavigation();
  const role = profile?.role ?? 'patient';

  const [posts,       setPosts      ] = useState<Post[]>([]);
  const [refreshing,  setRefreshing ] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [composeText, setComposeText] = useState('');
  const [composeImage, setComposeImage] = useState<string | null>(null);
  const [posting,     setPosting    ] = useState(false);

  const [selectedPost,  setSelectedPost ] = useState<Post | null>(null);
  const [comments,      setComments     ] = useState<Comment[]>([]);
  const [commentText,   setCommentText  ] = useState('');
  const [loadingComments, setLoadingComments] = useState(false);

  const [editingPost,  setEditingPost ] = useState<Post | null>(null);
  const [editText,     setEditText    ] = useState('');
  const [saving,       setSaving      ] = useState(false);

  const loadPosts = useCallback(async () => {
    try {
      const data = await fetchPosts();
      setPosts(data);
    } catch (err) {
      console.error('[Community] Failed to load posts:', err);
    }
  }, []);

  useEffect(() => { loadPosts(); }, [loadPosts]);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadPosts();
    setRefreshing(false);
  };

  const handlePickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]) {
      setComposeImage(result.assets[0].uri);
    }
  };

  const handlePost = async () => {
    if (!composeText.trim() && !composeImage) return;
    setPosting(true);
    try {
      let imageUrl: string | undefined;
      if (composeImage) {
        const path = `posts/${user?.id}_${Date.now()}.jpg`;
        imageUrl = await uploadImageToStorage(composeImage, 'posts', path);
      }
      await createPost(composeText.trim(), imageUrl);
      setComposeText('');
      setComposeImage(null);
      setShowCompose(false);
      await loadPosts();
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to create post');
    }
    setPosting(false);
  };

  const handleLike = async (postId: string) => {
    try {
      const liked = await toggleLike(postId);
      setPosts(prev => prev.map(p =>
        p.id === postId
          ? { ...p, liked_by_me: liked, like_count: p.like_count + (liked ? 1 : -1) }
          : p
      ));
    } catch (err) {
      console.error('[Community] Like failed:', err);
    }
  };

  const openComments = async (post: Post) => {
    setSelectedPost(post);
    setLoadingComments(true);
    try {
      const data = await fetchComments(post.id);
      setComments(data);
    } catch (err) {
      console.error('[Community] Failed to load comments:', err);
    }
    setLoadingComments(false);
  };

  const handleAddComment = async () => {
    if (!commentText.trim() || !selectedPost) return;
    try {
      await addComment(selectedPost.id, commentText.trim());
      setCommentText('');
      const data = await fetchComments(selectedPost.id);
      setComments(data);
      setPosts(prev => prev.map(p =>
        p.id === selectedPost.id
          ? { ...p, comment_count: data.length }
          : p
      ));
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to add comment');
    }
  };

  const handleDeletePost = (postId: string) => {
    Alert.alert('Delete Post', 'Are you sure you want to delete this post?', [
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

  const handleEditPost = (post: Post) => {
    setEditingPost(post);
    setEditText(post.content);
  };

  const handleSaveEdit = async () => {
    if (!editingPost || !editText.trim()) return;
    setSaving(true);
    try {
      await updatePost(editingPost.id, editText.trim());
      setPosts(prev => prev.map(p =>
        p.id === editingPost.id ? { ...p, content: editText.trim() } : p
      ));
      setEditingPost(null);
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Failed to update post');
    }
    setSaving(false);
  };

  const handleAvatarPress = (authorId: string) => {
    navigate('profile', { userId: authorId });
  };

  const renderPost = ({ item }: { item: Post }) => (
    <View style={styles.postCard}>
      <View style={styles.authorRow}>
        <TouchableOpacity
          style={styles.avatar}
          onPress={() => item.author?.id && handleAvatarPress(item.author.id)}
          activeOpacity={0.7}
        >
          {item.author?.avatar_url ? (
            <Image source={{ uri: item.author.avatar_url }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarText}>
              {(item.author?.full_name ?? '?')[0].toUpperCase()}
            </Text>
          )}
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={styles.authorName}>{item.author?.full_name ?? 'Unknown'}</Text>
            {item.author?.role && <RoleBadge role={item.author.role} />}
          </View>
          <Text style={styles.authorHandle}>@{item.author?.username ?? '...'} - {timeAgo(item.created_at)}</Text>
        </View>
      </View>

      <Text style={styles.postContent}>{item.content}</Text>

      {item.image_url && (
        <Image source={{ uri: item.image_url }} style={styles.postImage} resizeMode="cover" />
      )}

      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => handleLike(item.id)}>
          <Text style={[styles.actionText, item.liked_by_me && { color: '#FF4444' }]}>
            {item.liked_by_me ? 'v' : 'o'} {item.like_count}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => openComments(item)}>
          <Text style={styles.actionText}>[] {item.comment_count}</Text>
        </TouchableOpacity>
        {item.author_id === user?.id && (
          <View style={{ flexDirection: 'row', marginLeft: 'auto', gap: 12 }}>
            <TouchableOpacity style={styles.actionBtn} onPress={() => handleEditPost(item)}>
              <Text style={[styles.actionText, { color: '#4499FF' }]}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn} onPress={() => handleDeletePost(item.id)}>
              <Text style={[styles.actionText, { color: '#FF6644' }]}>Delete</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <ExpoStatusBar style="light" />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.myAvatar}
          onPress={() => navigate('profile', { userId: user?.id })}
          activeOpacity={0.7}
        >
          {profile?.avatar_url ? (
            <Image source={{ uri: profile.avatar_url }} style={styles.myAvatarImg} />
          ) : (
            <Text style={styles.myAvatarText}>
              {(profile?.full_name || '?')[0].toUpperCase()}
            </Text>
          )}
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Community</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity
            style={styles.chatBtn}
            onPress={() => navigate('chatList')}
            activeOpacity={0.8}
          >
            <Text style={styles.chatBtnText}>Chats</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.composeBtn}
            onPress={() => setShowCompose(true)}
            activeOpacity={0.8}
          >
            <Text style={styles.composeBtnText}>+ Post</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={posts}
        keyExtractor={item => item.id}
        renderItem={renderPost}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={<PendingRequestsCard />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#4499FF" />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>No posts yet. Be the first to share!</Text>
          </View>
        }
      />

      <Modal visible={showCompose} transparent animationType="slide">
        <KeyboardAvoidingView
          style={styles.composeOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.composeCard}>
            <View style={styles.composeHeader}>
              <Text style={styles.composeTitle}>New Post</Text>
              <TouchableOpacity onPress={() => { setShowCompose(false); setComposeImage(null); }}>
                <Text style={styles.composeClose}>X</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.composeInput}
              value={composeText}
              onChangeText={setComposeText}
              placeholder="Share something with the community..."
              placeholderTextColor="#334455"
              multiline
              textAlignVertical="top"
              autoFocus
            />

            {composeImage && (
              <View style={styles.imagePreviewRow}>
                <Image source={{ uri: composeImage }} style={styles.imagePreview} />
                <TouchableOpacity onPress={() => setComposeImage(null)}>
                  <Text style={styles.removeImageText}>Remove</Text>
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.composeActions}>
              <TouchableOpacity style={styles.imagePickBtn} onPress={handlePickImage}>
                <Text style={styles.imagePickText}>Add Image</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.postBtn, (!composeText.trim() && !composeImage || posting) && { opacity: 0.4 }]}
                onPress={handlePost}
                disabled={(!composeText.trim() && !composeImage) || posting}
                activeOpacity={0.85}
              >
                <Text style={styles.postBtnText}>{posting ? 'Posting...' : 'Post'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={!!editingPost} transparent animationType="slide">
        <KeyboardAvoidingView
          style={styles.composeOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.composeCard}>
            <View style={styles.composeHeader}>
              <Text style={styles.composeTitle}>Edit Post</Text>
              <TouchableOpacity onPress={() => setEditingPost(null)}>
                <Text style={styles.composeClose}>X</Text>
              </TouchableOpacity>
            </View>
            <TextInput
              style={styles.composeInput}
              value={editText}
              onChangeText={setEditText}
              placeholder="Edit your post..."
              placeholderTextColor="#334455"
              multiline
              textAlignVertical="top"
              autoFocus
            />
            <View style={styles.composeActions}>
              <TouchableOpacity
                style={[styles.postBtn, (!editText.trim() || saving) && { opacity: 0.4 }]}
                onPress={handleSaveEdit}
                disabled={!editText.trim() || saving}
                activeOpacity={0.85}
              >
                <Text style={styles.postBtnText}>{saving ? 'Saving...' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={!!selectedPost} transparent animationType="slide">
        <KeyboardAvoidingView
          style={styles.composeOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.commentsCard}>
            <View style={styles.composeHeader}>
              <Text style={styles.composeTitle}>Comments</Text>
              <TouchableOpacity onPress={() => { setSelectedPost(null); setComments([]); }}>
                <Text style={styles.composeClose}>X</Text>
              </TouchableOpacity>
            </View>

            {loadingComments ? (
              <Text style={styles.loadingText}>Loading...</Text>
            ) : (
              <FlatList
                data={comments}
                keyExtractor={c => c.id}
                style={{ flex: 1 }}
                renderItem={({ item: c }) => (
                  <View style={styles.commentItem}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={styles.commentAuthor}>@{c.author?.username ?? '...'}</Text>
                      {c.author?.role && <RoleBadge role={c.author.role} />}
                      <Text style={styles.commentTime}>{timeAgo(c.created_at)}</Text>
                    </View>
                    <Text style={styles.commentContent}>{c.content}</Text>
                  </View>
                )}
                ListEmptyComponent={
                  <Text style={styles.emptyComment}>No comments yet.</Text>
                }
              />
            )}

            <View style={styles.commentInputRow}>
              <TextInput
                style={styles.commentInput}
                value={commentText}
                onChangeText={setCommentText}
                placeholder="Add a comment..."
                placeholderTextColor="#334455"
              />
              <TouchableOpacity
                style={styles.sendBtn}
                onPress={handleAddComment}
                disabled={!commentText.trim()}
              >
                <Text style={styles.sendBtnText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <BottomTabBar activeTab="community" role={role} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090915' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: '#0D1828',
  },
  myAvatar: {
    width: 34, height: 34, borderRadius: 17, backgroundColor: '#1A2840',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    borderWidth: 2, borderColor: '#4499FF55',
  },
  myAvatarImg: { width: 34, height: 34, borderRadius: 17 },
  myAvatarText: { color: '#4499FF', fontSize: 14, fontWeight: '700' },
  headerTitle: { color: '#E8F0FF', fontSize: 20, fontWeight: '700', fontFamily: MONO, flex: 1 },
  headerRight: { flexDirection: 'row', gap: 8 },
  chatBtn: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 10, borderWidth: 1, borderColor: '#1E2E44',
  },
  chatBtnText: { color: '#AAB8CC', fontWeight: '600', fontSize: 13 },
  composeBtn: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 10, backgroundColor: '#4499FF',
  },
  composeBtnText: { color: '#090915', fontWeight: '700', fontSize: 13 },
  listContent: { paddingVertical: 8 },
  emptyContainer: { padding: 40, alignItems: 'center' },
  emptyText: { color: '#334455', fontSize: 14, textAlign: 'center' },

  postCard: {
    marginHorizontal: 12, marginVertical: 5,
    backgroundColor: '#0D1220', borderRadius: 14,
    borderWidth: 1, borderColor: '#1E2E44', padding: 14, gap: 10,
  },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: {
    width: 36, height: 36, borderRadius: 18, backgroundColor: '#1A2840',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImg: { width: 36, height: 36, borderRadius: 18 },
  avatarText: { color: '#4499FF', fontSize: 16, fontWeight: '700' },
  authorName: { color: '#CCDDEE', fontSize: 14, fontWeight: '600' },
  authorHandle: { color: '#445566', fontSize: 11, fontFamily: MONO },
  postContent: { color: '#AAB8CC', fontSize: 14, lineHeight: 20 },
  postImage: { width: '100%', height: 200, borderRadius: 10, backgroundColor: '#0D1828' },
  actionsRow: { flexDirection: 'row', gap: 20 },
  actionBtn: { paddingVertical: 4, paddingHorizontal: 6 },
  actionText: { color: '#556677', fontSize: 13, fontFamily: MONO },

  composeOverlay: { flex: 1, backgroundColor: '#000000CC', justifyContent: 'flex-end' },
  composeCard: {
    backgroundColor: '#0D1220', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, maxHeight: '70%', gap: 14,
  },
  composeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  composeTitle: { color: '#E8F0FF', fontSize: 18, fontWeight: '700', fontFamily: MONO },
  composeClose: { color: '#556677', fontSize: 18, fontWeight: '700', padding: 4 },
  composeInput: {
    backgroundColor: '#080D18', borderWidth: 1, borderColor: '#1E2E44', borderRadius: 10,
    padding: 14, color: '#E8F0FF', fontSize: 14, minHeight: 100,
  },
  imagePreviewRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  imagePreview: { width: 60, height: 60, borderRadius: 8 },
  removeImageText: { color: '#FF6644', fontSize: 12, fontWeight: '600' },
  composeActions: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  imagePickBtn: {
    paddingHorizontal: 14, paddingVertical: 12,
    borderRadius: 12, borderWidth: 1, borderColor: '#1E2E44',
  },
  imagePickText: { color: '#AAB8CC', fontSize: 13, fontWeight: '600' },
  postBtn: {
    flex: 1, backgroundColor: '#4499FF', borderRadius: 12, paddingVertical: 14, alignItems: 'center',
  },
  postBtnText: { color: '#090915', fontSize: 16, fontWeight: '700' },

  commentsCard: {
    backgroundColor: '#0D1220', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, maxHeight: '80%', flex: 1,
  },
  loadingText: { color: '#445566', textAlign: 'center', padding: 20 },
  commentItem: {
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#141828', gap: 4,
  },
  commentAuthor: { color: '#4499FF', fontSize: 12, fontFamily: MONO, fontWeight: '600' },
  commentTime: { color: '#334455', fontSize: 10 },
  commentContent: { color: '#AAB8CC', fontSize: 13, lineHeight: 18 },
  emptyComment: { color: '#334455', textAlign: 'center', padding: 20 },
  commentInputRow: { flexDirection: 'row', gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#141828' },
  commentInput: {
    flex: 1, backgroundColor: '#080D18', borderWidth: 1, borderColor: '#1E2E44',
    borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12,
    color: '#E8F0FF', fontSize: 13,
  },
  sendBtn: {
    backgroundColor: '#4499FF', borderRadius: 10, paddingHorizontal: 16,
    justifyContent: 'center',
  },
  sendBtnText: { color: '#090915', fontWeight: '700', fontSize: 13 },
});
