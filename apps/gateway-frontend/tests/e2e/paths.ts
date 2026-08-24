import { fileURLToPath } from 'node:url';

export const appDirectory = fileURLToPath(new URL('../../', import.meta.url));
export const authStatePath = fileURLToPath(new URL('../../test-results/.auth/user.json', import.meta.url));
