import { Box } from '@react-three/drei';

interface VoxelMacMiniProps {
  readonly position: [number, number, number];
}

export function VoxelMacMini(props: VoxelMacMiniProps): JSX.Element {
  const [px, py, pz] = props.position;

  return (
    <group position={[px, py, pz]}>
      {/* Body */}
      <Box args={[0.2, 0.04, 0.2]} position={[0, 0.02, 0]}>
        <meshStandardMaterial color="#c0c0c8" metalness={0.7} roughness={0.2} />
      </Box>

      {/* Top edge bevel */}
      <Box args={[0.19, 0.005, 0.19]} position={[0, 0.043, 0]}>
        <meshStandardMaterial color="#d0d0d8" metalness={0.6} roughness={0.25} />
      </Box>

      {/* Apple logo (small dot) */}
      <mesh position={[0, 0.046, 0]}>
        <circleGeometry args={[0.015, 16]} />
        <meshStandardMaterial color="#a0a0a8" metalness={0.5} roughness={0.3} />
      </mesh>

      {/* Front ports */}
      <Box args={[0.012, 0.012, 0.005]} position={[-0.04, 0.02, 0.1]}>
        <meshStandardMaterial color="#222228" />
      </Box>
      <Box args={[0.012, 0.012, 0.005]} position={[-0.02, 0.02, 0.1]}>
        <meshStandardMaterial color="#222228" />
      </Box>

      {/* Power LED */}
      <mesh position={[0.06, 0.02, 0.101]}>
        <sphereGeometry args={[0.004, 6, 6]} />
        <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.5} />
      </mesh>

      {/* Rubber feet */}
      {([[-0.07, -0.07], [0.07, -0.07], [-0.07, 0.07], [0.07, 0.07]] as const).map(([fx, fz], i) => (
        <Box key={i} args={[0.02, 0.004, 0.02]} position={[fx, -0.002, fz]}>
          <meshStandardMaterial color="#1a1a1a" roughness={0.9} />
        </Box>
      ))}
    </group>
  );
}
