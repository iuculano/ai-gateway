/**
 * Used to prove that a branch has exhaustively handled every member of a union.
 *
 * This will always throw - if you get here, you've failed to handle an error
 * code.
 *
 * @param code
 * The value that should have been handled in a switch or if/else chain.
 */
export function assertNever(code: never): never {
  throw new Error(`Unhandled service failure code: ${JSON.stringify(code)}`);
}
