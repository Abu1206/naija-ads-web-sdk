import { uuid } from './uuid';

/**
 * One stable session_id per page session (spec §13). The server scopes
 * frequency caps, rate limits and reward tokens to it, so it must persist
 * across reloads within the tab but never across sessions.
 */
const STORAGE_KEY = 'naija_ads_session_id';
const MAX_LEN = 128; // server rejects longer ids (AGENTS.md: checkID)

let memoryFallback: string | null = null;

function safeStorage(): Storage | null {
  try {
    const store = globalThis.sessionStorage;
    if (!store) return null;
    // Probing matters: some privacy modes throw on access rather than return null.
    store.getItem(STORAGE_KEY);
    return store;
  } catch {
    return null;
  }
}

/** Returns the current session id, creating and persisting one if absent. */
export function getSessionId(): string {
  const store = safeStorage();
  try {
    const existing = store?.getItem(STORAGE_KEY);
    if (existing && existing.length > 0 && existing.length <= MAX_LEN) return existing;
  } catch {
    // fall through to creation
  }
  const id = memoryFallback ?? uuid();
  memoryFallback = id;
  try {
    store?.setItem(STORAGE_KEY, id);
  } catch {
    // No storage available (sandboxed iframe): memory-only keeps serving working.
  }
  return id;
}

/** Forces a fresh session id. Intended for tests and explicit session resets. */
export function resetSessionId(): string {
  memoryFallback = null;
  const store = safeStorage();
  try {
    store?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return getSessionId();
}
