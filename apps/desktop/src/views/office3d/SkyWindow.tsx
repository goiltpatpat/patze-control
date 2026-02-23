import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box } from '@react-three/drei';
import type { Group } from 'three';

interface SkyWindowProps {
  readonly position: [number, number, number];
  readonly width?: number;
  readonly height?: number;
}

function generateStars(count: number): readonly [number, number, number, number][] {
  const stars: [number, number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    stars.push([
      (Math.random() - 0.5) * 3.2,
      (Math.random() - 0.5) * 1.6,
      Math.random() * 0.8 + 0.2,
      Math.random() * Math.PI * 2,
    ]);
  }
  return stars;
}

export function SkyWindow(props: SkyWindowProps): JSX.Element {
  const [px, py, pz] = props.position;
  const w = props.width ?? 3.5;
  const h = props.height ?? 2.0;
  const starsGroupRef = useRef<Group>(null);
  const stars = useMemo(() => generateStars(60), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (starsGroupRef.current) {
      const children = starsGroupRef.current.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const [, , brightness, phase] = stars[i]!;
        child.scale.setScalar(0.6 + Math.sin(t * 1.5 + phase) * 0.4 * brightness);
      }
    }
  });

  return (
    <group position={[px, py, pz]}>
      {/* Window frame */}
      <Box args={[w + 0.12, h + 0.12, 0.08]} position={[0, 0, 0]}>
        <meshStandardMaterial color="#2a2a38" roughness={0.4} metalness={0.5} />
      </Box>

      {/* Sky backdrop */}
      <Box args={[w, h, 0.02]} position={[0, 0, 0.04]}>
        <meshStandardMaterial
          color="#040812"
          emissive="#0a1428"
          emissiveIntensity={0.3}
          roughness={0.1}
        />
      </Box>

      {/* Gradient overlay - horizon */}
      <Box args={[w, h * 0.3, 0.005]} position={[0, -h * 0.35, 0.05]}>
        <meshBasicMaterial color="#0a1a3a" transparent opacity={0.6} />
      </Box>

      {/* Stars */}
      <group ref={starsGroupRef} position={[0, 0, 0.055]}>
        {stars.map(([sx, sy, brightness], i) => (
          <mesh key={i} position={[sx, sy, 0]}>
            <circleGeometry args={[0.012 * brightness, 6]} />
            <meshBasicMaterial color="#ffffff" transparent opacity={brightness * 0.8} />
          </mesh>
        ))}
      </group>

      {/* Moon */}
      <mesh position={[0.8, 0.5, 0.055]}>
        <circleGeometry args={[0.12, 16]} />
        <meshStandardMaterial color="#dde8ff" emissive="#8899cc" emissiveIntensity={0.8} />
      </mesh>

      {/* City silhouette boxes */}
      {[
        [-1.4, 0.2],
        [-1.1, 0.35],
        [-0.8, 0.25],
        [-0.5, 0.45],
        [-0.2, 0.3],
        [0.1, 0.5],
        [0.4, 0.28],
        [0.7, 0.4],
        [1.0, 0.22],
        [1.3, 0.32],
      ].map(([bx, bh], i) => (
        <Box key={i} args={[0.2, bh!, 0.005]} position={[bx!, -h / 2 + bh! / 2 + 0.02, 0.052]}>
          <meshBasicMaterial color="#0a0e1a" />
        </Box>
      ))}

      {/* City window lights */}
      {[
        [-1.35, -0.5],
        [-1.05, -0.3],
        [-0.45, -0.35],
        [0.15, -0.25],
        [0.45, -0.4],
        [0.75, -0.32],
        [1.05, -0.48],
        [-0.75, -0.45],
        [0.35, -0.5],
        [1.25, -0.38],
      ].map(([lx, ly], i) => (
        <mesh key={`light-${i}`} position={[lx!, ly!, 0.054]}>
          <planeGeometry args={[0.02, 0.015]} />
          <meshBasicMaterial
            color={i % 3 === 0 ? '#ffcc44' : '#88aaff'}
            transparent
            opacity={0.7}
          />
        </mesh>
      ))}

      {/* Window light spill into room */}
      <pointLight position={[0, 0, 0.5]} color="#2244aa" intensity={0.15} distance={6} decay={2} />
    </group>
  );
}
