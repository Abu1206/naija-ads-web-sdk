import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInitialized, initialize, NaijaAdsError } from './index';
import { resetSessionId } from './session';

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubTestFill(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/v1/ads/request')) {
      return jsonResponse(200, { fill: true, test: true, impression_id: 'imp_1', ad_type: 'banner', banner_size: '320x50', expires_in: 600 });
    }
    return jsonResponse(202, { accepted: true, duplicate: false });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('initialize', () => {
  beforeEach(() => {
    resetSessionId();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('validates config and never initializes a broken instance', () => {
    expect(() => initialize({ appId: '', baseUrl: 'http://api.test' })).toThrow(NaijaAdsError);
    expect(() => initialize({ appId: 'app_1', baseUrl: 'not-a-url' })).toThrow(NaijaAdsError);
    expect(() => initialize({ appId: 'app_1', baseUrl: 'http://api.test', mode: 'prod' as never })).toThrow(NaijaAdsError);
    expect(() => getInitialized()).toThrow(/initialize/i);
  });

  it('defaults to test mode — the safe default', async () => {
    const fetchMock = stubTestFill();
    initialize({ appId: 'app_1', baseUrl: 'http://api.test' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    await getInitialized().loadBanner('pl', { container });
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.mode).toBe('test');
  });

  it('re-initializing tears down the previous instance’s ads', async () => {
    stubTestFill();
    const first = initialize({ appId: 'app_1', baseUrl: 'http://api.test' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    await first.loadBanner('pl', { container });
    expect(container.querySelector('.naija-ads-test')).toBeTruthy();

    const second = initialize({ appId: 'app_1', baseUrl: 'http://api.test' });
    expect(container.querySelector('.naija-ads-test')).toBeNull();
    expect(second.sessionId).toBe(first.sessionId); // same page session
  });

  it('destroyAll removes rendered ads and detaches references', async () => {
    stubTestFill();
    const naijaAds = initialize({ appId: 'app_1', baseUrl: 'http://api.test' });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const ad = await naijaAds.loadBanner('pl', { container });
    naijaAds.destroyAll();
    expect(container.querySelector('.naija-ads-test')).toBeNull();
    await expect(ad.show(container)).rejects.toMatchObject({ code: 'destroyed' });
  });
});
