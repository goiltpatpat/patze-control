import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import type { Points } from 'three';

interface AmbientParticlesProps {
  readonly count?: number;
  readonly area?: [number, number, number];
}

export function AmbientParticles(props: AmbientParticlesProps): JSX.Element {
  const count = props.count ?? 80;
  const [areaX, areaY, areaZ] = props.area ?? [20, 5, 16];
  const pointsRef = useRef<Points>(null);

  const { positions, speeds } = useMemo(() => {
    const pos = new Float32Array(count * 3);
    const spd = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * areaX;
      pos[i * 3 + 1] = Math.random() * areaY + 0.5;
      pos[i * 3 + 2] = (Math.random() - 0.5) * areaZ;
      spd[i] = 0.1 + Math.random() * 0.3;
    }
    return { positions: pos, speeds: spd };
  }, [count, areaX, areaY, areaZ]);

  useFrame((state) => {
    if (!pointsRef.current) return;
    const geo = pointsRef.current.geometry;
    const posAttr = geo.getAttribute('position');
    if (!posAttr) return;
    const buf = positions;
    const t = state.clock.elapsedTime;

    for (let i = 0; i < count; i++) {
      const idx = i * 3;
      const speed = speeds[i] ?? 0.2;
      // Indices are guaranteed in-bounds (idx < count * 3)
      buf[idx + 1]! += speed * 0.002;
      buf[idx]! += Math.sin(t * 0.5 + i) * 0.001;
      buf[idx + 2]! += Math.cos(t * 0.3 + i * 0.7) * 0.001;

      if (buf[idx + 1]! > areaY + 0.5) {
        buf[idx + 1] = 0.5;
        buf[idx] = (Math.random() - 0.5) * areaX;
        buf[idx + 2] = (Math.random() - 0.5) * areaZ;
      }
    }
    posAttr.needsUpdate = true;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.03}
        color="#8899cc"
        transparent
        opacity={0.3}
        sizeAttenuation
        depthWrite={false}
      />
    </points>
  );
}
