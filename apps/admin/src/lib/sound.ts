/* The back office's sounds now live in packages/ui (src/lib/sound.ts), shared with the FavorGO
 * rider app so both learn the same Web Audio lessons once. This path stays so the kitchen board
 * and the dashboard keep importing '@/lib/sound' unchanged. */
export {
  UNLOCK_EVENTS,
  audioContext,
  audioRunning,
  hadUserGesture,
  playChime,
  speak,
  speechAvailable,
  speechLang,
  unlockAudio,
  type Chime,
} from '@favornoms/ui';
