import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from './client';
import { NaijaAdsError } from './errors';

function jsonResponse(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const noDelay = async () => {};

function makeClient(fetchImpl: typeof fetch, includeClientTime = false): ApiClient {
  return new ApiClient(
    { appId: 'app_1', baseUrl: 'http://api.test/', mode: 'test', includeClientTime },
    fetchImpl,
    noDelay,
  );
}

function requestMock(handler: (url: string, body: Record<string, unknown>) => Response | Promise<Response>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    return handler(String(input), body);
  }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}

describe('ApiClient.requestAd', () => {
  it('maps a fill response to the public shape and sends the spec §13 body', async () => {
    const fetchMock = requestMock((url, body) => {
      expect(url).toBe('http://api.test/v1/ads/request');
      expect(body).toMatchObject({
        app_id: 'app_1',
        placement_id: 'pl_1',
        ad_type: 'banner',
        session_id: 'sess_1',
        mode: 'test',
        context: { slot_width_dp: 320, slot_height_dp: 100, device_type: 'phone' },
      });
      return jsonResponse(200, {
        fill: true,
        test: true,
        impression_id: 'imp_1',
        ad_type: 'banner',
        banner_layout: 'anchored',
        banner_size: '320x50',
        expires_in: 600,
        creative: { kind: 'image', mime_type: 'image/png', url: 'http://cdn/img.png', width: 640, height: 100, pixel_ratio: 2 },
        click_url: 'http://adv.example/go',
        render_token: 'tok_1',
      });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const response = await client.requestAd({ placementId: 'pl_1', adType: 'banner', sessionId: 'sess_1', slotWidthDp: 320, slotHeightDp: 100, deviceType: 'phone' });
    expect(response).toMatchObject({
      fill: true,
      test: true,
      impressionId: 'imp_1',
      bannerLayout: 'anchored',
      bannerSize: '320x50',
      expiresIn: 600,
      clickUrl: 'http://adv.example/go',
      renderToken: 'tok_1',
    });
    expect(response.creative?.url).toBe('http://cdn/img.png');
    expect(response.creative?.mimeType).toBe('image/png');
    expect(response.creative?.pixelRatio).toBe(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  });

  it('returns a no-fill as a response, never an error', async () => {
    const fetchMock = requestMock(() => jsonResponse(200, { fill: false, reason: 'app_not_approved' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const response = await client.requestAd({ placementId: 'pl_1', adType: 'banner', sessionId: 'sess_1' });
    expect(response).toMatchObject({ fill: false, reason: 'app_not_approved' });
  });

  it('maps backend error codes and adds fix-it hints (R10)', async () => {
    const fetchMock = requestMock(() => jsonResponse(404, { error: { code: 'unknown_placement', message: 'unknown app_id or placement_id' } }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(client.requestAd({ placementId: 'nope', adType: 'banner', sessionId: 's' })).rejects.toMatchObject({
      code: 'unknown_placement',
      message: expect.stringContaining('dashboard'),
    });
  });

  it('reads Retry-After into retryAfterMs on rate limits', async () => {
    const fetchMock = requestMock(() => jsonResponse(429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'Retry-After': '60' }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const err = await client.requestAd({ placementId: 'pl', adType: 'banner', sessionId: 's' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NaijaAdsError);
    expect((err as NaijaAdsError).retryAfterMs).toBe(60_000);
  });

  it('passes client_ts through only when the caller set it (ads add it per config)', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = requestMock((_url, body) => {
      bodies.push(body);
      return jsonResponse(202, { accepted: true, duplicate: false });
    });
    const base = { event_id: 'e1', event_type: 'impression', impression_id: 'i', placement_id: 'p', session_id: 's', mode: 'test' };
    await makeClient(fetchMock as unknown as typeof fetch).sendEvent(base);
    await makeClient(fetchMock as unknown as typeof fetch).sendEvent({ ...base, client_ts: new Date().toISOString() });
    expect(bodies[0]?.client_ts).toBeUndefined();
    expect(typeof bodies[1]?.client_ts).toBe('string');
  });
});

describe('ApiClient.sendEvent retries', () => {
  it('retries a transient 503 with the SAME event_id (server dedupes)', async () => {
    const seenIds: string[] = [];
    let calls = 0;
    const fetchMock = requestMock((_url, body) => {
      calls += 1;
      seenIds.push(String(body.event_id));
      if (calls === 1) return jsonResponse(503, { error: { code: 'retry', message: 'Try again shortly.' } });
      return jsonResponse(202, { accepted: true, duplicate: false });
    });
    const client = makeClient(fetchMock as unknown as typeof fetch);
    const ack = await client.sendEvent({ event_id: 'evt_1', event_type: 'impression', impression_id: 'i', placement_id: 'p', session_id: 's', mode: 'test' });
    expect(ack.accepted).toBe(true);
    expect(calls).toBe(2);
    expect(seenIds).toEqual(['evt_1', 'evt_1']);
  });

  it('gives up after three attempts on a persistent 503 retry', async () => {
    const fetchMock = requestMock(() => jsonResponse(503, { error: { code: 'retry', message: 'Try again shortly.' } }));
    const client = makeClient(fetchMock as unknown as typeof fetch);
    await expect(
      client.sendEvent({ event_id: 'e', event_type: 'click', impression_id: 'i', placement_id: 'p', session_id: 's', mode: 'test' }),
    ).rejects.toMatchObject({ code: 'retry' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('wraps network failures as code network after retries', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const client = makeClient(fetchMock);
    await expect(
      client.sendEvent({ event_id: 'e', event_type: 'click', impression_id: 'i', placement_id: 'p', session_id: 's', mode: 'test' }),
    ).rejects.toMatchObject({ code: 'network' });
  });
});
