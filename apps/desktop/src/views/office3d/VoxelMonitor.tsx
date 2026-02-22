import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box } from '@react-three/drei';
import type { Mesh } from 'three';

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface VoxelMonitorProps {
  readonly position: [number, number, number];
  readonly status: DeskStatus;
  readonly statusColor: string;
}

function getScreenColor(status: DeskStatus): string {
  switch (status) {
    case 'active': return '#0a2a1a';
    case 'idle': return '#1a1a2a';
    case 'error': return '#2a0a0a';
    case 'offline': return '#0a0a0a';
  }
}

function getScreenEmissive(status: DeskStatus): string {
  switch (status) {
    case 'active': return '#1a4a2a';
    case 'idle': return '#1a2a4a';
    case 'error': return '#4a1a1a';
    case 'offline': return '#0a0a0a';
  }
}

export function VoxelMonitor(props: VoxelMonitorProps): JSX.Element {
  const screenRef = useRef<Mesh>(null);
  const statusRef = useRef(props.status);
  statusRef.current = props.status;
  const [px, py, pz] = props.position;

  useFrame((state) => {
    if (screenRef.current == null) return;
    const mat = screenRef.current.material;
    if (Array.isArray(mat) || !('emissiveIntensity' in mat)) return;
    const status = statusRef.current;
    if (status === 'active') {
      mat.emissiveIntensity = 0.5 + Math.sin(state.clock.elapsedTime * 1.5) * 0.2;
    } else if (status === 'error') {
      mat.emissiveIntensity = 0.3 + Math.sin(state.clock.elapsedTime * 4) * 0.3;
    } else {
      mat.emissiveIntensity = status === 'offline' ? 0 : 0.5;
    }
  });

  return (
    <group position={[px, py, pz]}>
      {/* Monitor bezel */}
      <Box args={[0.7, 0.45, 0.03]} position={[0, 0.28, 0]}>
        <meshStandardMaterial color="#111118" roughness={0.4} metalness={0.5} />
      </Box>

      {/* Screen */}
      <Box ref={screenRef} args={[0.62, 0.37, 0.005]} position={[0, 0.28, 0.018]}>
        <meshStandardMaterial
          color={getScreenColor(props.status)}
          emissive={getScreenEmissive(props.status)}
          emissiveIntensity={props.status === 'offline' ? 0 : 0.5}
          roughness={0.1}
          metalness={0.1}
        />
      </Box>

      {/* Status LED */}
      <mesh position={[0, 0.04, 0.018]}>
        <sphereGeometry args={[0.012, 8, 8]} />
        <meshStandardMaterial
          color={props.statusColor}
          emissive={props.statusColor}
          emissiveIntensity={props.status === 'offline' ? 0.1 : 0.8}
        />
      </mesh>

      {/* Stand neck */}
      <Box args={[0.06, 0.15, 0.04]} position={[0, -0.02, -0.02]}>
        <meshStandardMaterial color="#1a1a22" metalness={0.6} roughness={0.3} />
      </Box>

      {/* Stand base */}
      <Box args={[0.25, 0.015, 0.15]} position={[0, -0.1, 0]}>
        <meshStandardMaterial color="#1a1a22" metalness={0.6} roughness={0.3} />
      </Box>
    </group>
  );
}
