import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInitialized, initialize } from './index';
import { resetSessionId } from './session';
import { setPaintTimeoutForTests } from './render';

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function eventBodies(fetchMock: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith('/v1/ads/events'))
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
}

/** fetch mock: /v1/ads/request answered by `requestResponse`, events accepted. */
function stubFetch(requestResponse: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/ads/request')) return jsonResponse(status, requestResponse);
    return jsonResponse(202, { accepted: true, duplicate: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('BannerAd', () => {
  let container: HTMLElement;

  beforeEach(() => {
    resetSessionId();
    setPaintTimeoutForTests(50); // jsdom never fires img load events; skip the long fallback
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    getInitializedSafe()?.destroyAll();
  });

  function getInitializedSafe(): { destroyAll(): void } | null {
    try {
      return getInitialized() as unknown as { destroyAll(): void };
    } catch {
      return null;
    }
  }

  it('test mode: renders the built-in test banner and attests the impression', async () => {
    const fetchMock = stubFetch({
      fill: true, test: true, impression_id: 'imp_1', ad_type: 'banner', banner_size: '320x50', expires_in: 600,
    });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'test' });

    const ad = await getInitialized().loadBanner('pl_banner', { container });
    expect(container.querySelector('.naija-ads-test')).toBeTruthy();
    expect(container.querySelector('.naija-ads-test')?.textContent).toContain('Test banner · 320×50');

    await flush();
    const impression = eventBodies(fetchMock as never).find((b) => b.event_type === 'impression');
    expect(impression).toMatchObject({
      event_type: 'impression',
      impression_id: 'imp_1',
      placement_id: 'pl_banner',
      mode: 'test',
    });
    expect(impression?.render_token).toBeUndefined();

    ad.destroy();
    expect(container.querySelector('.naija-ads-test')).toBeNull();
  });

  it('live: renders the served creative, sends the render token, opens the served click_url', async () => {
    const fetchMock = stubFetch({
      fill: true, test: false, impression_id: 'imp_2', ad_type: 'banner', banner_size: '320x50', expires_in: 600,
      creative: { kind: 'image', mime_type: 'image/png', url: 'http://cdn/img.png', width: 320, height: 50 },
      click_url: 'http://adv.example/click',
      render_token: 'tok_1',
    });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    const ad = await getInitialized().loadBanner('pl_banner', { container });
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('http://cdn/img.png');
    img?.dispatchEvent(new Event('load'));
    await flush();

    const impression = eventBodies(fetchMock as never).find((b) => b.event_type === 'impression');
    expect(impression?.render_token).toBe('tok_1');

    img?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    expect(openSpy).toHaveBeenCalledWith('http://adv.example/click', '_blank', 'noopener,noreferrer');
    const click = eventBodies(fetchMock as never).find((b) => b.event_type === 'click');
    expect(click?.impression_id).toBe('imp_2');

    ad.destroy();
  });

  it('no-fill rejects with code no_fill and the server reason', async () => {
    stubFetch({ fill: false, reason: 'no_campaigns' });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    await expect(getInitialized().loadBanner('pl_banner', { container })).rejects.toMatchObject({
      code: 'no_fill',
      reason: 'no_campaigns',
    });
  });

  it('refresh re-requests and re-attests with the new impression', async () => {
    let requestCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/ads/request')) {
        requestCount += 1;
        const n = requestCount;
        return jsonResponse(200, {
          fill: true, test: false, impression_id: `imp_${n}`, ad_type: 'banner', banner_size: '320x50', expires_in: 600,
          creative: { kind: 'image', mime_type: 'image/png', url: `http://cdn/img_${n}.png` },
          render_token: `tok_${n}`,
        });
      }
      return jsonResponse(202, { accepted: true, duplicate: false });
    });
    vi.stubGlobal('fetch', fetchMock);
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });

    const ad = await getInitialized().loadBanner('pl_banner', { container });
    (container.querySelector('img') as HTMLImageElement).dispatchEvent(new Event('load'));
    await flush();

    await ad.refresh();
    (container.querySelector('img') as HTMLImageElement).dispatchEvent(new Event('load'));
    await flush();

    const impressions = eventBodies(fetchMock as never).filter((b) => b.event_type === 'impression');
    expect(impressions.map((b) => b.impression_id)).toEqual(['imp_1', 'imp_2']);
    expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('http://cdn/img_2.png');
    ad.destroy();
  });

  it('rejects refresh intervals that would hurt viewability', async () => {
    stubFetch({ fill: true, test: true, impression_id: 'imp_1', ad_type: 'banner', expires_in: 600 });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'test' });
    await expect(getInitialized().loadBanner('pl', { container, refreshIntervalMs: 1000 })).rejects.toMatchObject({
      code: 'invalid_config',
    });
  });

  it('rejects unknown placements with the server code (R10 diagnostics)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404, { error: { code: 'unknown_placement', message: 'unknown app_id or placement_id' } })));
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    await expect(getInitialized().loadBanner('pl_banner', { container })).rejects.toMatchObject({
      code: 'unknown_placement',
      message: expect.stringContaining('dashboard'),
    });
  });
});
