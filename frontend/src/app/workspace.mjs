export const ACTIVE_SESSION_KEY = 'scani-active-session';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function readActiveSession(fallbackId) {
  try {
    const stored = localStorage.getItem(ACTIVE_SESSION_KEY);
    const value = stored === null && idPattern.test(fallbackId || '')
      ? { sessionId: fallbackId } : JSON.parse(stored || 'null');
    if (!value || !idPattern.test(value.sessionId || '')) return null;
    return {
      sessionId: value.sessionId,
      ...(idPattern.test(value.pageId || '') ? { pageId: value.pageId } : {})
    };
  } catch {
    return null;
  }
}

export function writeActiveSession(value) {
  try {
    // Explicit null prevents a new workspace from reopening the latest library item.
    localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
