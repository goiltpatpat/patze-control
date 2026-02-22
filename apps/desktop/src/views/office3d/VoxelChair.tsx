import { Box } from '@react-three/drei';

interface VoxelChairProps {
  readonly position: [number, number, number];
  readonly color?: string;
}

export function VoxelChair(props: VoxelChairProps): JSX.Element {
  const c = props.color ?? '#333340';
  const [px, py, pz] = props.position;

  return (
    <group position={[px, py, pz]}>
      {/* Seat */}
      <Box args={[0.5, 0.06, 0.5]} position={[0, 0.42, 0]}>
        <meshStandardMaterial color={c} roughness={0.7} />
      </Box>

      {/* Backrest */}
      <Box args={[0.5, 0.45, 0.06]} position={[0, 0.7, -0.22]}>
        <meshStandardMaterial color={c} roughness={0.7} />
      </Box>

      {/* Central column */}
      <Box args={[0.06, 0.3, 0.06]} position={[0, 0.22, 0]}>
        <meshStandardMaterial color="#222228" metalness={0.6} roughness={0.3} />
      </Box>

      {/* Base star - 5 legs at 72deg apart */}
      {Array.from({ length: 5 }).map((_, i) => {
        const angle = (i * Math.PI * 2) / 5;
        const lx = Math.cos(angle) * 0.22;
        const lz = Math.sin(angle) * 0.22;
        return (
          <group key={i}>
            <Box args={[0.04, 0.04, 0.24]} position={[lx, 0.04, lz]} rotation={[0, -angle, 0]}>
              <meshStandardMaterial color="#222228" metalness={0.6} roughness={0.3} />
            </Box>
            {/* Wheel */}
            <mesh position={[lx * 1.6, 0.025, lz * 1.6]}>
              <sphereGeometry args={[0.025, 8, 8]} />
              <meshStandardMaterial color="#111116" />
            </mesh>
          </group>
        );
      })}

      {/* Armrests */}
      <Box args={[0.04, 0.18, 0.04]} position={[-0.25, 0.55, -0.05]}>
        <meshStandardMaterial color="#222228" metalness={0.4} roughness={0.4} />
      </Box>
      <Box args={[0.04, 0.18, 0.04]} position={[0.25, 0.55, -0.05]}>
        <meshStandardMaterial color="#222228" metalness={0.4} roughness={0.4} />
      </Box>
      <Box args={[0.04, 0.04, 0.3]} position={[-0.25, 0.66, -0.05]}>
        <meshStandardMaterial color={c} roughness={0.7} />
      </Box>
      <Box args={[0.04, 0.04, 0.3]} position={[0.25, 0.66, -0.05]}>
        <meshStandardMaterial color={c} roughness={0.7} />
      </Box>
    </group>
  );
}
