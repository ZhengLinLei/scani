import { Component, ElementRef, ViewChild, signal, computed, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { analyzeFrame, CaptureGate, MAX_MOTION, Analysis, Crop } from './capture.mjs';
import { request, ApiError } from './api';
import { readActiveSession, writeActiveSession } from './workspace.mjs';
import { IconComponent } from './icon';
import { GuideComponent, GUIDE_SEEN_KEY } from './guide';
import { requestCamera, configureCamera, capturePage } from './camera';
import { CaptureQueue, CaptureJob } from './capture-queue.mjs';
import { preparePhoto } from './photo';
import {
  Page,
  Session,
  ScanState,
  ExportFormat,
  LIBRARY_KEY,
  LIBRARY_LIMIT,
  readLibrary,
  sessionMetadata
} from './session';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent, GuideComponent],
  templateUrl: './app.html',
  host: { '(document:keydown)': 'onKey($event)', '(window:beforeunload)': 'beforeUnload($event)' }
})
export class AppComponent implements OnDestroy {
  @ViewChild('video', { static: true }) video!: ElementRef<HTMLVideoElement>;

  state = signal<ScanState>('idle');
  session = signal<Session | null>(null);
  library = signal<Session[]>(readLibrary());
  selected = signal(0);
  text = signal('');
  error = signal('');
  busy = signal(false);
  online = signal(false);
  progress = signal(0);
  ocrProgress = signal(0);
  captureJobs = signal<CaptureJob[]>([]);
  pending = computed(() => this.captureJobs().length);
  failedCapture = computed(() => this.captureJobs().find((job) => job.status === 'failed'));
  ocrStatus = signal('Preparing text recognition');
  quality = signal<Analysis | null>(null);
  cameraAspect = signal('4 / 3');
  hasCamera = signal(false);
  photoMode = signal(false);
  photoPreview = signal('');
  draggingPhoto = signal(false);
  private dragDepth = 0;
  canUploadPhoto = computed(() => !this.busy() && this.state() !== 'processing' &&
    (!this.session()?.finished || !!this.replacementPage()) &&
    (!!this.replacementPage() || this.count() + this.pending() < 100));
  cameraList = signal<MediaDeviceInfo[]>([]);
  cameraId = signal('');
  tips = signal(false);
  replacementPage = signal<string | undefined>(undefined);
  merging = signal(false);
  retakeNumber = computed(() => {
    const id = this.replacementPage();
    return id ? (this.session()?.pages.findIndex((page) => page.id === id) ?? -1) + 1 : 0;
  });

  name = 'Untitled scan';
  format: ExportFormat = 'txt';
  accuracy: 'high' | 'fast' = 'high';
  aiPowered = false;

  setAiPowered(enabled: boolean) {
    this.aiPowered = enabled;
    try { localStorage.setItem('scani-ai-powered', String(enabled)); } catch {}
  }

