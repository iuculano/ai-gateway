import { toast } from 'svelte-sonner';

/**
 * Copies text to the clipboard and says how it went. Success is reported only
 * once the browser has confirmed the write, and a failure never shows the text.
 */
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
