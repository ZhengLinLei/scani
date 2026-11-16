export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/** Send a same-origin API request and surface the server's error message. */
export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const options: RequestInit = { method };

  if (body instanceof Blob) {
    options.body = body;
    options.headers = { 'Content-Type': 'image/jpeg' };
  } else if (body !== undefined) {
    options.body = JSON.stringify(body);
    options.headers = { 'Content-Type': 'application/json' };
  }

  const response = await fetch(`/api${path}`, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(response.status, data.error || `Request failed (${response.status}).`);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return response.json();
}
