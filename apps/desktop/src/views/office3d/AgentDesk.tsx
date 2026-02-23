import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Text } from '@react-three/drei';
import type { Group, Mesh } from 'three';
import { VoxelChair } from './VoxelChair';
import { VoxelKeyboard } from './VoxelKeyboard';
import { VoxelMonitor } from './VoxelMonitor';
import { VoxelMacMini } from './VoxelMacMini';

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface AgentDeskProps {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
  readonly status: DeskStatus;
  readonly activeRuns: number;
  readonly position: [number, number, number];
  readonly statusColor: string;
  readonly isSelected: boolean;
  readonly onClick: () => void;
}

export function AgentDesk(props: AgentDeskProps): JSX.Element {
  const groupRef = useRef<Group>(null);
  const hoverGlowRef = useRef<Mesh>(null);
  const hoveredRef = useRef(false);
  const [px, py, pz] = props.position;

  useEffect(() => {
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, []);

  useFrame(() => {
    if (groupRef.current == null) return;
    const targetScale = hoveredRef.current ? 1.03 : 1;
    const s = groupRef.current.scale.x;
    groupRef.current.scale.setScalar(s + (targetScale - s) * 0.1);

    if (hoverGlowRef.current) {
      const mat = hoverGlowRef.current.material as import('three').MeshBasicMaterial;
      const targetOp = hoveredRef.current ? 0.15 : 0;
      mat.opacity += (targetOp - mat.opacity) * 0.15;
    }
  });

  const statusText = props.activeRuns > 0 ? `${props.activeRuns} active` : props.status;

  return (
    <group
      ref={groupRef}
      position={[px, py, pz]}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      onPointerOver={() => {
        hoveredRef.current = true;
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        hoveredRef.current = false;
        document.body.style.cursor = 'auto';
      }}
    >
      {/* Desk surface */}
      <Box args={[1.8, 0.08, 1.0]} position={[0, 0.72, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#3d3528" roughness={0.6} metalness={0.1} />
      </Box>

      {/* Desk legs */}
      {(
        [
          [-0.8, -0.4],
          [0.8, -0.4],
          [-0.8, 0.4],
          [0.8, 0.4],
        ] as const
      ).map(([lx, lz], i) => (
        <Box key={i} args={[0.06, 0.72, 0.06]} position={[lx, 0.36, lz]}>
          <meshStandardMaterial color="#2a2420" metalness={0.4} roughness={0.5} />
        </Box>
      ))}

      {/* Monitor */}
      <VoxelMonitor
        position={[0, 0.76, -0.25]}
        status={props.status}
        statusColor={props.statusColor}
      />

      {/* Keyboard */}
      <VoxelKeyboard position={[0, 0.77, 0.15]} />

      {/* Mac Mini */}
      <VoxelMacMini position={[0.65, 0.76, -0.2]} />

      {/* Chair - rotated to face desk */}
      <group position={[0, 0, 0.8]} rotation={[0, Math.PI, 0]}>
        <VoxelChair position={[0, 0, 0]} color={props.statusColor} />
      </group>

      {/* Nameplate */}
      <Text
        position={[0, 1.55, -0.25]}
        fontSize={0.14}
        color="#e8f0ff"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.008}
        outlineColor="#05070e"
      >
        {props.emoji} {props.label}
      </Text>

      {/* Status text */}
      <Text
        position={[0, 1.38, -0.25]}
        fontSize={0.09}
        color={props.statusColor}
        anchorX="center"
        anchorY="middle"
      >
        {statusText}
      </Text>

      {/* Selection glow ring */}
      {props.isSelected ? (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[1.2, 1.35, 32]} />
          <meshBasicMaterial color={props.statusColor} transparent opacity={0.4} />
        </mesh>
      ) : null}

      {/* Hover glow — opacity driven imperatively in useFrame */}
      {!props.isSelected ? (
        <mesh ref={hoverGlowRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
          <ringGeometry args={[1.2, 1.3, 32]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0} />
        </mesh>
      ) : null}
    </group>
  );
}
