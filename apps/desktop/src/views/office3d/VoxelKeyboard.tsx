import { Box } from '@react-three/drei';

interface VoxelKeyboardProps {
  readonly position: [number, number, number];
}

const KEY_ROWS: ReadonlyArray<{ count: number; z: number }> = [
  { count: 10, z: -0.06 },
  { count: 9, z: 0.0 },
  { count: 8, z: 0.06 },
];

export function VoxelKeyboard(props: VoxelKeyboardProps): JSX.Element {
  const [px, py, pz] = props.position;

  return (
    <group position={[px, py, pz]}>
      {/* Base plate */}
      <Box args={[0.4, 0.015, 0.2]} position={[0, 0, 0]}>
        <meshStandardMaterial color="#1a1a22" roughness={0.6} metalness={0.3} />
      </Box>

      {/* Key rows */}
      {KEY_ROWS.map((row, ri) => {
        const startX = -((row.count - 1) * 0.035) / 2;
        return Array.from({ length: row.count }).map((_, ki) => (
          <Box
            key={`${ri}-${ki}`}
            args={[0.028, 0.012, 0.028]}
            position={[startX + ki * 0.035, 0.013, row.z]}
          >
            <meshStandardMaterial color="#2a2a35" roughness={0.5} />
          </Box>
        ));
      })}

      {/* Spacebar */}
      <Box args={[0.16, 0.012, 0.028]} position={[0, 0.013, 0.065]}>
        <meshStandardMaterial color="#2a2a35" roughness={0.5} />
      </Box>
    </group>
  );
}
