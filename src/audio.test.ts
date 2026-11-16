import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInitialized, initialize } from './index';
import { resetSessionId } from './session';
import { getRenderRootForTests, setGeometryChecksForTests, setPaintTimeoutForTests } from './render';

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function until(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function eventBodies(fetchMock: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((call) => String(call[0]).endsWith('/v1/ads/events'))
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>);
}

function stubFetch(requestResponse: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/ads/request')) return jsonResponse(200, requestResponse);
    return jsonResponse(202, { accepted: true, duplicate: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function audioRoot(container: HTMLElement): ShadowRoot {
  const host = container.querySelector<HTMLElement>('[data-naija-ads="audio"]');
  if (!host) throw new Error('audio host not found');
  const root = getRenderRootForTests(host);
  if (!root) throw new Error('audio shadow root not found');
  return root;
}

const LIVE_FILL = {
  fill: true, test: false, impression_id: 'imp_7', ad_type: 'audio', expires_in: 600,
  creative: {
    kind: 'audio', mime_type: 'audio/mpeg', url: 'http://cdn/ad.mp3', duration_ms: 15_000,
    companion_url: 'http://cdn/companion.png', companion_size: '320x50',
  },
  click_url: 'http://adv.example/click',
  render_token: 'atok_1',
};

describe('AudioAd', () => {
  let container: HTMLElement;

  beforeEach(() => {
    resetSessionId();
    setPaintTimeoutForTests(50);
    setGeometryChecksForTests(false);
    document.body.innerHTML = '';
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  });

  afterEach(() => {
    try { getInitialized().destroyAll(); } catch {}
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('test mode: renders the labelled card, plays, and reports started → completed', async () => {
    const fetchMock = stubFetch({
      fill: true, test: true, impression_id: 'imp_1', ad_type: 'audio', expires_in: 600,
    });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'test' });

    const ad = await getInitialized().loadAudio('pl_audio', { container, testAudioDurationMs: 30 });
    const root = audioRoot(container);
    const card = root.querySelector('.naija-audio');
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain('Test companion banner');
    await flush();
    expect(eventBodies(fetchMock as never).some((b) => b.event_type === 'impression')).toBe(true);

    const completed = vi.fn();
    ad.on('completed', completed);
    (card!.querySelector('.naija-audio-btn') as HTMLButtonElement).click();
    await until(() => eventBodies(fetchMock as never).some((b) => b.event_type === 'audio_started'));
    await until(() => eventBodies(fetchMock as never).some((b) => b.event_type === 'audio_completed'));
    expect(completed).toHaveBeenCalledTimes(1);

    ad.destroy();
    expect(container.querySelector('[data-naija-ads="audio"]')).toBeNull();
  });

  it('live: renders the companion banner, attests with the render token, reports playback', async () => {
    const fetchMock = stubFetch(LIVE_FILL);
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    const pending = getInitialized().loadAudio('pl_audio', { container });
    await flush();
    const root = audioRoot(container);
    const companion = root.querySelector('.naija-companion') as HTMLImageElement;
    companion.dispatchEvent(new Event('load'));
    await pending;
    const audio = root.querySelector('audio') as HTMLAudioElement;
    expect(audio?.getAttribute('src')).toBe('http://cdn/ad.mp3');
    expect(companion?.getAttribute('src')).toBe('http://cdn/companion.png');

    audio.dispatchEvent(new Event('playing'));
    audio.dispatchEvent(new Event('ended'));
    await until(() => eventBodies(fetchMock as never).some((b) => b.event_type === 'audio_completed'));

    const types = eventBodies(fetchMock as never).map((b) => b.event_type);
    expect(types).toEqual(['impression', 'audio_started', 'audio_completed']);
    const impression = eventBodies(fetchMock as never).find((b) => b.event_type === 'impression');
    expect(impression?.render_token).toBe('atok_1');

    (root.querySelector('.naija-click') as HTMLButtonElement).click();
    await flush();
    expect(openSpy).toHaveBeenCalledWith('http://adv.example/click', '_blank', 'noopener,noreferrer');
    expect(eventBodies(fetchMock as never).some((b) => b.event_type === 'click')).toBe(true);
  });

  it('pausing before the end claims no completion', async () => {
    const fetchMock = stubFetch(LIVE_FILL);
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    const pending = getInitialized().loadAudio('pl_audio', { container });
    await flush();
    const root = audioRoot(container);
    (root.querySelector('.naija-companion') as HTMLImageElement).dispatchEvent(new Event('load'));
    await pending;
    const audio = root.querySelector('audio') as HTMLAudioElement;

    audio.dispatchEvent(new Event('playing'));
    await flush();
    audio.dispatchEvent(new Event('pause'));
    await flush();

    const types = eventBodies(fetchMock as never).map((b) => b.event_type);
    expect(types).toEqual(['impression', 'audio_started']);
    expect(types).not.toContain('audio_completed');
  });

  it('destroying mid-playback cancels the simulated completion', async () => {
    const fetchMock = stubFetch({
      fill: true, test: true, impression_id: 'imp_1', ad_type: 'audio', expires_in: 600,
    });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'test' });
    const ad = await getInitialized().loadAudio('pl_audio', { container, testAudioDurationMs: 30_000 });

    (audioRoot(container).querySelector('.naija-audio-btn') as HTMLButtonElement).click();
    await flush();
    ad.destroy();
    await flush();

    expect(eventBodies(fetchMock as never).some((b) => b.event_type === 'audio_completed')).toBe(false);
    expect(container.querySelector('[data-naija-ads="audio"]')).toBeNull();
  });

  it('no-fill rejects with code no_fill and the server reason', async () => {
    stubFetch({ fill: false, reason: 'no_campaigns' });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    await expect(getInitialized().loadAudio('pl_audio', { container })).rejects.toMatchObject({
      code: 'no_fill',
      reason: 'no_campaigns',
    });
  });
});
