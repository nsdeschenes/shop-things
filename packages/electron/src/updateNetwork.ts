import {rateLimitRetryAt} from './updateRateLimit.js';

export class UpdateNetworkError extends Error {
  constructor(
    public readonly code: 'NETWORK' | 'RATE_LIMIT',
    public readonly retryAt?: number
  ) {
    super(
      code === 'RATE_LIMIT'
        ? 'The release service has limited requests.'
        : 'Could not check releases.'
    );
  }
}

export async function requestUpdateBytes(
  url: string,
  limit: number,
  retryBudget = {remaining: 2},
  signal?: AbortSignal
): Promise<Uint8Array> {
  // A request, redirects and its response body share one deadline.
  while (true) {
    const controller = new AbortController();
    function abort() {
      controller.abort();
    }

    if (signal?.aborted) {
      throw new UpdateNetworkError('NETWORK');
    }

    signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => controller.abort(), 30000);
    let response: Response | null = null;
    try {
      let current = url;
      for (let redirects = 0; ; redirects++) {
        const target = new URL(current);
        if (target.protocol !== 'https:' || target.username || target.password) {
          throw new Error('Release transport requires HTTPS.');
        }

        response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'Shop-Things-Updater',
          },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          break;
        }

        await response.body?.cancel();
        const location = response.headers.get('location');
        if (redirects >= 5 || !location) {
          throw new Error('Release redirect limit exceeded.');
        }

        current = new URL(location, current).href;
      }

      const retryAt = rateLimitRetryAt(response);
      if (retryAt !== null) {
        throw new UpdateNetworkError('RATE_LIMIT', retryAt);
      }

      if (!response.ok || !response.body) {
        throw new Error('Release request failed.');
      }

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > limit) {
        throw new Error('Release response is too large.');
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) {
          break;
        }

        length += item.value.byteLength;
        if (length > limit) {
          await reader.cancel();
          throw new Error('Release response is too large.');
        }

        chunks.push(item.value);
      }

      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }

      return bytes;
    } catch (error) {
      await response?.body?.cancel().catch(() => {});
      if (error instanceof UpdateNetworkError) {
        throw error;
      }

      if (signal?.aborted || retryBudget.remaining-- <= 0) {
        throw new UpdateNetworkError('NETWORK');
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      controller.abort();
      clearTimeout(timer);
    }
  }
}
