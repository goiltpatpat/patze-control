import { useCallback, useRef, useState, type DragEvent } from 'react';
import { IconUpload } from '../../components/Icons';

export interface DropZoneProps {
  readonly onDrop: (files: File[]) => void;
  readonly children: React.ReactNode;
}

export function DropZone(props: DropZoneProps): JSX.Element {
  const { onDrop, children } = props;
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounter.current = 0;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        onDrop(files);
      }
    },
    [onDrop]
  );

  return (
    <div
      className={`fm-dropzone${isDragging ? ' fm-dropzone-active' : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {isDragging && (
        <div className="fm-dropzone-overlay">
          <IconUpload className="fm-dropzone-icon" />
          <span>Drop files here to upload</span>
        </div>
      )}
    </div>
  );
}
