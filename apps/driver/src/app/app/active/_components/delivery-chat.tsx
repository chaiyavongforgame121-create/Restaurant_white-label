'use client';

import * as React from 'react';
import { MessageCircle } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  chatAttachmentErrorMessage,
  isChatPhotoBody,
  listMessages,
  markMessagesRead,
  sendMessage,
  sendPhotoMessage,
  signAttachments,
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
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const [photoError, setPhotoError] = React.useState<string | null>(null);
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

  // Chat photos live in a private bucket, so each one needs a signed URL. Serialising the
  // outstanding paths — the same idiom realtime.ts uses for its tablesKey — keys the effect
  // off the SET of unsigned photos rather than the array identity, so it covers the history
  // load and every realtime arrival without re-signing what it already holds.
  const unsignedKey = messages
    .map((m) => m.attachment_path)
    .filter((p): p is string => !!p && !urls[p])
    .join(',');

  React.useEffect(() => {
    if (!unsignedKey) return;
    let cancelled = false;
    void signAttachments(
      getBrowserClient(),
      unsignedKey.split(',').map((attachment_path) => ({ attachment_path })),
    ).then((next) => {
      if (!cancelled) setUrls((curr) => ({ ...curr, ...next }));
    });
    return () => {
      cancelled = true;
    };
  }, [unsignedKey]);

  const openChat = () => {
    setOpen(true);
    setUnread(0);
    void markMessagesRead(getBrowserClient(), deliveryId);
  };

  const send = async (body: string) => {
    const supabase = getBrowserClient();
    const msg = await sendMessage(supabase, deliveryId, 'driver', body);
    if (msg) setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
  };

  const sendPhoto = async (file: File) => {
    setPhotoError(null);
    try {
      const msg = await sendPhotoMessage(getBrowserClient(), deliveryId, 'driver', file);
      setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
    } catch (err) {
      setPhotoError(chatAttachmentErrorMessage(err));
      // Rethrow so the thread marks the optimistic bubble failed and offers the retry.
      throw err;
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
              hasImage: !!m.attachment_path,
              imageUrl: m.attachment_path ? (urls[m.attachment_path] ?? null) : null,
              imageWidth: m.attachment_width,
              imageHeight: m.attachment_height,
              photoOnly: !!m.attachment_path && isChatPhotoBody(m.body),
            }))}
            onSend={send}
            onSendPhoto={sendPhoto}
            photoError={photoError}
            quickReplies={DRIVER_QUICK_REPLIES}
            disabled={!inFlight}
            disabledNotice="Chat closes when the delivery ends."
          />
        </div>
      </Sheet>
    </>
  );
}
