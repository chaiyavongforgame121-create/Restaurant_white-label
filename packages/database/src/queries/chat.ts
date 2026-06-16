import type { FavornomsClient } from '../client-type';

// Driver ↔ customer chat, scoped to one delivery. RLS limits reads/writes to
// the two participants and blocks sends once the delivery leaves the active
// statuses. Mark-read goes through the mark_messages_read RPC.

export interface DeliveryMessage {
  id: string;
  delivery_id: string;
  sender_role: 'customer' | 'driver';
  sender_user_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export async function listMessages(
  supabase: FavornomsClient,
  deliveryId: string,
): Promise<DeliveryMessage[]> {
  const { data } = await supabase
    .from('delivery_messages')
    .select('id, delivery_id, sender_role, sender_user_id, body, created_at, read_at')
    .eq('delivery_id', deliveryId)
    .order('created_at', { ascending: true })
    .limit(200);
  return (data ?? []) as DeliveryMessage[];
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
    .select('id, delivery_id, sender_role, sender_user_id, body, created_at, read_at')
    .single();
  if (error) throw new Error(`send_message_failed:${error.message}`);
  return data as DeliveryMessage;
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
      (payload) => onMessage(payload.new as DeliveryMessage),
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
