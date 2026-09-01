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

const DRIVER_QUICK_REPLIES = ["On my way", "I've arrived", "Can't find the entrance", 'Running a bit late'];

const ACTIVE_STATUSES = ['assigned', 'picked_up', 'in_transit'];

interface Props {
  deliveryId: string;
  deliveryStatus: string;
}

/** Driver side of the per-delivery chat. */
export function DriverDeliveryChat({ deliveryId, deliveryStatus }: Props) {
  const [open, setOpen] = React.useState(false);
  const [userId, setUserId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<DeliveryMessage[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [sending, setSending] = React.useState(false);
  const openRef = React.useRef(open);
  openRef.current = open;

  const inFlight = ACTIVE_STATUSES.includes(deliveryStatus);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

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
      const msg = await sendMessage(supabase, deliveryId, 'driver', body);
      if (msg) setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
    } finally {
      setSending(false);
    }
  };

  if (!userId) return null;

  return (
    <>
      {/* The badge hangs OUTSIDE the button, on a wrapper, because Button's base class list
          includes overflow-hidden — anything absolutely positioned past its edge was clipped
          to a red sliver with the number cut off entirely, which is how it was reported. */}
      <span className="relative inline-flex">
        <Button
          variant="soft"
          size="md"
          leftIcon={<MessageCircle className="h-4 w-4" />}
          onClick={openChat}
        >
          Chat
        </Button>
        {unread > 0 && (
          <span
            aria-label={`${unread} unread message${unread === 1 ? '' : 's'}`}
            className="pointer-events-none absolute -right-2 -top-2 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-bold leading-none text-white ring-2 ring-background"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </span>

      <Sheet open={open} onClose={() => setOpen(false)} title="Chat with the customer">
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
            quickReplies={DRIVER_QUICK_REPLIES}
            disabled={!inFlight}
            disabledNotice="Chat closes when the delivery ends."
          />
        </div>
      </Sheet>
    </>
  );
}
