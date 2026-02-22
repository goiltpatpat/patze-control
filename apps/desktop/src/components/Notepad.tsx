import { useCallback, useEffect, useRef, useState } from 'react';
import { IconNote, IconTrash } from './Icons';

const STORAGE_KEY = 'patze_notepad';
const AUTOSAVE_DELAY_MS = 2000;

interface StoredData {
  text: string;
  ts: string;
}

function loadNote(): StoredData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredData;
  } catch {
    return null;
  }
}

function saveNote(text: string): void {
  try {
    if (text.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ text, ts: new Date().toISOString() }));
    }
  } catch {
    /* storage full */
  }
}

function formatSaveTime(iso: string): string {
  try {
    const d = new Date(iso);
    return `saved ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return 'saved';
  }
}

export function Notepad(): JSX.Element {
  const [text, setText] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    const stored = loadNote();
    if (stored) {
      setText(stored.text);
      setLastSavedAt(stored.ts);
      setSaveStatus('saved');
    }
  }, []);

  const doSave = useCallback((value: string) => {
    saveNote(value);
    const now = new Date().toISOString();
    setLastSavedAt(now);
    setSaveStatus('saved');
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);
      setSaveStatus('saving');

      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        doSave(value);
      }, AUTOSAVE_DELAY_MS);
    },
    [doSave]
  );

  const handleClear = useCallback(() => {
    setText('');
    saveNote('');
    setLastSavedAt(null);
    setSaveStatus('idle');
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
  }, []);

  return (
    <div className="notepad">
      <div className="notepad-header">
        <IconNote width={14} height={14} />
        <span className="notepad-title">Quick Notes</span>
        <span className="notepad-save-status">
          {saveStatus === 'saving'
            ? 'saving…'
            : saveStatus === 'saved' && lastSavedAt
              ? formatSaveTime(lastSavedAt)
              : null}
        </span>
        <button
          className="notepad-clear-btn"
          onClick={handleClear}
          title="Clear notes"
        >
          <IconTrash width={12} height={12} />
        </button>
      </div>
      <div className="notepad-body">
        <textarea
          value={text}
          onChange={handleChange}
          placeholder="Quick notes, IPs, debug info…"
          spellCheck={false}
        />
      </div>
    </div>
  );
}
