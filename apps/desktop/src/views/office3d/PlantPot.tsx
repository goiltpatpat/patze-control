import { Box, Cylinder } from '@react-three/drei';

interface PlantPotProps {
  readonly position: [number, number, number];
  readonly size?: 'small' | 'medium' | 'large';
}

const SIZES = {
  small: { pot: 0.15, height: 0.5, leaves: 3 },
  medium: { pot: 0.2, height: 0.7, leaves: 4 },
  large: { pot: 0.28, height: 0.95, leaves: 5 },
} as const;

export function PlantPot(props: PlantPotProps): JSX.Element {
  const [px, py, pz] = props.position;
  const s = SIZES[props.size ?? 'medium'];

  return (
    <group position={[px, py, pz]}>
      {/* Pot */}
      <Cylinder args={[s.pot, s.pot * 0.8, s.pot * 1.6, 8]} position={[0, s.pot * 0.8, 0]}>
        <meshStandardMaterial color="#8b4513" roughness={0.85} />
      </Cylinder>

      {/* Dirt */}
      <Cylinder args={[s.pot * 0.9, s.pot * 0.9, 0.03, 8]} position={[0, s.pot * 1.58, 0]}>
        <meshStandardMaterial color="#3d2b1f" roughness={1} />
      </Cylinder>

      {/* Stem */}
      <Box args={[0.03, s.height * 0.5, 0.03]} position={[0, s.pot * 1.6 + s.height * 0.25, 0]}>
        <meshStandardMaterial color="#2d5a27" roughness={0.8} />
      </Box>

      {/* Leaves */}
      {Array.from({ length: s.leaves }).map((_, i) => {
        const angle = (i * Math.PI * 2) / s.leaves + i * 0.3;
        const leafY = s.pot * 1.6 + s.height * 0.3 + i * (s.height * 0.12);
        const lx = Math.cos(angle) * 0.12;
        const lz = Math.sin(angle) * 0.12;
        return (
          <Box
            key={i}
            args={[0.12, 0.02, 0.06]}
            position={[lx, leafY, lz]}
            rotation={[0.2, angle, Math.sin(i) * 0.3]}
          >
            <meshStandardMaterial color={i % 2 === 0 ? '#3a7a34' : '#2d6627'} roughness={0.7} />
          </Box>
        );
      })}
    </group>
  );
}
