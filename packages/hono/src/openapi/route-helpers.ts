import { httpError } from '@repo/core';

export const bearerSecurity = [{ bearerAuth: [] as string[] }];

const jsonErrorContent = {
  'application/json': {
    schema: httpError,
  },
};

export const protectedRouteErrors = {
  401: {
    description: 'Authentication is required or the supplied credentials are invalid',
    content: jsonErrorContent,
  },

  403: {
    description: 'The authenticated caller is not permitted to perform this operation',
    headers: {
      'WWW-Authenticate': {
        description: 'Authentication challenge describing the requirements for accessing the resource',
        schema: { type: 'string' as const },
      },
    },
    content: jsonErrorContent,
  },

  429: {
    description: 'Too many requests have been made',
    headers: {
      'Retry-After': {
        description: 'How long to wait before making another request',
        schema: { type: 'string' as const },
      },

      RateLimit: {
        description: 'Request limit, remaining requests, and reset time',
        schema: { type: 'string' as const },
      },

      'RateLimit-Policy': {
        description: 'Policy used to limit requests',
        schema: { type: 'string' as const },
      },
    },
    content: jsonErrorContent,
  },

  500: {
    description: 'The server encountered an unexpected error',
    content: jsonErrorContent,
  },
} as const;

export const validatedProtectedRouteErrors = {
  400: {
    description: 'The request is invalid',
    content: jsonErrorContent,
  },
  ...protectedRouteErrors,
} as const;
