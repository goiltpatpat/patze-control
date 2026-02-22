import { useEffect, useRef } from 'react';
import { RepeatWrapping, CanvasTexture } from 'three';

const FLOOR_SIZE_X = 24;
const FLOOR_SIZE_Z = 20;
const TEX_SIZE = 512;

function generateFloorTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#1e2230';
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  for (let i = 0; i < TEX_SIZE; i += 1) {
    const brightness = 0.92 + 0.08 * Math.sin(i * 0.12 + Math.sin(i * 0.025) * 3);
    ctx.fillStyle = `rgba(40, 50, 70, ${brightness * 0.25})`;
    ctx.fillRect(0, i, TEX_SIZE, 1);
  }

  const tileSize = 64;
  ctx.strokeStyle = 'rgba(60, 75, 100, 0.15)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= TEX_SIZE; x += tileSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TEX_SIZE);
    ctx.stroke();
  }
  for (let y = 0; y <= TEX_SIZE; y += tileSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TEX_SIZE, y);
    ctx.stroke();
  }

  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(4, 4);
  return texture;
}

export function Floor(): JSX.Element {
  const textureRef = useRef<CanvasTexture | null>(null);
  if (!textureRef.current) {
    textureRef.current = generateFloorTexture();
  }

  useEffect(() => {
    return () => { textureRef.current?.dispose(); };
  }, []);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[FLOOR_SIZE_X, FLOOR_SIZE_Z]} />
      <meshStandardMaterial map={textureRef.current} roughness={0.85} metalness={0.08} />
    </mesh>
  );
}
