/**
 * Proves that a branch has exhaustively handled every member of a union.
 * Throws if an unhandled value nevertheless reaches the branch at runtime.
 */
export function assertNever(code: never): never {
  throw new Error(`Unhandled service failure code: ${JSON.stringify(code)}`);
}
