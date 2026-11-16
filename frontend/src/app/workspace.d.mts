export const ACTIVE_SESSION_KEY: string;
export interface ActiveSession { sessionId: string; pageId?: string; }
export function readActiveSession(fallbackId?: string): ActiveSession | null;
export function writeActiveSession(value: ActiveSession | null): boolean;
