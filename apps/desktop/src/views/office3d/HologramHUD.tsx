import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text } from '@react-three/drei';
import type { Group, Mesh } from 'three';

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface HologramHUDProps {
  readonly position: [number, number, number];
  readonly status: DeskStatus;
  readonly statusColor: string;
  readonly activeRuns: number;
  readonly label: string;
}

function getStatusGlow(status: DeskStatus): number {
  switch (status) {
    case 'active':
      return 1.2;
    case 'idle':
      return 0.6;
    case 'error':
      return 1.5;
    case 'offline':
      return 0.15;
  }
}

export function HologramHUD(props: HologramHUDProps): JSX.Element {
  const groupRef = useRef<Group>(null);
  const ring1Ref = useRef<Mesh>(null);
  const ring2Ref = useRef<Mesh>(null);
  const dataRef = useRef<Group>(null);
  const statusRef = useRef(props.status);
  statusRef.current = props.status;

  const [px, py, pz] = props.position;
  const baseY = py + 2.2;

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const status = statusRef.current;

    if (ring1Ref.current) {
      ring1Ref.current.rotation.z = t * 0.8;
      ring1Ref.current.rotation.x = Math.sin(t * 0.3) * 0.1;
    }
    if (ring2Ref.current) {
      ring2Ref.current.rotation.z = -t * 0.5;
      ring2Ref.current.rotation.y = Math.sin(t * 0.4) * 0.15;
    }

    if (groupRef.current) {
      groupRef.current.position.y = baseY + Math.sin(t * 1.5) * 0.04;
    }

    if (dataRef.current) {
      const targetOpacity = status === 'offline' ? 0.15 : 0.85;
      const current = dataRef.current.userData.opacity ?? 0.85;
      dataRef.current.userData.opacity = current + (targetOpacity - current) * 0.05;
    }
  });

  const glow = getStatusGlow(props.status);
  const runText =
    props.activeRuns > 0
      ? `${props.activeRuns.toString()} run${props.activeRuns > 1 ? 's' : ''}`
      : props.status.toUpperCase();

  return (
    <group ref={groupRef} position={[px, baseY, pz]}>
      {/* Outer ring */}
      <mesh ref={ring1Ref} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.4, 0.012, 8, 48]} />
        <meshBasicMaterial color={props.statusColor} transparent opacity={0.5} />
      </mesh>

      {/* Inner ring */}
      <mesh ref={ring2Ref} rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.28, 0.008, 8, 32]} />
        <meshBasicMaterial color={props.statusColor} transparent opacity={0.35} />
      </mesh>

      {/* Central glow orb */}
      <mesh>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshStandardMaterial
          color={props.statusColor}
          emissive={props.statusColor}
          emissiveIntensity={glow}
          transparent
          opacity={0.7}
        />
      </mesh>

      {/* Vertical beam */}
      <mesh position={[0, -0.6, 0]}>
        <cylinderGeometry args={[0.003, 0.015, 1.2, 8]} />
        <meshBasicMaterial color={props.statusColor} transparent opacity={0.2} />
      </mesh>

      {/* Data text */}
      <group ref={dataRef}>
        <Text
          position={[0, 0.22, 0]}
          fontSize={0.08}
          color={props.statusColor}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.003}
          outlineColor="#05070e"
        >
          {runText}
        </Text>
      </group>

      {/* Point light for ambient glow */}
      <pointLight color={props.statusColor} intensity={glow * 0.3} distance={3} decay={2} />
    </group>
  );
}
