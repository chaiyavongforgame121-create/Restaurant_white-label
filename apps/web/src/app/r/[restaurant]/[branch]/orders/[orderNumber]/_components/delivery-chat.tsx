'use client';

import * as React from 'react';
import { MessageCircle } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  chatAttachmentErrorMessage,
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

const CUSTOMER_QUICK_REPLIES = ['Where are you?', 'Leave it at the door', 'Coming down now'];

const ACTIVE_STATUSES = ['assigned', 'picked_up', 'in_transit'];

interface Props {
  /** delivery_assignments.id — the live rider's turn, and the thread key. */
  assignmentId: string;
  /** delivery_messages.delivery_id is NOT NULL and is what the merchant's audit joins on. */
  deliveryId: string;
  deliveryStatus: string;
  /**
   * Turns that have already ended on this order, oldest first. The diner was a party to those
   * conversations, so they keep them — read-only, and clearly labelled as somebody else's.
   * The rider-side gate is the privacy fix; this side is the diner's own record.
   */
  pastAssignmentIds?: string[];
}

/** Customer side of the chat for the CURRENT rider's turn. Hidden for guests (no session —
 * RLS has no identity to authorize). */
export function DeliveryChat({
  assignmentId,
  deliveryId,
  deliveryStatus,
  pastAssignmentIds = [],
}: Props) {
  const [open, setOpen] = React.useState(false);
  const [userId, setUserId] = React.useState<string | null>(null);
  const [authChecked, setAuthChecked] = React.useState(false);
  const [messages, setMessages] = React.useState<DeliveryMessage[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const [photoError, setPhotoError] = React.useState<string | null>(null);
  const [archive, setArchive] = React.useState<DeliveryMessage[] | null>(null);
  const [archiveError, setArchiveError] = React.useState<string | null>(null);
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
    // A rider change must not leave the previous rider's bubbles on screen while the new
    // thread loads.
    setMessages([]);
    setUnread(0);
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
  const unsignedKey = [...(archive ?? []), ...messages]
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
    const supabase = getBrowserClient();
    const msg = await sendMessage(supabase, assignmentId, deliveryId, 'customer', body);
    if (msg) setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
  };

  const sendPhoto = async (file: File) => {
    setPhotoError(null);
    try {
      const msg = await sendPhotoMessage(
        getBrowserClient(),
        assignmentId,
        deliveryId,
        'customer',
        file,
      );
      setMessages((curr) => (curr.some((m) => m.id === msg.id) ? curr : [...curr, msg]));
    } catch (err) {
      setPhotoError(chatAttachmentErrorMessage(err));
      // Rethrow so the thread marks the optimistic bubble failed and offers the retry.
      throw err;
    }
  };

  // Lazy on purpose: most orders never change rider, and the diner who does open this is
  // asking one question — "what did the last one say?" — which is worth a round trip then.
  const pastKey = pastAssignmentIds.join(',');
  const loadArchive = async () => {
    if (archive || !pastKey) return;
    setArchiveError(null);
    try {
      const supabase = getBrowserClient();
      const pages = await Promise.all(
        pastKey.split(',').map((id) => listMessages(supabase, id)),
      );
      setArchive(pages.flat().sort((a, b) => a.created_at.localeCompare(b.created_at)));
    } catch {
      setArchiveError('Could not load the earlier conversation.');
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

      <Sheet open={open} onClose={() => setOpen(false)} title="Chat with your driver">
        <div className="flex h-[60vh] flex-col">
          {pastAssignmentIds.length > 0 && (
            <details
              className="shrink-0 border-b border-border pb-2"
              onToggle={(e) => {
                if (e.currentTarget.open) void loadArchive();
              }}
            >
              <summary className="focus-ring cursor-pointer rounded-lg px-1 py-2 text-xs font-semibold text-muted-foreground">
                Earlier, with a previous rider ({pastAssignmentIds.length})
              </summary>
              {archiveError ? (
                <p role="alert" className="px-1 pb-2 text-xs text-danger">
                  {archiveError}
                </p>
              ) : (
                <div className="h-48">
                  <ChatThread
                    messages={(archive ?? []).map((m) => ({
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
                    onSend={() => {}}
                    disabled
                    disabledNotice="That rider is no longer on your order."
                    emptyNotice={archive ? 'Nothing was said.' : 'Loading…'}
                  />
                </div>
              )}
            </details>
          )}
          <div className="min-h-0 flex-1">
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
              quickReplies={CUSTOMER_QUICK_REPLIES}
              disabled={!inFlight}
              disabledNotice="Chat closes when the delivery ends."
            />
          </div>
        </div>
      </Sheet>
    </>
  );
}
