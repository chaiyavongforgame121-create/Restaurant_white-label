import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyedError, errorMessageRef, storageUploadError, storageUploadErrorKey } from './keyed-error';

describe('storageUploadErrorKey', () => {
  it('maps an oversize upload', () => {
    expect(storageUploadErrorKey({ statusCode: '413', message: 'The object exceeded the maximum allowed size' })).toBe(
      'errors.fileTooLarge',
    );
  });

  it('maps a refused file type', () => {
    expect(storageUploadErrorKey({ statusCode: '415', message: 'mime type image/gif is not supported' })).toBe(
      'errors.fileTypeNotAllowed',
    );
  });

  it('maps an RLS refusal', () => {
    expect(storageUploadErrorKey({ statusCode: '403', message: 'new row violates row-level security policy' })).toBe(
      'errors.permissionDenied',
    );
  });

  it('maps a dropped connection', () => {
    expect(storageUploadErrorKey({ message: 'Failed to fetch' })).toBe('errors.network');
  });

  it('falls back to the generic upload message', () => {
    expect(storageUploadErrorKey({ statusCode: '500', message: 'internal' })).toBe('errors.uploadFailed');
  });
});

describe('errorMessageRef', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes a keyed error through with its values', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errorMessageRef(new KeyedError('shell.x', { min: 192 }))).toEqual({ key: 'shell.x', values: { min: 192 } });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs the raw storage error and never returns its text', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = { statusCode: '403', message: 'new row violates row-level security policy' };
    expect(errorMessageRef(storageUploadError(raw))).toEqual({ key: 'errors.permissionDenied' });
    expect(log).toHaveBeenCalledWith(raw);
  });

  it('replaces an unexpected error with the generic message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errorMessageRef(new Error('duplicate key value violates unique constraint'))).toEqual({
      key: 'errors.generic',
    });
    expect(log).toHaveBeenCalled();
  });
});
