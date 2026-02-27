export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function shouldPausePollWhenHidden(): boolean {
  // Browser dev often has multiple hidden tabs. Pausing there prevents duplicate polling load.
  // Tauri webviews can report hidden unexpectedly, so polling must continue in Tauri runtime.
  return !isTauriRuntime();
}
