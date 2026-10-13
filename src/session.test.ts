import { beforeEach, describe, expect, it } from 'vitest';
import { getSessionId, resetSessionId } from './session';

describe('session id', () => {
  beforeEach(() => {
    resetSessionId();
  });

  it('creates one id per page session and persists it in sessionStorage', () => {
    const first = getSessionId();
    expect(first).toMatch(/[0-9a-f-]{36}/);
    expect(getSessionId()).toBe(first);
    expect(sessionStorage.getItem('naija_ads_session_id')).toBe(first);
  });

  it('resetSessionId mints a fresh id', () => {
    const first = getSessionId();
    const second = resetSessionId();
    expect(second).not.toBe(first);
    expect(getSessionId()).toBe(second);
  });

  it('replaces an oversized or empty stored id instead of sending it', () => {
    sessionStorage.setItem('naija_ads_session_id', 'x'.repeat(200));
    const id = getSessionId();
    expect(id.length).toBeLessThanOrEqual(128);
    expect(id).not.toBe('x'.repeat(200));
    sessionStorage.setItem('naija_ads_session_id', '');
    expect(getSessionId().length).toBeGreaterThan(0);
  });
});
