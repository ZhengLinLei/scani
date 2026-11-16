/** Keep OCR requests in capture order while the camera remains available. */
export class CaptureQueue {
  constructor(process, changed = () => {}) {
    this.process = process;
    this.changed = changed;
    this.jobs = [];
    this.running = false;
    this.sequence = 0;
  }

  snapshot() {
    // Expose status only; image blobs stay in the queue until saved or discarded.
    return this.jobs.map(({ id, status, error }) => ({ id, status, error }));
  }

  notify() {
    this.changed(this.snapshot());
  }

  add(payload) {
    this.jobs.push({ id: ++this.sequence, payload, status: 'queued', error: '' });
    this.notify();
    void this.drain();
  }

  retry() {
    const job = this.jobs[0];
    if (job?.status !== 'failed') return;
    job.status = 'queued';
    job.error = '';
    this.notify();
    void this.drain();
  }

  discardFailed() {
    if (this.jobs[0]?.status !== 'failed') return;
    this.jobs.shift();
    this.notify();
    void this.drain();
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length && this.jobs[0].status !== 'failed') {
        const job = this.jobs[0];
        job.status = 'processing';
        this.notify();
        try {
          await this.process(job.payload);
        } catch (error) {
          job.status = 'failed';
          job.error = error instanceof Error ? error.message : 'Could not process this page.';
          this.notify();
          break;
        }
        this.jobs.shift();
        this.notify();
      }
    } finally {
      this.running = false;
    }
  }
}
