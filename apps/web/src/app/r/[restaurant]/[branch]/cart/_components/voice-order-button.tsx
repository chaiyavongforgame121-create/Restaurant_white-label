'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { Mic, Square } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { getSupabaseEnv } from '@favornoms/database/env';
import { useCart } from '@/store/cart';

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: Array<Array<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

interface Action {
  type: 'add' | 'clear';
  menu_item_id?: string;
  quantity?: number;
  notes?: string;
}

/**
 * Voice ordering: tap mic → Web Speech API transcribes → parse-voice-order
 * Edge function maps utterance to menu items → applied to cart.
 *
 * Falls back to a "not supported" message on browsers without SpeechRecognition
 * (notably iOS Safari < 16, Firefox without flag).
 */
export function VoiceOrderButton({ branchId }: { branchId: string }) {
  const params = useParams<{ restaurant: string; branch: string }>();
  const [supported, setSupported] = React.useState<boolean | null>(null);
  const [listening, setListening] = React.useState(false);
  const [transcript, setTranscript] = React.useState('');
  const [processing, setProcessing] = React.useState(false);
  const [explanation, setExplanation] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const addToCart = useCart((s) => s.add);
  const clearCart = useCart((s) => s.clear);
  const recRef = React.useRef<SpeechRecognitionLike | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    setSupported(!!Ctor);
  }, []);

  const start = () => {
    setError(null);
    setExplanation(null);
    setTranscript('');
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language?.startsWith('th') ? 'th-TH' : 'en-US';
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .map((r) => r[0]?.transcript ?? '')
        .join(' ')
        .trim();
      setTranscript(text);
      void process(text);
    };
    rec.onerror = (e) => setError(`speech_${e.error}`);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  };

  const stop = () => {
    recRef.current?.stop();
    setListening(false);
  };

  const process = async (text: string) => {
    if (!text) return;
    setProcessing(true);
    try {
      const supabase = getBrowserClient();
      const { data: session } = await supabase.auth.getSession();
      const accessToken = session.session?.access_token;
      const { url, publishableKey } = getSupabaseEnv();

      const res = await fetch(`${url}/functions/v1/parse-voice-order`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken ?? publishableKey}`,
          apikey: publishableKey,
        },
        body: JSON.stringify({
          transcript: text,
          branch_id: branchId,
          locale: navigator.language?.slice(0, 2),
        }),
      });
      const data = (await res.json()) as {
        actions?: Action[];
        explanation?: string;
        error?: string;
      };
      if (!res.ok || data.error) throw new Error(data.error ?? `http_${res.status}`);

      const actions = data.actions ?? [];
      const menuItemIds = actions
        .filter((a) => a.type === 'add' && a.menu_item_id)
        .map((a) => a.menu_item_id!);
      let itemsById = new Map<string, { id: string; name: string; price: number; image_url: string | null; branch_id: string }>();
      if (menuItemIds.length > 0) {
        const { data: rows } = await supabase
          .from('menu_items')
          .select('id, name, price, image_url, branch_id')
          .in('id', menuItemIds);
        itemsById = new Map((rows ?? []).map((r) => [r.id, r]));
      }

      for (const a of actions) {
        if (a.type === 'clear') clearCart();
        if (a.type === 'add' && a.menu_item_id) {
          const item = itemsById.get(a.menu_item_id);
          if (!item) continue;
          addToCart(
            {
              id: item.id,
              branchId: item.branch_id,
              name: item.name,
              price: Number(item.price),
              imageUrl: item.image_url ?? '/icon.svg',
              categoryId: '',
              description: '',
              isRecommended: false,
              isNew: false,
              dietaryTags: [],
              rating: 0,
              reviewCount: 0,
              prepTimeMinutes: 0,
              calories: 0,
              isActive: true,
            } as never,
            a.quantity ?? 1,
            a.notes,
          );
        }
      }
      setExplanation(data.explanation ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProcessing(false);
    }
  };

  if (supported === false) return null;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium">Voice order</p>
          <p className="text-xs text-muted-foreground">
            {listening ? 'Listening… speak now' : 'Tap and say "Add 2 cheeseburgers, no onions"'}
          </p>
        </div>
        <Button
          variant={listening ? 'danger' : 'gradient'}
          onClick={listening ? stop : start}
          loading={processing}
          disabled={supported === null}
          leftIcon={listening ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        >
          {listening ? 'Stop' : 'Speak'}
        </Button>
      </div>
      {transcript && (
        <p className="rounded-xl bg-muted/50 px-3 py-2 text-sm">
          <span className="text-muted-foreground">You said: </span>
          {transcript}
        </p>
      )}
      {explanation && (
        <p className="rounded-xl bg-success/10 px-3 py-2 text-sm text-success">{explanation}</p>
      )}
      {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
    </Card>
  );
}
