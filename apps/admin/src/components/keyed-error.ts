/**
 * Errors the upload components show, as message keys rather than English sentences.
 *
 * A helper that runs outside React (canvas work, storage uploads) cannot call a translation hook,
 * so it throws a KeyedError; the component that shows it translates the key at render. Raw text
 * from Supabase Storage never reaches a merchant: it is mapped to a known message and kept for
 * the console only.
 */

export type MessageValues = Record<string, string | number>;

/** A message to show, as a key from the catalogue root (e.g. 'errors.uploadFailed'). */
export interface MessageRef {
  key: string;
  values?: MessageValues;
}

export class KeyedError extends Error {
  readonly key: string;
  readonly values: MessageValues | undefined;
  /** The underlying error or raw server text — for logs, never for display. */
  readonly detail: unknown;

  constructor(key: string, values?: MessageValues, detail?: unknown) {
    super(key);
    this.name = 'KeyedError';
    this.key = key;
    this.values = values;
    this.detail = detail;
  }
}

interface StorageErrorLike {
  message?: string;
  status?: number;
  statusCode?: string;
}

export type StorageUploadErrorKey =
  | 'errors.fileTooLarge'
  | 'errors.fileTypeNotAllowed'
  | 'errors.permissionDenied'
  | 'errors.network'
  | 'errors.uploadFailed';

/** Which shared message fits a failed Storage upload. Unknown failures get the generic upload one. */
export function storageUploadErrorKey(error: StorageErrorLike): StorageUploadErrorKey {
  const code = `${error.statusCode ?? ''} ${error.status ?? ''}`;
  const message = error.message ?? '';
  if (/\b413\b|EntityTooLarge/i.test(code) || /maximum allowed size|too large/i.test(message)) {
    return 'errors.fileTooLarge';
  }
  if (/\b415\b|InvalidMimeType/i.test(code) || /mime type/i.test(message)) {
    return 'errors.fileTypeNotAllowed';
  }
  if (/\b40[13]\b|AccessDenied|Unauthorized/i.test(code) || /row-level security|unauthori[sz]ed/i.test(message)) {
    return 'errors.permissionDenied';
  }
  if (/failed to fetch|network|load failed/i.test(message)) return 'errors.network';
  return 'errors.uploadFailed';
}

export function storageUploadError(error: StorageErrorLike): KeyedError {
  return new KeyedError(storageUploadErrorKey(error), undefined, error);
}

/**
 * The message to show for whatever a catch block caught. Anything that is not a KeyedError is an
 * unexpected failure whose text may be raw browser or server wording: it is logged and replaced
 * with the generic message.
 */
export function errorMessageRef(error: unknown): MessageRef {
  if (error instanceof KeyedError) {
    if (error.detail !== undefined) console.error(error.detail);
    return error.values ? { key: error.key, values: error.values } : { key: error.key };
  }
  console.error(error);
  return { key: 'errors.generic' };
}
