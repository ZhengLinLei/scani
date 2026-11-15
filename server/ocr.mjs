import { Worker } from 'node:worker_threads';
import { HttpError } from './store.mjs';

const MAX_PENDING_JOBS = 4;
const JOB_TIMEOUT_MS = 120_000;

// Serialize jobs; isolate the OCR engine so stalled downloads can also be stopped.
export function createOcr(root) {
  let worker;
  let queue = Promise.resolve();
  let pendingJobs = 0;
  let stopping = false;
  let warming;

  function getWorker() {
    if (worker) {
      return worker;
    }

    const createdWorker = new Worker(new URL('./ocr-worker.mjs', import.meta.url), {
      workerData: { root }
    });
    const clearWorker = () => {
      if (worker === createdWorker) {
        worker = undefined;
        warming = undefined;
      }
    };
    // Handle failures between jobs as well as failures during recognition.
    createdWorker.on('error', clearWorker);
    createdWorker.on('exit', clearWorker);
    worker = createdWorker;
    return worker;
  }

  async function recognize(image, onProgress) {
    if (stopping) {
      throw new Error('OCR is shutting down.');
    }
    if (pendingJobs >= MAX_PENDING_JOBS) {
      throw new HttpError(503, 'OCR is busy. Try again in a moment.');
    }

    pendingJobs++;
    const job = queue.then(async () => {
      if (stopping) {
        throw new Error('OCR is shutting down.');
      }
      const activeWorker = getWorker();
      try {
        return await recognizeWithWorker(activeWorker, image, onProgress);
      } catch (error) {
        worker = undefined;
        warming = undefined;
        await activeWorker.terminate();
        throw new HttpError(
          503,
          error.message || 'Text recognition failed. Check OCR language files and try again.'
        );
      }
    });

    // A failed job must not prevent subsequent jobs from running.
    queue = job.catch(() => {});
    return job.finally(() => {
      pendingJobs--;
    });
  }

  function warmup() {
    if (stopping) return Promise.reject(new Error('OCR is shutting down.'));
    if (!warming) {
      warming = recognize({ type: 'warmup' }).catch((error) => {
        warming = undefined;
        throw error;
      });
    }
    return warming;
  }

  async function close() {
    stopping = true;
    await worker?.terminate();
    await queue;
  }

  return { recognize, warmup, close };
}

function recognizeWithWorker(worker, image, onProgress) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    function onExit() {
      onError(new Error('OCR worker stopped.'));
    }

    function onMessage(message) {
      switch (message.type) {
        case 'progress':
          onProgress?.(message);
          break;
        case 'result':
          cleanup();
          resolve(message.result);
          break;
        case 'error':
          onError(new Error(message.error));
          break;
      }
    }

    const timer = setTimeout(() => {
      onError(new Error('OCR timed out. Check the language model download or try a clearer page.'));
    }, JOB_TIMEOUT_MS);
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    worker.postMessage(image);
  });
}
