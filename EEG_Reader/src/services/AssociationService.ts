import * as FileSystem from 'expo-file-system/legacy';
import { decode } from 'base64-arraybuffer';
import { supabase, UserProfile } from './supabaseClient';

export type PartnerMatch = Pick<UserProfile, 'id' | 'full_name' | 'username' | 'role'>;

export interface HelperRequest {
  id          : string;
  patient_id  : string;
  helper_id   : string;
  initiated_by: 'patient' | 'helper';
  status      : 'pending' | 'accepted' | 'rejected';
  created_at  : string;
  responded_at: string | null;
  other_user  : PartnerMatch | null;
}

export async function findUserByUsername(username: string): Promise<PartnerMatch | null> {
  const clean = username.trim().toLowerCase();
  if (!clean) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, username, role')
    .eq('username', clean)
    .maybeSingle();
  if (error) {
    console.warn('[Assoc] findUserByUsername failed:', error.message);
    return null;
  }
  return (data as PartnerMatch) ?? null;
}

export async function sendHelperRequest(
  patientId   : string,
  helperId    : string,
  initiatedBy : 'patient' | 'helper',
): Promise<{ ok: boolean; error?: string }> {
  if (patientId === helperId) {
    return { ok: false, error: 'Cannot associate with yourself' };
  }
  const { error } = await supabase
    .from('helper_requests')
    .insert({
      patient_id  : patientId,
      helper_id   : helperId,
      initiated_by: initiatedBy,
    });
  if (error) {
    if (error.code === '23505') {
      return { ok: false, error: 'Association already exists' };
    }
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function respondToHelperRequest(
  requestId: string,
  accept   : boolean,
): Promise<{ ok: boolean; error?: string }> {
  const newStatus = accept ? 'accepted' : 'rejected';
  const { data: req, error: upErr } = await supabase
    .from('helper_requests')
    .update({ status: newStatus, responded_at: new Date().toISOString() })
    .eq('id', requestId)
    .select('patient_id, helper_id, status')
    .single();

  if (upErr) return { ok: false, error: upErr.message };

  if (accept && req) {
    const { error: linkErr } = await supabase
      .from('helper_patients')
      .insert({ patient_id: req.patient_id, helper_id: req.helper_id });
    if (linkErr && linkErr.code !== '23505') {
      return { ok: false, error: linkErr.message };
    }
  }
  return { ok: true };
}

export async function fetchIncomingRequests(userId: string): Promise<HelperRequest[]> {
  const { data, error } = await supabase
    .from('helper_requests')
    .select(`
      id, patient_id, helper_id, initiated_by, status, created_at, responded_at,
      patient:patient_id ( id, full_name, username, role ),
      helper:helper_id  ( id, full_name, username, role )
    `)
    .eq('status', 'pending')
    .or(`and(initiated_by.eq.patient,helper_id.eq.${userId}),and(initiated_by.eq.helper,patient_id.eq.${userId})`)
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('[Assoc] fetchIncomingRequests failed:', error.message);
    return [];
  }

  return (data ?? []).map((r: any) => ({
    id          : r.id,
    patient_id  : r.patient_id,
    helper_id   : r.helper_id,
    initiated_by: r.initiated_by,
    status      : r.status,
    created_at  : r.created_at,
    responded_at: r.responded_at,
    other_user  : r.initiated_by === 'patient' ? r.patient : r.helper,
  }));
}

export async function submitDoctorVerification(
  doctorId: string,
  fileUri : string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const base64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const timestamp = Date.now();
    const ext       = fileUri.split('.').pop()?.toLowerCase() || 'jpg';
    const path      = `${doctorId}/verification_${timestamp}.${ext}`;

    const { error: upErr } = await supabase
      .storage
      .from('doctor-docs')
      .upload(path, decode(base64), {
        contentType: ext === 'pdf' ? 'application/pdf' : 'image/jpeg',
        upsert     : false,
      });
    if (upErr) return { ok: false, error: upErr.message };

    const { error: insErr } = await supabase
      .from('doctor_verifications')
      .insert({
        doctor_id   : doctorId,
        document_url: path,
      });
    if (insErr) return { ok: false, error: insErr.message };

    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Upload failed' };
  }
}

export async function fetchLatestVerification(doctorId: string) {
  const { data, error } = await supabase
    .from('doctor_verifications')
    .select('id, status, submitted_at, reviewed_at, notes')
    .eq('doctor_id', doctorId)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data;
}
