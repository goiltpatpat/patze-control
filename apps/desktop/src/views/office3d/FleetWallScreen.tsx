import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Text } from '@react-three/drei';
import type { Mesh } from 'three';

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface DeskSummary {
  readonly status: DeskStatus;
  readonly label: string;
}

interface FleetWallScreenProps {
  readonly position: [number, number, number];
  readonly desks: readonly DeskSummary[];
}

function getStatusColor(status: DeskStatus): string {
  switch (status) {
    case 'active':
      return '#2fc977';
    case 'idle':
      return '#f2bf4d';
    case 'error':
      return '#ee5d5d';
    case 'offline':
      return '#5e6772';
  }
}

export function FleetWallScreen(props: FleetWallScreenProps): JSX.Element {
  const screenRef = useRef<Mesh>(null);
  const scanLineRef = useRef<Mesh>(null);
  const [px, py, pz] = props.position;

  const counts = { active: 0, idle: 0, error: 0, offline: 0 };
  for (const d of props.desks) {
    counts[d.status] += 1;
  }
  const total = props.desks.length;

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    if (screenRef.current) {
      const mat = screenRef.current.material;
      if (!Array.isArray(mat) && 'emissiveIntensity' in mat) {
        mat.emissiveIntensity = 0.4 + Math.sin(t * 0.8) * 0.05;
      }
    }

    if (scanLineRef.current) {
      const yRange = 0.7;
      scanLineRef.current.position.y = ((t * 0.3) % 1) * yRange - yRange / 2;
    }
  });

  const barWidth = 2.0;
  const barY = -0.15;

  return (
    <group position={[px, py, pz]}>
      {/* Screen bezel */}
      <Box args={[2.8, 1.6, 0.06]} position={[0, 0, 0]}>
        <meshStandardMaterial color="#111118" roughness={0.3} metalness={0.6} />
      </Box>

      {/* Screen surface */}
      <Box ref={screenRef} args={[2.6, 1.4, 0.01]} position={[0, 0, 0.035]}>
        <meshStandardMaterial
          color="#060a14"
          emissive="#0a1a2a"
          emissiveIntensity={0.4}
          roughness={0.05}
          metalness={0.1}
        />
      </Box>

      {/* Scan line effect */}
      <Box ref={scanLineRef} args={[2.5, 0.005, 0.001]} position={[0, 0, 0.042]}>
        <meshBasicMaterial color="#4a9eff" transparent opacity={0.15} />
      </Box>

      {/* Title */}
      <Text
        position={[0, 0.5, 0.042]}
        fontSize={0.1}
        color="#8899bb"
        anchorX="center"
        anchorY="middle"
      >
        FLEET STATUS
      </Text>

      {/* Total count */}
      <Text
        position={[0, 0.3, 0.042]}
        fontSize={0.2}
        color="#e8f0ff"
        anchorX="center"
        anchorY="middle"
      >
        {total.toString()}
      </Text>
      <Text
        position={[0, 0.15, 0.042]}
        fontSize={0.06}
        color="#6678aa"
        anchorX="center"
        anchorY="middle"
      >
        TARGETS
      </Text>

      {/* Status bar segments */}
      {(
        [
          ['active', counts.active],
          ['idle', counts.idle],
          ['error', counts.error],
          ['offline', counts.offline],
        ] as const
      ).map(([status, count], i) => {
        const w = total > 0 ? (count / total) * barWidth : 0;
        let offsetX = -barWidth / 2;
        for (let j = 0; j < i; j++) {
          const prevCount = [counts.active, counts.idle, counts.error, counts.offline][j]!;
          offsetX += total > 0 ? (prevCount / total) * barWidth : 0;
        }
        if (w <= 0) return null;
        return (
          <Box key={status} args={[w, 0.06, 0.005]} position={[offsetX + w / 2, barY, 0.042]}>
            <meshBasicMaterial color={getStatusColor(status)} />
          </Box>
        );
      })}

      {/* Status labels */}
      {(
        [
          ['active', counts.active, '#2fc977'],
          ['idle', counts.idle, '#f2bf4d'],
          ['error', counts.error, '#ee5d5d'],
          ['offline', counts.offline, '#5e6772'],
        ] as const
      ).map(([label, count, color], i) => (
        <group key={label}>
          {/* Dot */}
          <mesh position={[-0.9 + i * 0.6, barY - 0.15, 0.042]}>
            <circleGeometry args={[0.02, 8]} />
            <meshBasicMaterial color={color} />
          </mesh>
          <Text
            position={[-0.75 + i * 0.6, barY - 0.15, 0.042]}
            fontSize={0.05}
            color={color}
            anchorX="left"
            anchorY="middle"
          >
            {`${label} ${count}`}
          </Text>
        </group>
      ))}

      {/* Edge glow strips */}
      <Box args={[0.02, 1.4, 0.02]} position={[-1.35, 0, 0.03]}>
        <meshStandardMaterial
          color="#4a9eff"
          emissive="#4a9eff"
          emissiveIntensity={0.6}
          transparent
          opacity={0.4}
        />
      </Box>
      <Box args={[0.02, 1.4, 0.02]} position={[1.35, 0, 0.03]}>
        <meshStandardMaterial
          color="#4a9eff"
          emissive="#4a9eff"
          emissiveIntensity={0.6}
          transparent
          opacity={0.4}
        />
      </Box>
    </group>
  );
}
