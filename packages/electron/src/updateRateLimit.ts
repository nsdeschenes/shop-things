const retrySeconds = /^\d+$/;

// Response metadata only; callers retain their own transport deadlines and body handling.
export function rateLimitRetryAt(
  response: Pick<Response, 'ok' | 'status' | 'headers'>,
  now = Date.now()
): number | null {
  if (
    !(
      (!response.ok && response.headers.has('retry-after')) ||
      response.status === 429 ||
      (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    )
  ) {
    return null;
  }

  const retry = response.headers.get('retry-after');
  const parsed =
    retry && retrySeconds.test(retry)
      ? now + Number(retry) * 1000
      : retry
        ? Date.parse(retry)
        : Number(response.headers.get('x-ratelimit-reset')) * 1000;
  return Number.isFinite(parsed) && parsed > now ? parsed : now + 60000;
}
