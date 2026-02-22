import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Cylinder, Text } from '@react-three/drei';
import type { Group } from 'three';

interface WallClockProps {
  readonly position: [number, number, number];
}

export function WallClock(props: WallClockProps): JSX.Element {
  const hourRef = useRef<Group>(null);
  const minuteRef = useRef<Group>(null);
  const secondRef = useRef<Group>(null);
  const [px, py, pz] = props.position;

  const lastSecond = useRef(-1);

  useFrame(() => {
    const now = new Date();
    const s = now.getSeconds();
    if (s === lastSecond.current) return;
    lastSecond.current = s;

    const h = now.getHours() % 12;
    const m = now.getMinutes();

    const hourAngle = -((h + m / 60) / 12) * Math.PI * 2;
    const minuteAngle = -(m / 60) * Math.PI * 2;
    const secondAngle = -(s / 60) * Math.PI * 2;

    if (hourRef.current) hourRef.current.rotation.z = hourAngle;
    if (minuteRef.current) minuteRef.current.rotation.z = minuteAngle;
    if (secondRef.current) secondRef.current.rotation.z = secondAngle;
  });

  return (
    <group position={[px, py, pz]}>
      {/* Clock face */}
      <Cylinder args={[0.5, 0.5, 0.06, 32]} rotation={[Math.PI / 2, 0, 0]}>
        <meshStandardMaterial color="#e8e0d4" roughness={0.5} />
      </Cylinder>

      {/* Rim */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.5, 0.03, 8, 32]} />
        <meshStandardMaterial color="#333340" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Hour markers (12, 3, 6, 9) */}
      {[0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((angle, i) => {
        const mx = Math.sin(angle) * 0.38;
        const my = Math.cos(angle) * 0.38;
        return (
          <Box key={i} args={[0.03, 0.08, 0.02]} position={[mx, my, 0.04]}>
            <meshStandardMaterial color="#333340" />
          </Box>
        );
      })}

      {/* Hour hand */}
      <group ref={hourRef} position={[0, 0, 0.04]}>
        <Box args={[0.025, 0.22, 0.01]} position={[0, 0.11, 0]}>
          <meshStandardMaterial color="#222230" />
        </Box>
      </group>

      {/* Minute hand */}
      <group ref={minuteRef} position={[0, 0, 0.05]}>
        <Box args={[0.018, 0.32, 0.01]} position={[0, 0.16, 0]}>
          <meshStandardMaterial color="#333340" />
        </Box>
      </group>

      {/* Second hand */}
      <group ref={secondRef} position={[0, 0, 0.06]}>
        <Box args={[0.008, 0.35, 0.005]} position={[0, 0.175, 0]}>
          <meshStandardMaterial color="#ee4444" />
        </Box>
      </group>

      {/* Center pin */}
      <mesh position={[0, 0, 0.07]}>
        <sphereGeometry args={[0.02, 8, 8]} />
        <meshStandardMaterial color="#333340" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Label */}
      <Text position={[0, -0.15, 0.04]} fontSize={0.06} color="#666680" anchorX="center" anchorY="middle">
        PATZE
      </Text>
    </group>
  );
}
