export const MAX_MOTION: number;

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Analysis {
  gray: Uint8Array;
  brightness: number;
  edges: number;
  motion: number;
  lit: boolean;
  sharp: boolean;
  detected: boolean;
  ready: boolean;
  crop: Crop;
}

export function analyzeFrame(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  previous?: Uint8Array
): Analysis;

export class CaptureGate {
  constructor(holdMs?: number);
  arm(): void;
  update(ready: boolean, now: number): { capture: boolean; progress: number };
}
