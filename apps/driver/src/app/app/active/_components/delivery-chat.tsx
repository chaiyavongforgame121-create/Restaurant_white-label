'use client';

import * as React from 'react';
import { MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import {
  isChatPhotoBody,
  listMessages,
  markThreadRead,
  sendMessage,
  sendPhotoMessage,
  signAttachments,
  subscribeMessages,
  type DeliveryMessage,
} from '@favornoms/database/queries';
import { Button, ChatThread, Sheet } from '@favornoms/ui';

// The value is SENT to the customer as the message text, so it stays English whatever
// language the rider reads. Only the button label is translated (active.chat.quickReplies).
const DRIVER_QUICK_REPLIES = [
  { value: 'On my way', labelKey: 'onMyWay' },
  { value: "I've arrived", labelKey: 'arrived' },
  { value: "Can't find the entrance", labelKey: 'cantFindEntrance' },
  { value: 'Running a bit late', labelKey: 'runningLate' },
] as const;

const ACTIVE_STATUSES = ['assigned', 'picked_up', 'in_transit'];

interface Props {
  /** delivery_assignments.id — the thread key. A new rider gets a new one, so their sheet
   *  opens empty instead of on the rider they replaced. */
  assignmentId: string;
  /** Still written on every message: delivery_messages.delivery_id is NOT NULL and is what
   *  the merchant's audit view joins on. */
  deliveryId: string;
  deliveryStatus: string;
}

/** Driver side of the chat for ONE turn at a delivery. */
export function DriverDeliveryChat({ assignmentId, deliveryId, deliveryStatus }: Props) {
  const t = useTranslations('active');
  const [open, setOpen] = React.useState(false);
  const [userId, setUserId] = React.useState<string | null>(null);
  const [messages, setMessages] = React.useState<DeliveryMessage[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const [photoError, setPhotoError] = React.useState<string | null>(null);
  const openRef = React.useRef(open);
  openRef.current = open;

  const inFlight = ACTIVE_STATUSES.includes(deliveryStatus);

  // ChatThread sends the text of the chip it shows, so hand it the translated labels and turn
  // a label back into its English message on the way out.
  const quickReplies = DRIVER_QUICK_REPLIES.map((q) => ({
    value: q.value,
    label: t(`chat.quickReplies.${q.labelKey}`),
  }));

  /** The codes sendPhotoMessage throws, in the rider's language. */
  const photoErrorMessage = (err: unknown): string => {
    const message = err instanceof Error ? err.message : String(err ?? '');
    if (message.includes('chat_attachment_unsupported_type')) return t('chat.photoErrors.unsupportedType');
    if (message.includes('chat_attachment_too_large')) return t('chat.photoErrors.tooLarge');
    if (message.includes('chat_attachment_no_canvas') || message.includes('chat_attachment_encode_failed'))
      return t('chat.photoErrors.cannotPrepare');
    if (message.includes('chat_attachment_upload_failed')) return t('chat.photoErrors.uploadFailed');
    return t('chat.photoErrors.generic');
  };

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  React.useEffect(() => {
    if (!userId) return;
    const supabase = getBrowserClient();
    // A turn switch must not leave the previous rider's bubbles on screen while the new
    // thread loads — that is the bug, briefly, in front of the person it protects.
    setMessages([]);
    setUnread(0);
    setUrls({});
    void listMessages(supabase, assignmentId).then((msgs) => {
      setMessages(msgs);
      setUnread(msgs.filter((m) => m.read_at == null && m.sender_user_id !== userId).length);
    });
    const unsubscribe = subscribeMessages(supabase, assignmentId, (msg) => {
      setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
      if (msg.sender_user_id !== userId) {
        if (openRef.current) {
          void markThreadRead(supabase, assignmentId);
        } else {
          setUnread((n) => n + 1);
        }
      }
    });
    return unsubscribe;
  }, [assignmentId, userId]);

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
    void markThreadRead(getBrowserClient(), assignmentId);
  };

  const send = async (body: string) => {
    // A tapped quick reply already arrives as its English value; typed text goes out as typed.
    const supabase = getBrowserClient();
    const msg = await sendMessage(supabase, assignmentId, deliveryId, 'driver', body);
    if (msg) setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
  };

  const sendPhoto = async (file: File) => {
    setPhotoError(null);
    try {
      const msg = await sendPhotoMessage(
        getBrowserClient(),
        assignmentId,
        deliveryId,
        'driver',
        file,
      );
      setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
    } catch (err) {
      setPhotoError(photoErrorMessage(err));
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
          {t('chat.button')}
        </Button>
        {unread > 0 && (
          <span
            aria-label={t('chat.unread', { count: unread })}
            className="pointer-events-none absolute -right-2 -top-2 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-bold leading-none text-white ring-2 ring-background"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </span>

      <Sheet open={open} onClose={() => setOpen(false)} title={t('chat.sheetTitle')}>
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
            quickReplies={quickReplies}
            disabled={!inFlight}
            disabledNotice={t('chat.closedNotice')}
          />
        </div>
      </Sheet>
    </>
  );
}
