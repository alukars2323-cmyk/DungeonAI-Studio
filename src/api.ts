import { ApiError } from './apiError';
export { ApiError } from './apiError';

export const STORAGE_MODE: 'browser' | 'local' = import.meta.env.VITE_STORAGE_MODE === 'browser' ? 'browser' : 'local';

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  if (STORAGE_MODE === 'browser') {
    const { browserApi } = await import('./browserApi');
    return browserApi<T>(path, options);
  }
  const response = await fetch(`/api${path}`, options);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === 'object' && body
      ? (body.error?.message || body.error || body.message)
      : body;
    throw new ApiError(typeof message === 'string' && message ? message : `Ошибка сервера: ${response.status}`, response.status);
  }
  return body as T;
}

export function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
