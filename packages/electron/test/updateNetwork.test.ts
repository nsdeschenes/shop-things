import {afterEach, expect, test, vi} from 'vitest';

import {requestUpdateBytes} from '../src/updateNetwork.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('rejects insecure redirects, oversized bodies, and more than five redirects', async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  fetcher.mockResolvedValue(
    new Response(null, {status: 302, headers: {location: 'http://example.com/release'}})
  );
  await expect(requestUpdateBytes('https://github.com/release', 64)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockReset().mockImplementation(async () => new Response(new Uint8Array(65)));
  await expect(requestUpdateBytes('https://github.com/release', 64)).rejects.toThrow();
  fetcher
    .mockReset()
    .mockImplementation(
      async () =>
        new Response(null, {status: 302, headers: {location: 'https://github.com/next'}})
    );
  await expect(requestUpdateBytes('https://github.com/release', 64)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(18);
});

test('shares at most two transport retries across the whole release check', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(new Response('ok'))
    .mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', fetcher);
  const budget = {remaining: 2};
  expect(
    new TextDecoder().decode(
      await requestUpdateBytes('https://github.com/release', 64, budget)
    )
  ).toBe('ok');
  await expect(
    requestUpdateBytes('https://github.com/release', 64, budget)
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(4);
});

test('respects rate-limit backoff without transport retries', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(null, {status: 429, headers: {'retry-after': '120'}})
    );
  vi.stubGlobal('fetch', fetcher);
  const before = Date.now();
  await expect(
    requestUpdateBytes('https://github.com/release', 64)
  ).rejects.toMatchObject({code: 'RATE_LIMIT', retryAt: expect.any(Number)});
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(Date.now() - before).toBeLessThan(1000);
});

test('aborts each request after 30 seconds and external shutdown prevents further retries', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
  );
  vi.stubGlobal('fetch', fetcher);
  const timed = requestUpdateBytes('https://github.com/release', 64).catch(
    error => error
  );
  await vi.advanceTimersByTimeAsync(90000);
  expect(await timed).toMatchObject({code: 'NETWORK'});
  expect(fetcher).toHaveBeenCalledTimes(3);
  const controller = new AbortController();
  const stopped = requestUpdateBytes(
    'https://github.com/release',
    64,
    {remaining: 2},
    controller.signal
  ).catch(error => error);
  controller.abort();
  expect(await stopped).toMatchObject({code: 'NETWORK'});
  expect(fetcher).toHaveBeenCalledTimes(4);
});
