import type { Result } from 'neverthrow';

/**
 * Unwrapping that fails the test rather than the type checker.
 *
 * The point of the Result conversion is that an expected failure is a value, so
 * asserting on one should read as an assertion and not as a try/catch.
 */
export function expectOk<T, E>(result: Result<T, E>): T {
  if (result.isErr()) {
    throw new Error(`Expected Ok, got Err: ${JSON.stringify(result.error)}`);
  }

  return result.value;
}

export function expectErr<T, E>(result: Result<T, E>): E {
  if (result.isOk()) {
    throw new Error(`Expected Err, got Ok: ${JSON.stringify(result.value)}`);
  }

  return result.error;
}

/**
 * One scenario per code in a failure union, checked with
 * `satisfies Record<Failure['code'], FailureCase<...>>` so that adding a
 * variant without a scenario is a type error.
 *
 * Only worth it for a union with more than one member. The `assertNever` in
 * each handler mapper already makes an unhandled variant fail to compile, so
 * for a single-code union this adds nothing a plain test does not - see
 * updateApiKey and getLogPayload for the two that earn it.
 */
export interface FailureCase<TSuccess, TFailure> {
  run(): Promise<Result<TSuccess, TFailure>>;
}
