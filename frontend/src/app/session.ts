export type ExportFormat = 'txt' | 'pdf';
export type ScanState = 'idle' | 'aligning' | 'processing' | 'captured' | 'finished';

export interface Page {
  id: string;
  text: string;
  confidence: number;
  captureCount?: number;
  textEdited?: boolean;
  blank?: boolean;
  aiStatus?: 'repaired' | 'failed';
  aiError?: string;
  createdAt: string;
}

export interface Session {
  id: string;
  name: string;
  format: ExportFormat;
  createdAt: string;
  finished: boolean;
  pages: Page[];
}

export const LIBRARY_KEY = 'scani-library';
export const LIBRARY_LIMIT = 100;

export function readLibrary(): Session[] {
  try {
    const saved = JSON.parse(localStorage.getItem(LIBRARY_KEY) || '[]');
    if (!Array.isArray(saved)) {
      return [];
    }

    return saved.filter(isStoredSession).slice(0, LIBRARY_LIMIT);
  } catch {
    // Storage may be unavailable or contain data from an interrupted write.
    return [];
  }
}

function isStoredSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const session = value as Partial<Session>;
  return (
    typeof session.id === 'string' &&
    typeof session.name === 'string' &&
    Array.isArray(session.pages)
  );
}

/** Store session links and page metadata; OCR text stays on the server. */
export function sessionMetadata(session: Session): Session {
  return {
    ...session,
    pages: session.pages.map((page) => ({ ...page, text: '' }))
  };
}
