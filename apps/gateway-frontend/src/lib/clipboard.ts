import { toast } from 'svelte-sonner';

/** Report success only after the browser confirms the write. Never expose copied data in errors. */
export async function copyToClipboard(text: string, successMessage: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast.error('Could not copy to clipboard. Please select and copy the text manually.');
    return false;
  }

  toast.success(successMessage);
  return true;
}
