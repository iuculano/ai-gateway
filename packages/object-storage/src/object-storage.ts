/**
 * The byte-level client that every backing store implements.
 *
 * Deliberately small and untyped beyond bytes.
 */
export interface ObjectStorageClient {
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
