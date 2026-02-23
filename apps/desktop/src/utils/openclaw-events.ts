const bus = new EventTarget();

const CONFIG_CHANGED = 'openclaw:config-changed';

export function emitConfigChanged(): void {
  bus.dispatchEvent(new Event(CONFIG_CHANGED));
}

export function onConfigChanged(callback: () => void): () => void {
  bus.addEventListener(CONFIG_CHANGED, callback);
  return () => bus.removeEventListener(CONFIG_CHANGED, callback);
}