  async repairText() {
    if (this.busy() || this.active() || this.pending() || !this.page() || !this.aiPowered) return;
    if (this.dirty()) {
      this.error.set('Save your text corrections before continuing. Saved corrections are protected from AI repair.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const session = await request<Session>(`/sessions/${this.session()!.id}/pages/${this.page()!.id}/repair`, 'POST');
      this.remember(session);
      this.loadPage(this.selected());
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  page = computed(() => this.session()?.pages[this.selected()]);
  dirty = computed(() => !!this.page() && this.text() !== this.page()?.text);
  count = computed(() => this.session()?.pages.length || 0);
  active = computed(() => ['aligning', 'processing'].includes(this.state()));

  alignmentMessage = computed(() => {
    const quality = this.quality();
    if (!quality?.lit) {
      return 'Find even, natural light';
    }
    if (!quality.sharp) {
      return 'Move closer until text is clear';
    }
    if (quality.motion >= MAX_MOTION) {
      return 'Hold the page steady';
    }
    return 'Looking good. Hold still…';
  });

  actionTitle = computed(() => {
    if (this.replacementPage()) return this.merging() ? `Improving text on page ${this.retakeNumber()}.` : `Rescanning page ${this.retakeNumber()}.`;
    if (this.session()?.finished && this.pending()) return 'Processing your capture…';
    switch (this.state()) {
      case 'captured':
        if (this.photoMode()) return this.error() ? 'Ready to try again?' : 'Photo captured. Ready for the next.';
        return this.error() ? 'Ready to try again?' : !this.hasCamera() ? 'Your session is ready to resume.' : 'Photo captured. Turn to the next.';
      case 'finished':
        return 'Your session is complete.';
      case 'processing':
        return 'Taking your photo…';
      case 'aligning':
        return 'Keep your page inside the corners.';
      default:
        return 'Ready when you are.';
    }
  });

  actionHint = computed(() => {
    if (this.replacementPage()) return this.merging()
      ? 'Capture the same full page again. Its readings will be combined automatically.'
      : 'The original stays saved until the new scan is ready.';
    if (this.session()?.finished && this.pending()) return 'Your updated download will be ready when processing finishes.';
    if (this.state() === 'captured') {
      if (this.photoMode()) return 'Choose Next photo or drop another image. Text recognition continues in the background.';
      return this.hasCamera() ? 'Press Next page or upload a photo.' : 'Upload another photo or resume scanning with the camera.';
    }
    if (this.state() === 'finished') {
      return 'Start a new session to keep scanning.';
    }
    return 'Use your camera or upload a JPEG, PNG or WebP photo.';
  });

  private captureQueue = new CaptureQueue<{ sessionId: string; blob: Blob; captureId: string; accuracy: 'high' | 'fast'; ai: boolean; replaceId?: string; mergeId?: string }>(
    async ({ sessionId, blob, captureId, accuracy, ai, replaceId, mergeId }) => {
      this.ocrProgress.set(0);
      this.ocrStatus.set('Preparing text recognition');
      const query = new URLSearchParams({ captureId, accuracy, ai: String(ai) });
      if (replaceId) query.set('replace', replaceId);
      if (mergeId) query.set('merge', mergeId);
      const session = await request<Session>(`/sessions/${sessionId}/pages?${query}`, 'POST', blob);
      const index = session.pages.findIndex((page) => page.id === (mergeId || captureId));
      this.remember(session);
      this.loadPage(Math.max(0, index));
      if (session.finished) this.socket?.close();
    },
    (jobs) => this.captureJobs.set(jobs)
  );

  retryCapture() {
    this.captureQueue.retry();
  }

  discardFailedCapture() {
    this.captureQueue.discardFailed();
  }

  private stream?: MediaStream;
  private socket?: WebSocket;
  private inspectionTimer?: ReturnType<typeof setInterval>;
  private gate = new CaptureGate();
  private previousFrame?: Uint8Array;
  private analysisCanvas = document.createElement('canvas');

  constructor() {
    try { this.aiPowered = localStorage.getItem('scani-ai-powered') === 'true'; } catch {}
    try { this.tips.set(localStorage.getItem(GUIDE_SEEN_KEY) !== 'true'); } catch {}
    fetch('/api/health')
      .then((response) => this.online.set(response.ok))
      .catch(() => this.online.set(false));
    void this.restoreSession();
  }

  private persistActiveSession() {
    const session = this.session();
    if (!writeActiveSession(session ? { sessionId: session.id, pageId: this.page()?.id } : null)) {
      this.error.set('Browser storage is unavailable. Keep this tab open to retain access to the session.');
    }
  }

  private async restoreSession() {
    const saved = readActiveSession(this.library()[0]?.id);
    if (!saved) return;
    this.busy.set(true);
    try {
      const session = await request<Session>(`/sessions/${saved.sessionId}`);
      this.selected.set(Math.max(0, session.pages.findIndex((page) => page.id === saved.pageId)));
      this.remember(session);
      this.name = session.name;
      this.format = session.format;
      this.loadPage(this.selected());
      this.state.set(session.finished ? 'finished' : 'captured');
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        this.library.update((items) => items.filter((item) => item.id !== saved.sessionId));
        try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(this.library())); } catch {}
        writeActiveSession(null);
      } else {
        this.fail(error);
      }
    } finally {
      this.busy.set(false);
    }
  }

