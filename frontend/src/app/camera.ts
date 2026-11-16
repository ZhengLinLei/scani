import type { Crop } from './capture.mjs';

const CAPTURE_WIDTH = 2200;
const CAPTURE_HEIGHT = 3000;

export async function requestCamera(deviceId: string): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Camera access requires HTTPS or localhost. Open this page using a secure connection.'
    );
  }

  const video: MediaTrackConstraints = {
    width: { ideal: 2560 },
    height: { ideal: 1920 }
  };
  if (deviceId) {
    video.deviceId = { exact: deviceId };
  } else {
    video.facingMode = { ideal: 'environment' };
  }

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video });
  } catch (error) {
    switch ((error as DOMException).name) {
      case 'NotAllowedError':
        throw new Error(
          'Camera permission was denied. Allow camera access in your browser, then try again.'
        );
      case 'NotFoundError':
        throw new Error('No camera found. Connect a camera and try again.');
      default:
        throw new Error(
          'Could not open the camera. Close other camera apps or choose another device.'
        );
    }
  }
}

export async function configureCamera(track: MediaStreamTrack): Promise<void> {
  const capabilities = track.getCapabilities?.() as MediaTrackCapabilities &
    Record<string, unknown>;

  for (const setting of ['focusMode', 'exposureMode', 'whiteBalanceMode']) {
    const supported = capabilities?.[setting];
    if (!Array.isArray(supported) || !supported.includes('continuous')) {
      continue;
    }

    try {
      await track.applyConstraints({
        advanced: [{ [setting]: 'continuous' } as MediaTrackConstraintSet]
      });
    } catch {
      // Some devices advertise controls they cannot apply while streaming.
    }
  }
}

export function capturePage(video: HTMLVideoElement, crop: Crop): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const sourceWidth = video.videoWidth * crop.width;
  const sourceHeight = video.videoHeight * crop.height;
  const scale = Math.min(1, CAPTURE_WIDTH / sourceWidth, CAPTURE_HEIGHT / sourceHeight);
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  canvas
    .getContext('2d')!
    .drawImage(
      video,
      crop.x * video.videoWidth,
      crop.y * video.videoHeight,
      sourceWidth,
      sourceHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Could not capture this page.'));
        }
      },
      'image/jpeg',
      0.94
    );
  });
}
