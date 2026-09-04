import type { FavornomsClient } from '../client-type';

// Driver ↔ customer chat, scoped to one delivery. RLS limits reads/writes to
// the two participants and blocks sends once the delivery leaves the active
// statuses. Mark-read goes through the mark_messages_read RPC.
//
// A message can also carry one photo, kept in the private `chat-attachments`
// bucket under the delivery's id (see 20260904130000). The bucket is private, so
// rendering one needs a signed URL — signAttachments() mints them a page at a time.

/** Private bucket the chat photos live in. */
export const CHAT_ATTACHMENT_BUCKET = 'chat-attachments';
/** Cap on the SOURCE file, before compression. A 12 MP phone shot is ~6 MB; 25 MB only
 *  rejects the pathological — a screen recording picked from the gallery by mistake. */
export const CHAT_ATTACHMENT_SOURCE_MAX_BYTES = 25 * 1024 * 1024;
export const CHAT_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Long edge after compression. Big enough to read a gate code, small enough to leave a
 *  rider's cell uplink in a few hundred KB. */
export const CHAT_ATTACHMENT_MAX_EDGE = 1280;
export const CHAT_ATTACHMENT_QUALITY = 0.72;

/** Body stored for a photo sent with no caption. delivery_messages.body is NOT NULL, and
 *  the push preview is built by a trigger this repo does not version — so the body itself
 *  is the only place a photo can announce itself on a lock screen. */
export const CHAT_PHOTO_BODY = '📷 Photo';

/** True when the body is only the auto-caption, i.e. the bubble should show the photo and
 *  no words. A real caption that merely starts with the sentinel is not one. */
export function isChatPhotoBody(body: string): boolean {
  return body.trim() === CHAT_PHOTO_BODY;
}

export interface DeliveryMessage {
  id: string;
  delivery_id: string;
  sender_role: 'customer' | 'driver';
  sender_user_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
  /** Object path in the private chat-attachments bucket; null for text-only messages. */
  attachment_path: string | null;
  attachment_width: number | null;
  attachment_height: number | null;
}

export async function listMessages(
  supabase: FavornomsClient,
  deliveryId: string,
): Promise<DeliveryMessage[]> {
  const { data } = await supabase
    .from('delivery_messages')
    // '*' rather than the column list this used to name. Two selects each spelled out the
    // same seven columns, so adding attachment_path to the table and to only one of them
    // would have shown a photo when it arrived live and lost it on reload — the hardest
    // version of this bug to see. The row is seven small columns; there is nothing to save.
    .select('*')
    .eq('delivery_id', deliveryId)
    .order('created_at', { ascending: true })
    .limit(200);
  return (data ?? []) as unknown as DeliveryMessage[];
}

export async function sendMessage(
  supabase: FavornomsClient,
  deliveryId: string,
  senderRole: 'customer' | 'driver',
  body: string,
): Promise<DeliveryMessage | null> {
  const trimmed = body.trim().slice(0, 1000);
  if (!trimmed) return null;
  const { data, error } = await supabase
    .from('delivery_messages')
    .insert({ delivery_id: deliveryId, sender_role: senderRole, body: trimmed })
    .select('*')
    .single();
  if (error) throw new Error(`send_message_failed:${error.message}`);
  return data as unknown as DeliveryMessage;
}

export interface CompressedChatImage {
  blob: Blob;
  width: number;
  height: number;
  ext: 'webp' | 'jpg';
  contentType: 'image/webp' | 'image/jpeg';
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  // Safari silently falls back to PNG when asked to encode webp, so the returned blob's own
  // type is the only reliable feature test — the extension we store must not lie.
  return new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b && b.type === type ? b : null), type, quality),
  );
}

/**
 * Browser-only. Re-encodes a camera photo down to CHAT_ATTACHMENT_MAX_EDGE on its long
 * side. Sending a raw 6 MB shot over the cell uplink a rider is actually on is a 30-second
 * stall in the middle of a delivery, and the bucket would reject it anyway.
 */
