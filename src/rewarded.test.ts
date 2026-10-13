import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInitialized, initialize } from './index';
import type { RewardOutcome } from './rewarded';
import { resetSessionId } from './session';
import { setPaintTimeoutForTests } from './render';

async function until(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

function stubFetch(requestResponse: unknown, eventResponse: unknown = { accepted: true, duplicate: false }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/ads/request')) return jsonResponse(200, requestResponse);
    return jsonResponse(202, eventResponse);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const LIVE_FILL = {
  fill: true, test: false, impression_id: 'imp_9', ad_type: 'rewarded', expires_in: 600,
  creative: { kind: 'video', mime_type: 'video/mp4', url: 'http://cdn/reward.mp4', duration_ms: 30_000, poster_url: 'http://cdn/poster.jpg' },
  render_token: 'rtok_1',
};

describe('RewardedAd', () => {
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

  it('test mode: simulated watch fires started → completed and confirms locally', async () => {
    const fetchMock = stubFetch({
      fill: true, test: true, impression_id: 'imp_1', ad_type: 'rewarded', expires_in: 600,
    });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'test' });
    const ad = await getInitialized().loadRewarded('pl_rew', { testVideoDurationMs: 30 });

    const outcome = await ad.show();
    expect(outcome).toEqual({ status: 'confirmed', impressionId: 'imp_1', test: true });
    expect(outcome.rewardToken).toBeUndefined(); // real tokens only exist in live mode

    const types = eventBodies(fetchMock as never).map((b) => b.event_type);
    expect(types).toEqual(['impression', 'video_started', 'video_completed']);
    expect(document.querySelector('.naija-ads-overlay')).toBeNull();
  });

  it('live: the server decision is the outcome — confirmed with a reward token', async () => {
    const fetchMock = stubFetch(LIVE_FILL, {
      accepted: true, duplicate: false,
      reward: { status: 'confirmed', reward_token: 'reward_tok', impression_id: 'imp_9' },
    });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    const ad = await getInitialized().loadRewarded('pl_rew');
    const outcomes: RewardOutcome[] = [];
    ad.on('rewarded', (o: unknown) => outcomes.push(o as RewardOutcome));

    const pending = ad.show();
    await flush();
    const video = document.querySelector('.naija-ads-overlay video') as HTMLVideoElement;
    video.dispatchEvent(new Event('loadeddata'));
    await flush();
    video.dispatchEvent(new Event('playing'));
    await flush();
    video.dispatchEvent(new Event('ended'));

    const outcome = await pending;
    expect(outcome).toEqual({ status: 'confirmed', rewardToken: 'reward_tok', impressionId: 'imp_9', test: false });
    expect(outcomes).toHaveLength(1);
    await until(() => eventBodies(fetchMock as never).some((b) => b.event_type === 'impression'));
    const impression = eventBodies(fetchMock as never).find((b) => b.event_type === 'impression');
    expect(impression?.render_token).toBe('rtok_1');
  });

  it('live: a rejected completion surfaces the server reason, no token', async () => {
    stubFetch(LIVE_FILL, {
      accepted: true, duplicate: false,
      reward: { status: 'rejected', reason: 'watched_too_little', impression_id: 'imp_9' },
    });
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    const ad = await getInitialized().loadRewarded('pl_rew');

    const pending = ad.show();
    await flush();
    const video = document.querySelector('.naija-ads-overlay video') as HTMLVideoElement;
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('ended'));
    const outcome = await pending;
    expect(outcome.status).toBe('rejected');
    expect(outcome.reason).toBe('watched_too_little');
    expect(outcome.rewardToken).toBeUndefined();
  });

  it('autoplay blocked: the player can dismiss, no completion is claimed', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('autoplay blocked'));
    const fetchMock = stubFetch(LIVE_FILL);
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    const ad = await getInitialized().loadRewarded('pl_rew');

    const pending = ad.show();
    await flush();
    await flush();
    const close = document.querySelector('.naija-ads-close') as HTMLButtonElement;
    expect(close.disabled).toBe(false); // unlocked when autoplay was blocked
    close.click();

    const outcome = await pending;
    expect(outcome.status).toBe('dismissed');
    expect(eventBodies(fetchMock as never).some((b) => b.event_type === 'video_completed')).toBe(false);
  });

  it('video error: resolves rejected with video_error', async () => {
    stubFetch(LIVE_FILL);
    initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'live' });
    const ad = await getInitialized().loadRewarded('pl_rew');

    const pending = ad.show();
    await flush();
    (document.querySelector('.naija-ads-overlay video') as HTMLVideoElement).dispatchEvent(new Event('error'));
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'video_error' });
  });
});
