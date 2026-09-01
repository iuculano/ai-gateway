import type { ApiType } from 'gateway-backend/routes';
import { hc, type PickResponseByStatusCode } from 'hono/client';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Preserve the BFF's session-expiry and error behavior while Hono owns URL,
 * query, parameter, body, and response typing.
 */
const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const response = await fetch(input, init);

  if (response.status === 401) {
    if (typeof window !== 'undefined') {
      window.location.href = '/auth/login';
    }
    throw new ApiError(401, 'Session expired.');
  }

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // Not JSON; keep the generic message.
    }
    throw new ApiError(response.status, message);
  }

  return response;
};

// apiFetch throws every non-success response, so expose only the success side
// of each endpoint to callers instead of forcing them to narrow unreachable
// error response unions after every request.
type SuccessfulApiType = PickResponseByStatusCode<ApiType, 200 | 201 | 204>;

export const client = hc<SuccessfulApiType>('/api', { fetch: apiFetch });
