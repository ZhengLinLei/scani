import { AfterViewInit, Component, ElementRef, OnDestroy, output, signal, ViewChild } from '@angular/core';
import { IconComponent } from './icon';

export const GUIDE_SEEN_KEY = 'scani.quick-guide.v1';

@Component({
  selector: 'app-guide',
  standalone: true,
  imports: [IconComponent],
  template: `
    <svg class="guide-shade" aria-hidden="true" width="100%" height="100%">
      <defs>
        <mask id="guide-spotlight">
          <rect width="100%" height="100%" fill="white" />
          <rect [attr.x]="spot().x" [attr.y]="spot().y" [attr.width]="spot().width"
            [attr.height]="spot().height" rx="10" fill="black" />
        </mask>
      </defs>
      <rect width="100%" height="100%" fill="#161c18" fill-opacity="0.76" mask="url(#guide-spotlight)" />
      <rect [attr.x]="spot().x" [attr.y]="spot().y" [attr.width]="spot().width"
        [attr.height]="spot().height" rx="10" fill="none" stroke="#e4c79a" stroke-width="2" />
    </svg>
    <section #card class="guide-card" role="dialog" aria-modal="true"
      aria-labelledby="guide-title" aria-describedby="guide-description" tabindex="-1"
      [style.left.px]="position().x" [style.top.px]="position().y"
      (keydown)="onKey($event)">
      <button class="guide-close" (click)="close()" aria-label="Close guide"><app-icon name="close" /></button>
      <div class="eyebrow">QUICK GUIDE · {{ index() + 1 }} / {{ steps.length }}</div>
      <div class="guide-copy" aria-live="polite" aria-atomic="true">
        <h2 id="guide-title">{{ steps[index()].title }}</h2>
        <p id="guide-description">{{ steps[index()].description }}</p>
      </div>
      <div class="guide-progress" aria-hidden="true">
        @for (step of steps; track step.target; let i = $index) {
          <span [class.current]="i === index()" [class.complete]="i < index()"></span>
        }
      </div>
      <div class="guide-navigation">
        <button class="text-button" (click)="close()">Skip tour</button>
        <div>
          <button class="button secondary" (click)="move(-1)" [disabled]="index() === 0">Back</button>
          <button class="button primary" (click)="next()">{{ index() === steps.length - 1 ? 'Got it' : 'Next' }} <app-icon name="arrow" /></button>
        </div>
      </div>
    </section>
  `,
  styles: `
    :host { position: fixed; inset: 0; z-index: 1000; }
    .guide-shade { position: absolute; inset: 0; }
    .guide-card { position: absolute; width: min(360px, calc(100% - 24px)); max-height: calc(100dvh - 24px); overflow: auto; padding: 26px; background: #fffdf5; border: 1px solid #d3d8c6; border-radius: 12px; box-shadow: 0 12px 48px #111a1644; }
    .guide-card:focus { outline: none; }
    .guide-close { position: absolute; top: 12px; right: 12px; border: 0; background: transparent; color: #68735e; padding: 4px; }
    .eyebrow { padding-right: 20px; }
    h2 { font: 27px/1.15 Georgia, serif; color: #525e45; letter-spacing: -.5px; margin: 18px 0 12px; }
    p { color: #68735e; font-size: 13px; line-height: 1.7; margin: 0 0 20px; }
    .guide-progress { display: flex; gap: 5px; margin-bottom: 24px; }
    .guide-progress span { flex: 1; height: 3px; border-radius: 3px; background: #e5e5dd; }
    .guide-progress .current { background: var(--accent); }
    .guide-progress .complete { background: #879575; }
    .guide-navigation, .guide-navigation > div { display: flex; align-items: center; gap: 8px; }
    .guide-navigation { justify-content: space-between; }
    .guide-navigation .button { padding: 10px 12px; min-height: 40px; font-size: 12px; }
    .guide-navigation .text-button { font-size: 11px; }
    @media (max-width: 400px) { .guide-card { padding: 22px 18px; } }
  `
})
export class GuideComponent implements AfterViewInit, OnDestroy {
  @ViewChild('card', { static: true }) card!: ElementRef<HTMLElement>;
  dismissed = output<void>();
  index = signal(0);
  spot = signal({ x: 0, y: 0, width: 0, height: 0 });
  position = signal({ x: 12, y: 12 });
  readonly steps = [
    { target: 'setup', title: 'Make it your session.', description: 'Give your scan a name and choose TXT for editable text or PDF for page images. Choose these before you start; both downloads are available when you finish.' },
    { target: 'actions', title: 'Start with your camera.', description: 'Press Start scanning and allow camera access. After each capture, use Next page to continue, or Resume scanning if the camera is off.' },
    { target: 'camera', title: 'Point, then hold still.', description: 'Keep a flat page inside the corners on a darker surface, with even lighting. Capture is automatic when the page is steady and clear. You can also use Capture now. Move on with Next page while the previous photo is processed.' },
    { target: 'pages', title: 'Give your words a look.', description: 'Select a page and use Improve text to combine up to 10 captures of the same full page. Do this before saving text corrections. Review and edit the combined text, or use Rescan page to replace its image and text. Both actions work after finishing a session.' },
    { target: 'finish', title: 'Ready to take it with you.', description: 'When you have scanned every page, press Finish session. Download editable TXT or a PDF of your original page images from the download buttons that appear above.' },
    { target: 'sessions', title: 'Pick up where you left off.', description: 'Start a new session here. Saved sessions appear below in this browser, ready to reopen. You can replay this tour anytime from Quick guide.' }
  ];
  private frame = 0;
  private observer?: ResizeObserver;
  private previousFocus = document.activeElement as HTMLElement | null;
  private initialScroll = { x: window.scrollX, y: window.scrollY };
  private update = () => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.measure());
  };

  ngAfterViewInit() {
    window.addEventListener('resize', this.update);
    window.visualViewport?.addEventListener('resize', this.update);
    window.visualViewport?.addEventListener('scroll', this.update);
    window.addEventListener('scroll', this.update, true);
    this.observer = new ResizeObserver(this.update);
    this.observer.observe(this.card.nativeElement);
    for (const step of this.steps) {
      const target = document.querySelector(`[data-guide="${step.target}"]`);
      if (target) this.observer.observe(target);
    }
    this.showStep();
  }

  move(direction: number) {
    this.index.update((index) => Math.max(0, Math.min(this.steps.length - 1, index + direction)));
    this.showStep();
  }

  next() {
    if (this.index() === this.steps.length - 1) this.close();
    else this.move(1);
  }

  close() {
    try { localStorage.setItem(GUIDE_SEEN_KEY, 'true'); } catch { /* The tour still works without storage. */ }
    this.dismissed.emit();
  }

  private showStep() {
    document.querySelector(`[data-guide="${this.steps[this.index()].target}"]`)
      ?.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
    this.card.nativeElement.focus({ preventScroll: true });
    this.update();
  }

  private measure() {
    const target = document.querySelector(`[data-guide="${this.steps[this.index()].target}"]`);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const x = Math.max(left + 4, rect.left - 6);
    const y = Math.max(top + 4, rect.top - 6);
    const right = Math.min(left + width - 4, rect.right + 6);
    const bottom = Math.min(top + height - 4, rect.bottom + 6);
    this.spot.set({ x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) });
    const card = this.card.nativeElement.getBoundingClientRect();
    let cardX = x;
    let cardY = bottom + 16;
    if (cardY + card.height > top + height - 12) {
      if (y - card.height - 16 >= top + 12) cardY = y - card.height - 16;
      else if (right + card.width + 16 <= left + width - 12) { cardX = right + 16; cardY = y; }
      else if (x - card.width - 16 >= left + 12) { cardX = x - card.width - 16; cardY = y; }
      else cardY = top + height - card.height - 12;
    }
    this.position.set({
      x: Math.max(left + 12, Math.min(cardX, left + width - card.width - 12)),
      y: Math.max(top + 12, Math.min(cardY, top + height - card.height - 12))
    });
  }

  onKey(event: KeyboardEvent) {
    if (event.key === 'Escape') { event.stopPropagation(); this.close(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); this.next(); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); this.move(-1); }
    if (event.key !== 'Tab') return;
    const buttons = Array.from(this.card.nativeElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === this.card.nativeElement)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.frame);
    this.observer?.disconnect();
    window.removeEventListener('resize', this.update);
    window.visualViewport?.removeEventListener('resize', this.update);
    window.visualViewport?.removeEventListener('scroll', this.update);
    window.removeEventListener('scroll', this.update, true);
    window.scrollTo({ left: this.initialScroll.x, top: this.initialScroll.y, behavior: 'instant' });
    requestAnimationFrame(() => this.previousFocus?.focus({ preventScroll: true }));
  }
}