export async function compressChatImage(file: File): Promise<CompressedChatImage> {
  if (!(CHAT_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) {
    // An iOS gallery pick can arrive as image/heic, which no browser canvas decodes.
    throw new Error('chat_attachment_unsupported_type');
  }
  if (file.size > CHAT_ATTACHMENT_SOURCE_MAX_BYTES) {
    throw new Error('chat_attachment_too_large');
  }

  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, CHAT_ATTACHMENT_MAX_EDGE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bmp.close();
    throw new Error('chat_attachment_no_canvas');
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close();

  const webp = await canvasToBlob(canvas, 'image/webp', CHAT_ATTACHMENT_QUALITY);
  if (webp) return { blob: webp, width, height, ext: 'webp', contentType: 'image/webp' };
  const jpeg = await canvasToBlob(canvas, 'image/jpeg', CHAT_ATTACHMENT_QUALITY);
  if (!jpeg) throw new Error('chat_attachment_encode_failed');
  return { blob: jpeg, width, height, ext: 'jpg', contentType: 'image/jpeg' };
}

/** Turns the codes thrown above into something a rider or a diner can act on. */
export function chatAttachmentErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (message.includes('chat_attachment_unsupported_type'))
    return 'That file is not a photo we can send. Use a JPG, PNG or WebP image.';
  if (message.includes('chat_attachment_too_large'))
    return 'That photo is too big. Try taking a new one.';
  if (message.includes('chat_attachment_no_canvas') || message.includes('chat_attachment_encode_failed'))
    return 'Your browser could not prepare that photo. Try another one.';
  if (message.includes('chat_attachment_upload_failed'))
    return 'The photo did not upload. Check your signal and tap to retry.';
  return 'Could not send that photo. Tap to retry.';
}

/**
 * Photo message: compress → upload to the private bucket → insert the row.
 *
 * The row is written last on purpose. A row pointing at an object that does not exist
 * renders as a permanently broken image in both apps, whereas an object with no row is
 * merely invisible. Nothing is cleaned up when the insert fails, because the bucket has no
 * DELETE policy — neither party may remove a photo the other is looking at.
 */
export async function sendPhotoMessage(
  supabase: FavornomsClient,
  deliveryId: string,
  senderRole: 'customer' | 'driver',
  file: File,
  caption = '',
): Promise<DeliveryMessage> {
  const { blob, width, height, ext, contentType } = await compressChatImage(file);
  const path = `${deliveryId}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(CHAT_ATTACHMENT_BUCKET)
    .upload(path, blob, { contentType, upsert: false });
  if (uploadError) throw new Error(`chat_attachment_upload_failed:${uploadError.message}`);

  // Never blank: body is NOT NULL and it is what the push preview reads.
  const body = caption.trim().slice(0, 1000) || CHAT_PHOTO_BODY;
  const { data, error } = await supabase
    .from('delivery_messages')
    // The generated types are regenerated centrally and do not know the attachment
    // columns yet; the repo's convention for that gap is `as never` on the payload.
    .insert({
      delivery_id: deliveryId,
      sender_role: senderRole,
      body,
      attachment_path: path,
      attachment_width: width,
      attachment_height: height,
    } as never)
    .select('*')
    .single();
  if (error) throw new Error(`send_message_failed:${error.message}`);
  return data as unknown as DeliveryMessage;
}

/** The bucket is private, so an <img src> needs a signed URL. One call covers the whole
 *  thread — signing per bubble is one round trip per photo on a phone. */
export async function signAttachments(
  supabase: FavornomsClient,
  messages: { attachment_path: string | null }[],
  expiresInSeconds = 60 * 60,
): Promise<Record<string, string>> {
  const paths = messages.map((m) => m.attachment_path).filter((p): p is string => !!p);
  if (paths.length === 0) return {};
  const { data } = await supabase.storage
    .from(CHAT_ATTACHMENT_BUCKET)
    .createSignedUrls(paths, expiresInSeconds);
  const urls: Record<string, string> = {};
  for (const row of data ?? []) {
    if (row.path && row.signedUrl) urls[row.path] = row.signedUrl;
  }
  return urls;
}

export async function markMessagesRead(supabase: FavornomsClient, deliveryId: string) {
  return supabase.rpc('mark_messages_read', { p_delivery_id: deliveryId } as never);
}

/** Realtime INSERT subscription for one delivery's thread. Returns unsubscribe. */
export function subscribeMessages(
  supabase: FavornomsClient,
  deliveryId: string,
  onMessage: (message: DeliveryMessage) => void,
): () => void {
  const channel = supabase
    .channel(`delivery-chat:${deliveryId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'delivery_messages', filter: `delivery_id=eq.${deliveryId}` },
      // payload.new carries every published column, so the attachment fields ride along
      // with no change here.
      (payload) => onMessage(payload.new as DeliveryMessage),
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
