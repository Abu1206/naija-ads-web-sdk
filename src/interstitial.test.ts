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

describe('InterstitialAd', () => {
  beforeEach(() => {
    resetSessionId();
    setPaintTimeoutForTests(50); // jsdom has no media pipeline; skip the long fallback
    document.body.innerHTML = '';
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(requestResponse: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/v1/ads/request')) return jsonResponse(200, requestResponse);
      return jsonResponse(202, { accepted: true, duplicate: false });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('test mode: shows a full-screen overlay, attests the impression, dismisses', async () => {
    const fetchMock = stubFetch({
      fill: true, test: true, impression_id: 'imp_1', ad_type: 'interstitial', expires_in: 600,
    });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'test' });

    const ad = await getInitialized().loadInterstitial('pl_int');
    const dismissed = vi.fn();
    ad.on('dismissed', dismissed);
    await ad.show();

    const overlay = document.querySelector('.naija-ads-overlay');
    expect(overlay).toBeTruthy();
    expect(overlay?.textContent).toContain('Test interstitial');
    await flush();
    expect(eventBodies(fetchMock as never).some((b) => b.event_type === 'impression')).toBe(true);

    (overlay!.querySelector('.naija-ads-close') as HTMLButtonElement).click();
    await flush();
    expect(dismissed).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.naija-ads-overlay')).toBeNull();
  });

  it('live video: impression, then video_started and video_completed in order', async () => {
    const fetchMock = stubFetch({
      fill: true, test: false, impression_id: 'imp_2', ad_type: 'interstitial', expires_in: 600,
      creative: { kind: 'video', mime_type: 'video/mp4', url: 'http://cdn/vid.mp4', duration_ms: 15_000, poster_url: 'http://cdn/poster.jpg' },
      click_url: 'http://adv.example/click',
      render_token: 'tok_1',
    });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });

    const ad = await getInitialized().loadInterstitial('pl_int');
    await ad.show();
    const video = document.querySelector('.naija-ads-overlay video') as HTMLVideoElement;
    expect(video).toBeTruthy();

    video.dispatchEvent(new Event('loadeddata'));
    await flush();
    video.dispatchEvent(new Event('playing'));
    await flush();
    video.dispatchEvent(new Event('ended'));
    await flush();

    const types = eventBodies(fetchMock as never).map((b) => b.event_type);
    expect(types).toEqual(['impression', 'video_started', 'video_completed']);

    ad.destroy();
    expect(document.querySelector('.naija-ads-overlay')).toBeNull();
  });
});
