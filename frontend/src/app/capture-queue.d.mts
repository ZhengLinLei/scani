export interface CaptureJob {
  id: number;
  status: 'queued' | 'processing' | 'failed';
  error: string;
}
export class CaptureQueue<T> {
  constructor(process: (payload: T) => Promise<void>, changed?: (jobs: CaptureJob[]) => void);
  snapshot(): CaptureJob[];
  add(payload: T): void;
  retry(): void;
  discardFailed(): void;
}
