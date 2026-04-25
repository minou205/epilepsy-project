import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { decode } from 'base64-arraybuffer';
import { supabase, UserProfile } from './supabaseClient';

export interface Post {
  id         : string;
  author_id  : string;
  content    : string;
  image_url  : string | null;
  created_at : string;
  author     : Pick<UserProfile, 'id' | 'full_name' | 'username' | 'avatar_url' | 'role'> | null;
  like_count : number;
  comment_count: number;
  liked_by_me: boolean;
}

export interface Comment {
  id         : string;
  post_id    : string;
  author_id  : string;
  content    : string;
  created_at : string;
  author     : Pick<UserProfile, 'id' | 'full_name' | 'username' | 'avatar_url' | 'role'> | null;
}

export interface Conversation {
  id          : string;
  created_at  : string;
  other_user  : Pick<UserProfile, 'id' | 'full_name' | 'username' | 'avatar_url' | 'role'> | null;
  last_message: string | null;
  last_at     : string | null;
}

export interface Message {
  id              : string;
  conversation_id : string;
  sender_id       : string;
  content         : string;
  created_at      : string;
}

export async function fetchPosts(limit = 30, offset = 0): Promise<Post[]> {
  const userId = (await supabase.auth.getUser()).data.user?.id;

  const { data, error } = await supabase
    .from('posts')
    .select(`
      id, author_id, content, image_url, created_at,
      profiles:author_id ( id, full_name, username, avatar_url, role ),
      likes ( id ),
      comments ( id )
    `)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return (data ?? []).map((p: any) => ({
    id           : p.id,
    author_id    : p.author_id,
    content      : p.content,
    image_url    : p.image_url,
    created_at   : p.created_at,
    author       : p.profiles,
    like_count   : p.likes?.length ?? 0,
    comment_count: p.comments?.length ?? 0,
    liked_by_me  : userId ? (p.likes ?? []).some((l: any) => l.user_id === userId) : false,
  }));
}

export async function createPost(content: string, imageUrl?: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { data: profileExists } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', userId)
    .maybeSingle();

  if (!profileExists) {
    const user = (await supabase.auth.getUser()).data.user;
    await supabase.from('profiles').insert({
      id: userId,
      patient_name: user?.email?.split('@')[0] ?? 'User',
      full_name: user?.email?.split('@')[0] ?? 'User',
      server_ip: '',
      consent_given: false,
      general_model_config: 'both',
    });
  }

  const { error } = await supabase.from('posts').insert({
    author_id: userId,
    content,
    image_url: imageUrl ?? null,
  });
  if (error) throw error;
}

export async function deletePost(postId: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { error } = await supabase.from('posts').delete().eq('id', postId).eq('author_id', userId);
  if (error) throw error;
}

export async function updatePost(postId: string, content: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { error } = await supabase
    .from('posts')
    .update({ content })
    .eq('id', postId)
    .eq('author_id', userId);
  if (error) throw error;
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  await supabase.from('messages').delete().eq('conversation_id', conversationId);
  await supabase.from('conversation_members').delete().eq('conversation_id', conversationId);
  const { error } = await supabase.from('conversations').delete().eq('id', conversationId);
  if (error) throw error;
}

export async function toggleLike(postId: string): Promise<boolean> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { data: existing } = await supabase
    .from('likes')
    .select('id')
    .eq('post_id', postId)
    .eq('user_id', userId)
    .maybeSingle();

  if (existing) {
    await supabase.from('likes').delete().eq('id', existing.id);
    return false;
  } else {
    await supabase.from('likes').insert({ post_id: postId, user_id: userId });
    return true;
  }
}

export async function fetchComments(postId: string): Promise<Comment[]> {
  const { data, error } = await supabase
    .from('comments')
    .select(`
      id, post_id, author_id, content, created_at,
      profiles:author_id ( id, full_name, username, avatar_url, role )
    `)
    .eq('post_id', postId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return (data ?? []).map((c: any) => ({
    ...c,
    author: c.profiles,
  }));
}

export async function addComment(postId: string, content: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { error } = await supabase.from('comments').insert({
    post_id  : postId,
    author_id: userId,
    content,
  });
  if (error) throw error;
}

export async function getOrCreateConversation(otherUserId: string): Promise<string> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { data: myConvos } = await supabase
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', userId);

  const { data: theirConvos } = await supabase
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', otherUserId);

  const myIds    = new Set((myConvos ?? []).map(c => c.conversation_id));
  const sharedId = (theirConvos ?? []).find(c => myIds.has(c.conversation_id));

  if (sharedId) return sharedId.conversation_id;

  const convId = Crypto.randomUUID();

  const { error } = await supabase
    .from('conversations')
    .insert({ id: convId });
  if (error) throw error;

  const { error: memberErr } = await supabase.from('conversation_members').insert([
    { conversation_id: convId, user_id: userId },
    { conversation_id: convId, user_id: otherUserId },
  ]);
  if (memberErr) throw memberErr;

  return convId;
}

export async function fetchMessages(conversationId: string, limit = 50): Promise<Message[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

export async function sendMessage(conversationId: string, content: string): Promise<void> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    sender_id      : userId,
    content,
  });
  if (error) throw error;
}

export async function fetchConversations(): Promise<Conversation[]> {
  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error('Not authenticated');

  const { data: memberships, error: mErr } = await supabase
    .from('conversation_members')
    .select('conversation_id')
    .eq('user_id', userId);

  if (mErr) throw mErr;
  if (!memberships || memberships.length === 0) return [];

  const convIds = memberships.map(m => m.conversation_id);

  const conversations: Conversation[] = [];

  for (const convId of convIds) {
    const { data: members } = await supabase
      .from('conversation_members')
      .select('user_id')
      .eq('conversation_id', convId)
      .neq('user_id', userId);

    const otherUserId = members?.[0]?.user_id;
    let otherUser: Conversation['other_user'] = null;

    if (otherUserId) {
      const { data: prof } = await supabase
        .from('profiles')
        .select('id, full_name, username, avatar_url, role')
        .eq('id', otherUserId)
        .single();
      otherUser = prof as any;
    }

    const { data: msgs } = await supabase
      .from('messages')
      .select('content, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(1);

    conversations.push({
      id: convId,
      created_at: '',
      other_user: otherUser,
      last_message: msgs?.[0]?.content ?? null,
      last_at: msgs?.[0]?.created_at ?? null,
    });
  }

  conversations.sort((a, b) => {
    if (!a.last_at && !b.last_at) return 0;
    if (!a.last_at) return 1;
    if (!b.last_at) return -1;
    return new Date(b.last_at).getTime() - new Date(a.last_at).getTime();
  });

  return conversations;
}

export async function fetchHelperPatients(helperId: string): Promise<Pick<UserProfile, 'id' | 'full_name' | 'username' | 'avatar_url' | 'role'>[]> {
  const { data, error } = await supabase
    .from('helper_patients')
    .select('patient_id, profiles:patient_id ( id, full_name, username, avatar_url, role )')
    .eq('helper_id', helperId);

  if (error) throw error;
  return (data ?? []).map((row: any) => row.profiles).filter(Boolean);
}

export async function uploadImageToStorage(
  uri: string,
  bucket: string,
  path: string,
): Promise<string> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const { error } = await supabase.storage.from(bucket).upload(path, decode(base64), {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

export async function fetchUserProfile(userId: string): Promise<UserProfile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data as UserProfile;
}