  private remember(session: Session) {
    this.session.set(session);
    this.persistActiveSession();
    // Keep only metadata in localStorage. Page images and OCR text remain on the server.
    this.library.update((items) =>
      [
        sessionMetadata(session),
        ...items.filter((sessionItem) => sessionItem.id !== session.id)
      ].slice(0, LIBRARY_LIMIT)
    );
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(this.library()));
    } catch {
      this.error.set(
        'Browser storage is unavailable. Keep this tab open to retain access to the session.'
      );
    }
  }

  private connect(id: string) {
    this.socket?.close();
    this.socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/sessions/${id}/stream`
    );
    this.socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress') {
          this.ocrStatus.set(data.status);
          this.ocrProgress.set(Math.round((data.progress || 0) * 100));
        }
      } catch {
        /* Ignore malformed progress, HTTP response remains authoritative. */
      }
    };
    this.socket.onerror = () => {
      this.ocrStatus.set('Recognizing text. Live progress unavailable.');
    };
  }

  beforeUnload(event: BeforeUnloadEvent) {
    if (this.dirty() || this.pending() || this.state() === 'processing') {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  onKey(event: KeyboardEvent) {
    if (this.tips()) return;
    const target = event.target as HTMLElement;
    const isTyping =
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
    if (event.key.toLowerCase() === 'n' && !hasModifier && !isTyping && !this.tips()) {
      void this.newSession();
    }
  }

  async start() {
    if (this.session()?.finished && !this.replacementPage()) return;
    if (this.busy() || this.active()) {
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.openCamera();
      let session = this.session();
      if (!session) {
        session = await request<Session>('/sessions', 'POST', {
          name: this.name,
          format: this.format
        });
        this.remember(session);
      }
      this.connect(session.id);
      this.arm();
    } catch (error) {
      this.stopCamera();
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  private async openCamera() {
    this.stopCamera();
    this.stream = await requestCamera(this.cameraId());
    const track = this.stream.getVideoTracks()[0];
    await configureCamera(track);
    track.onended = () => {
      this.pause();
      this.error.set('Camera disconnected. Reconnect it, then resume scanning.');
    };
    this.video.nativeElement.srcObject = this.stream;
    await this.video.nativeElement.play();
    this.cameraAspect.set(
      `${this.video.nativeElement.videoWidth} / ${this.video.nativeElement.videoHeight}`
    );
    this.hasCamera.set(true);
    this.photoMode.set(false);
    this.clearPhotoPreview();
    this.cameraList.set(
      (await navigator.mediaDevices.enumerateDevices()).filter(
        (device) => device.kind === 'videoinput'
      )
    );
    this.cameraId.set(track.getSettings().deviceId || '');
  }

  private arm() {
    this.state.set('aligning');
    this.progress.set(0);
    this.quality.set(null);
    this.previousFrame = undefined;
    this.gate.arm();
    if (this.inspectionTimer) {
      clearInterval(this.inspectionTimer);
    }
    this.inspectionTimer = setInterval(() => this.inspect(), 180);
  }

  private inspect() {
    const video = this.video.nativeElement;
    if (this.state() !== 'aligning' || video.readyState < 2 || !video.videoWidth) {
      return;
    }
    this.analysisCanvas.width = 240;
    this.analysisCanvas.height = Math.round((240 * video.videoHeight) / video.videoWidth);
    const context = this.analysisCanvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(video, 0, 0, this.analysisCanvas.width, this.analysisCanvas.height);
    const analysis = analyzeFrame(
      context.getImageData(0, 0, this.analysisCanvas.width, this.analysisCanvas.height).data,
      this.analysisCanvas.width,
      this.analysisCanvas.height,
      this.previousFrame
    );
    this.previousFrame = analysis.gray;
    this.quality.set(analysis);
    const decision = this.gate.update(analysis.ready, performance.now());
    this.progress.set(Math.round(decision.progress * 100));
    if (decision.capture) {
      void this.capture(analysis.crop);
    }
  }

  async captureManually() {
    await this.capture(
      this.quality()?.crop ?? { x: 0.1, y: 0.08, width: 0.8, height: 0.84 }
    );
  }

  async uploadPhoto(event: Event, replace = false) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // Allow selecting the same file again after a failure.
    if (file) await this.addPhoto(file, replace);
  }

  onPhotoDragEnter(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragDepth++;
    this.draggingPhoto.set(this.canUploadPhoto());
  }

  onPhotoDragOver(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = this.canUploadPhoto() ? 'copy' : 'none';
  }

  onPhotoDragLeave(event: DragEvent) {
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (!this.dragDepth) this.draggingPhoto.set(false);
  }

  async onPhotoDrop(event: DragEvent) {
    event.preventDefault();
    this.dragDepth = 0;
    this.draggingPhoto.set(false);
    if (!this.canUploadPhoto()) return;
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    if (files.length > 1) {
      this.error.set('Drop one photo at a time. You can add the next while text recognition continues.');
      return;
    }
    await this.addPhoto(files[0]);
  }

  private clearPhotoPreview() {
    const previous = this.photoPreview();
    if (previous) URL.revokeObjectURL(previous);
    this.photoPreview.set('');
  }

  private async addPhoto(file: File, replace = false) {
    if (this.busy() || this.state() === 'processing') return;
    if (replace && (this.active() || this.pending() || !this.page())) return;
    const replaceId = replace ? this.page()!.id : this.replacementPage();
    const merge = !replace && this.merging();
    if (this.session()?.finished && !replaceId) return;
    if (!replaceId && this.count() + this.pending() >= 100) {
      this.error.set('Maximum 100 pages per session. Finish this session before adding more.');
      return;
    }
    if (this.dirty() && this.pending()) {
      this.error.set('Wait for pending photos, then save your text corrections before adding another photo.');
      return;
    }
    if (this.dirty() && !(await this.saveText())) return;
    this.pause();
    this.busy.set(true);
    this.error.set('');
    try {
      const blob = await preparePhoto(file);
      let session = this.session();
      if (!session) {
        session = await request<Session>('/sessions', 'POST', { name: this.name, format: this.format });
        this.remember(session);
      }
      this.connect(session.id);
      this.clearPhotoPreview();
      this.photoPreview.set(URL.createObjectURL(blob));
      this.photoMode.set(true);
      this.captureQueue.add({ sessionId: session.id, blob, captureId: crypto.randomUUID(),
        accuracy: this.accuracy, ai: this.aiPowered,
        ...(merge ? { mergeId: replaceId } : { replaceId }) });
      this.replacementPage.set(undefined);
      this.merging.set(false);
      this.state.set(session.finished ? 'finished' : 'captured');
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  private async capture(crop: Crop) {
    const video = this.video.nativeElement;
    if (this.busy() || this.state() !== 'aligning' || !this.session() || !this.hasCamera()) {
      return;
    }
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      this.error.set('Camera is not ready yet. Wait for the preview, then try again.');
      return;
    }
    if (!this.replacementPage() && this.count() + this.pending() >= 100) {
      this.error.set('Maximum 100 pages per session. Wait for pending pages, then finish this session.');
      return;
    }
    this.error.set('');
    this.state.set('processing');
    this.busy.set(true);
    clearInterval(this.inspectionTimer);
    const sessionId = this.session()!.id;
    const replaceId = this.replacementPage();
    try {
      const blob = await capturePage(video, crop);
      this.captureQueue.add({ sessionId, blob, captureId: crypto.randomUUID(), accuracy: this.accuracy, ai: this.aiPowered,
        ...(this.merging() ? { mergeId: replaceId } : { replaceId }) });
      this.replacementPage.set(undefined);
      this.merging.set(false);
      if (this.session()?.finished) this.pause();
      else this.state.set('captured');
      navigator.vibrate?.(70);
    } catch (error) {
      this.state.set('captured');
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  async next() {
    if (this.session()?.finished && !this.replacementPage()) return;
    if (this.busy()) {
      return;
    }
    if (this.dirty() && !(await this.saveText())) {
      return;
    }
    this.error.set('');
    if (this.hasCamera()) {
      this.arm();
    } else {
      await this.start();
    }
  }

  pause() {
    clearInterval(this.inspectionTimer);
    this.stopCamera();
    this.state.set(this.session()?.finished && !this.replacementPage()
      ? 'finished' : this.session() ? 'captured' : 'idle');
  }

  private stopCamera() {
    this.stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.stream = undefined;
    this.hasCamera.set(false);
  }

  async changeCamera(id: string) {
    this.cameraId.set(id);
    this.pause();
    await this.start();
  }

  selectPage(index: number) {
    if (this.dirty()) {
      this.error.set('Save your text corrections before selecting another page.');
      return;
    }
    if (this.replacementPage()) this.cancelRetake();
    this.loadPage(index);
  }

  private loadPage(index: number) {
    this.selected.set(index);
    this.text.set(this.session()?.pages[index]?.text || '');
    this.persistActiveSession();
  }

  async saveText(): Promise<boolean> {
    if (this.pending()) return false;
    const page = this.page();
    if (!page || !this.session()) {
      return true;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const session = await request<Session>(
        `/sessions/${this.session()!.id}/pages/${page.id}`,
        'PATCH',
        { text: this.text() }
      );
      this.remember(session);
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async retake(merge = false) {
    if (this.busy() || this.active() || this.pending() || !this.page()) {
      return;
    }
    if (this.dirty() && !(await this.saveText())) {
      return;
    }
    if (merge && this.page()?.textEdited) {
      this.error.set('Combine captures before editing text. Your saved corrections are protected; use Rescan to start over.');
      return;
    }
    this.merging.set(merge);
    this.replacementPage.set(this.page()!.id);
    this.state.set('captured');
    document.querySelector('[data-guide="camera"]')?.scrollIntoView({ block: 'center' });
    await this.next();
  }

  cancelRetake() {
    if (this.busy() || this.pending()) return;
    this.replacementPage.set(undefined);
    this.merging.set(false);
    this.pause();
  }

  async finish() {
    if (this.busy() || this.pending() || this.replacementPage() || !this.count()) {
      return;
    }
    if (this.dirty() && !(await this.saveText())) {
      return;
    }
    this.pause();
    this.busy.set(true);
    this.error.set('');
    try {
      this.remember(await request<Session>(`/sessions/${this.session()!.id}/finish`, 'POST'));
      this.state.set('finished');
      this.socket?.close();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  async openSession(item: Session) {
    if (this.busy() || this.active() || this.pending()) {
      return;
    }
    if (this.dirty() && !(await this.saveText())) {
      return;
    }
    this.pause();
    this.replacementPage.set(undefined);
    this.busy.set(true);
    this.error.set('');
    try {
      const session = await request<Session>(`/sessions/${item.id}`);
      this.clearPhotoPreview();
      this.photoMode.set(false);
      this.text.set('');
      this.remember(session);
      this.name = session.name;
      this.format = session.format;
      this.loadPage(0);
      this.state.set(session.finished ? 'finished' : 'captured');
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  async newSession() {
    if (this.busy() || this.active() || this.pending()) {
      return;
    }
    if (this.dirty() && !(await this.saveText())) {
      return;
    }
    this.resetWorkspace();
  }

  private resetWorkspace() {
    this.pause();
    this.clearPhotoPreview();
    this.photoMode.set(false);
    this.dragDepth = 0;
    this.draggingPhoto.set(false);
    this.socket?.close();
    this.session.set(null);
    this.persistActiveSession();
    this.selected.set(0);
    this.text.set('');
    this.error.set('');
    this.state.set('idle');
    this.replacementPage.set(undefined);
    this.name = 'Untitled scan';
  }

  async deleteSession(session: Session | null = this.session()) {
    if (!session || this.busy() || this.active() || this.pending()) {
      return;
    }
    if (!confirm(`Delete “${session.name}” and all its pages? This cannot be undone.`)) {
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      try {
        await request(`/sessions/${session.id}`, 'DELETE');
      } catch (error) {
        // A stale library entry can also be removed if the server already deleted it.
        if (!(error instanceof ApiError && error.status === 404)) throw error;
      }
      this.library.update((items) => items.filter((sessionItem) => sessionItem.id !== session.id));
      try {
        localStorage.setItem(LIBRARY_KEY, JSON.stringify(this.library()));
      } catch {}
      if (this.session()?.id === session.id) this.resetWorkspace();
    } catch (error) {
      this.fail(error);
    } finally {
      this.busy.set(false);
    }
  }

  imageUrl(page: Page) {
    return `/api/sessions/${this.session()!.id}/pages/${page.id}/image`;
  }

  async download(event: Event, format: string) {
    if (this.busy() || this.pending() || this.replacementPage()) {
      event.preventDefault();
      return;
    }
    if (this.dirty()) {
      event.preventDefault();
      if (await this.saveText()) {
        window.location.assign(this.downloadUrl(format));
      }
    }
  }

  downloadUrl(format: string) {
    return `/api/sessions/${this.session()!.id}/export?format=${format}`;
  }

  private fail(error: unknown) {
    this.error.set(
      error instanceof Error ? error.message : 'Something went wrong. Please try again.'
    );
  }

  ngOnDestroy() {
    this.clearPhotoPreview();
    clearInterval(this.inspectionTimer);
    this.stopCamera();
    this.socket?.close();
  }
}
