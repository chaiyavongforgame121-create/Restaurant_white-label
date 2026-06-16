'use client';

import * as React from 'react';
import { MessageCircle } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  listMessages,
  markMessagesRead,
  sendMessage,
  subscribeMessages,
  type DeliveryMessage,
} from '@favornoms/database/queries';
import { Button, ChatThread, Sheet } from '@favornoms/ui';

const CUSTOMER_QUICK_REPLIES = ['Where are you?', 'Leave it at the door', 'Coming down now'];

const ACTIVE_STATUSES = ['assigned', 'picked_up', 'in_transit'];

interface Props {
  deliveryId: string;
  deliveryStatus: string;
}

/** Customer side of the per-delivery chat. Hidden for guests (no session — RLS
 * has no identity to authorize). */
export function DeliveryChat({ deliveryId, deliveryStatus }: Props) {
  const [open, setOpen] = React.useState(false);
  const [userId, setUserId] = React.useState<string | null>(null);
  const [authChecked, setAuthChecked] = React.useState(false);
  const [messages, setMessages] = React.useState<DeliveryMessage[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const openRef = React.useRef(open);
  openRef.current = open;

  const inFlight = ACTIVE_STATUSES.includes(deliveryStatus);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
      setAuthChecked(true);
    });
  }, []);

  // Load history + live subscription (badge keeps counting while closed).
  React.useEffect(() => {
    if (!userId) return;
    const supabase = getBrowserClient();
    void listMessages(supabase, deliveryId).then((msgs) => {
      setMessages(msgs);
      setUnread(msgs.filter((m) => m.read_at == null && m.sender_user_id !== userId).length);
    });
    const unsubscribe = subscribeMessages(supabase, deliveryId, (msg) => {
      setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
      if (msg.sender_user_id !== userId) {
        if (openRef.current) {
          void markMessagesRead(supabase, deliveryId);
        } else {
          setUnread((n) => n + 1);
        }
      }
    });
    return unsubscribe;
  }, [deliveryId, userId]);

  const openChat = () => {
    setOpen(true);
    setUnread(0);
    void markMessagesRead(getBrowserClient(), deliveryId);
  };

  const send = async (body: string) => {
    setSending(true);
    try {
      const supabase = getBrowserClient();
      const msg = await sendMessage(supabase, deliveryId, 'customer', body);
      if (msg) setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
    } finally {
      setSending(false);
    }
  };

  if (!authChecked) return null; // still resolving the session

  // Guest order — RLS has no identity to authorize chat. Explain it instead of
  // silently hiding the affordance (so it doesn't read as a missing feature).
  if (!userId) {
    return (
      <>
        <Button
          variant="soft"
          size="md"
          leftIcon={<MessageCircle className="h-4 w-4" />}
          onClick={() => setOpen(true)}
        >
          Chat
        </Button>
        <Sheet open={open} onClose={() => setOpen(false)} title="Chat with your driver">
          <div className="space-y-2 p-4 text-sm text-muted-foreground">
            <p>
              In-app chat is available when you order with an account. For this guest order, tap{' '}
              <strong>Call</strong> to reach your driver directly.
            </p>
          </div>
        </Sheet>
      </>
    );
  }

  return (
    <>
      <Button
        variant="soft"
        size="md"
        leftIcon={<MessageCircle className="h-4 w-4" />}
        onClick={openChat}
        className="relative"
      >
        Chat
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unread}
          </span>
        )}
      </Button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Chat with your driver">
        <div className="h-[60vh]">
          <ChatThread
            messages={messages.map((m) => ({
              id: m.id,
              body: m.body,
              mine: m.sender_user_id === userId,
              created_at: m.created_at,
            }))}
            onSend={send}
            sending={sending}
            quickReplies={CUSTOMER_QUICK_REPLIES}
            disabled={!inFlight}
            disabledNotice="Chat closes when the delivery ends."
          />
        </div>
      </Sheet>
    </>
  );
}
