import { Component, Input } from '@angular/core';

const paths = {
  plus: 'M12 5v14M5 12h14',
  close: 'm6 6 12 12M6 18 18 6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  check: 'm5 12 4 4L19 6',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5',
  expand: 'M6 18 18 6M6 6h12v12',
  refresh: 'M20 7v5h-5M20 12a8 8 0 1 0-2 6M20 7l-3-3',
  document: 'M14 3H5v18h14V8l-5-5v5h5M8 12h8M8 16h6',
  text: 'M14 3H5v18h14V8l-5-5v5h5M8 12h8m-4 0v6m-2 0h4',
  stack: 'm3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5',
  sparkle: 'm12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z',
  shield: 'M12 3 3 6v6c0 5 9 9 9 9s9-4 9-9V6l-9-3Zm-4 9 3 3 5-6',
  help: 'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3v.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  camera: 'M3 7h4l2-3h6l2 3h4v14H3V7Zm13 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z'
};

@Component({
  selector: 'app-icon',
  standalone: true,
  template: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path [attr.d]="path" /></svg>',
  styles: [':host { display: inline-flex; width: 1em; height: 1em; flex-shrink: 0; vertical-align: -0.15em; } svg { width: 100%; height: 100%; }']
})
export class IconComponent {
  @Input() name: keyof typeof paths = 'document';
  get path() { return paths[this.name]; }
}
