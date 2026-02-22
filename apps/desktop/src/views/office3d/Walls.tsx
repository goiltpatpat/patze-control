import { Box } from '@react-three/drei';

const WALL_COLOR = '#1a1e2a';
const TRIM_COLOR = '#252a38';
const WALL_HEIGHT = 5;
const ROOM_WIDTH = 24;
const ROOM_DEPTH = 20;
const TRIM_HEIGHT = 0.15;

export function Walls(): JSX.Element {
  return (
    <group>
      {/* Back wall */}
      <mesh position={[0, WALL_HEIGHT / 2, -ROOM_DEPTH / 2]} receiveShadow>
        <boxGeometry args={[ROOM_WIDTH, WALL_HEIGHT, 0.2]} />
        <meshStandardMaterial color={WALL_COLOR} roughness={0.92} metalness={0.02} />
      </mesh>

      {/* Left wall */}
      <mesh position={[-ROOM_WIDTH / 2, WALL_HEIGHT / 2, 0]} receiveShadow>
        <boxGeometry args={[0.2, WALL_HEIGHT, ROOM_DEPTH]} />
        <meshStandardMaterial color={WALL_COLOR} roughness={0.92} metalness={0.02} />
      </mesh>

      {/* Right wall */}
      <mesh position={[ROOM_WIDTH / 2, WALL_HEIGHT / 2, 0]} receiveShadow>
        <boxGeometry args={[0.2, WALL_HEIGHT, ROOM_DEPTH]} />
        <meshStandardMaterial color={WALL_COLOR} roughness={0.92} metalness={0.02} />
      </mesh>

      {/* Baseboard trim - back */}
      <Box args={[ROOM_WIDTH, TRIM_HEIGHT, 0.25]} position={[0, TRIM_HEIGHT / 2, -ROOM_DEPTH / 2 + 0.02]}>
        <meshStandardMaterial color={TRIM_COLOR} roughness={0.6} metalness={0.15} />
      </Box>

      {/* Baseboard trim - left */}
      <Box args={[0.25, TRIM_HEIGHT, ROOM_DEPTH]} position={[-ROOM_WIDTH / 2 + 0.02, TRIM_HEIGHT / 2, 0]}>
        <meshStandardMaterial color={TRIM_COLOR} roughness={0.6} metalness={0.15} />
      </Box>

      {/* Baseboard trim - right */}
      <Box args={[0.25, TRIM_HEIGHT, ROOM_DEPTH]} position={[ROOM_WIDTH / 2 - 0.02, TRIM_HEIGHT / 2, 0]}>
        <meshStandardMaterial color={TRIM_COLOR} roughness={0.6} metalness={0.15} />
      </Box>
    </group>
  );
}
