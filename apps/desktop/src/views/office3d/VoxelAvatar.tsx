import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Text } from '@react-three/drei';
import type { Group } from 'three';

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface VoxelAvatarProps {
  readonly emoji: string;
  readonly color: string;
  readonly status: DeskStatus;
  readonly position: [number, number, number];
}

export function VoxelAvatar(props: VoxelAvatarProps): JSX.Element {
  const headRef = useRef<Group>(null);
  const leftArmRef = useRef<Group>(null);
  const rightArmRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const statusRef = useRef(props.status);
  statusRef.current = props.status;
  const [px, py, pz] = props.position;

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const status = statusRef.current;

    if (bodyRef.current) bodyRef.current.position.y = py;
    if (headRef.current) {
      headRef.current.rotation.x = 0;
      headRef.current.rotation.y = 0;
      headRef.current.rotation.z = 0;
    }
    if (leftArmRef.current) leftArmRef.current.rotation.x = 0;
    if (rightArmRef.current) rightArmRef.current.rotation.x = 0;

    switch (status) {
      case 'active': {
        if (leftArmRef.current) {
          leftArmRef.current.rotation.x = Math.sin(t * 8) * 0.15;
        }
        if (rightArmRef.current) {
          rightArmRef.current.rotation.x = Math.sin(t * 8 + Math.PI) * 0.15;
        }
        if (headRef.current) {
          headRef.current.rotation.y = Math.sin(t * 0.5) * 0.05;
        }
        break;
      }
      case 'idle': {
        if (bodyRef.current) {
          bodyRef.current.position.y = py + Math.sin(t * 1.2) * 0.015;
        }
        if (headRef.current) {
          headRef.current.rotation.y = Math.sin(t * 0.3) * 0.08;
        }
        break;
      }
      case 'error': {
        if (headRef.current) {
          headRef.current.rotation.z = Math.sin(t * 12) * 0.08;
        }
        break;
      }
      case 'offline': {
        if (headRef.current) {
          headRef.current.rotation.x = 0.2;
        }
        break;
      }
    }
  });

  const skinColor = '#f0d0b0';
  const shirtColor = props.color;
  const pantsColor = '#2a2a3a';
  const shoeColor = '#1a1a22';

  const groundOffset = -0.53;

  return (
    <group ref={bodyRef} position={[px, py, pz]}>
      <group position={[0, groundOffset, 0]}>
        {/* HEAD */}
        <group ref={headRef} position={[0, 1.55, 0]}>
          <Box args={[0.28, 0.28, 0.28]} position={[0, 0, 0]}>
            <meshStandardMaterial color={skinColor} roughness={0.8} />
          </Box>

          {/* Eyes */}
          <Box args={[0.05, 0.05, 0.02]} position={[-0.07, 0.03, 0.14]}>
            <meshStandardMaterial color="#1a1a2a" />
          </Box>
          <Box args={[0.05, 0.05, 0.02]} position={[0.07, 0.03, 0.14]}>
            <meshStandardMaterial color="#1a1a2a" />
          </Box>

          {/* Pupils */}
          <Box args={[0.025, 0.025, 0.01]} position={[-0.07, 0.03, 0.155]}>
            <meshStandardMaterial color="#ffffff" />
          </Box>
          <Box args={[0.025, 0.025, 0.01]} position={[0.07, 0.03, 0.155]}>
            <meshStandardMaterial color="#ffffff" />
          </Box>

          {/* Mouth */}
          <Box args={[0.1, 0.02, 0.02]} position={[0, -0.06, 0.14]}>
            <meshStandardMaterial color={props.status === 'error' ? '#ee5555' : '#cc8888'} />
          </Box>

          <Text position={[0, 0.28, 0]} fontSize={0.18} anchorX="center" anchorY="middle">
            {props.emoji}
          </Text>

          {props.status === 'error' ? (
            <>
              <mesh position={[0.2, 0.2, 0]}>
                <sphereGeometry args={[0.02, 6, 6]} />
                <meshBasicMaterial color="#ff4444" />
              </mesh>
              <mesh position={[-0.15, 0.25, 0.1]}>
                <sphereGeometry args={[0.015, 6, 6]} />
                <meshBasicMaterial color="#ff6644" />
              </mesh>
            </>
          ) : null}
        </group>

        {/* BODY / TORSO */}
        <Box args={[0.3, 0.4, 0.2]} position={[0, 1.2, 0]}>
          <meshStandardMaterial color={shirtColor} roughness={0.7} />
        </Box>

        {/* LEFT ARM - group pivots at shoulder so hand follows rotation */}
        <group ref={leftArmRef} position={[-0.24, 1.37, 0]}>
          <Box args={[0.1, 0.38, 0.1]} position={[0, -0.19, 0]}>
            <meshStandardMaterial color={shirtColor} roughness={0.7} />
          </Box>
          <Box args={[0.08, 0.08, 0.08]} position={[0, -0.41, 0]}>
            <meshStandardMaterial color={skinColor} roughness={0.8} />
          </Box>
        </group>

        {/* RIGHT ARM - group pivots at shoulder so hand follows rotation */}
        <group ref={rightArmRef} position={[0.24, 1.37, 0]}>
          <Box args={[0.1, 0.38, 0.1]} position={[0, -0.19, 0]}>
            <meshStandardMaterial color={shirtColor} roughness={0.7} />
          </Box>
          <Box args={[0.08, 0.08, 0.08]} position={[0, -0.41, 0]}>
            <meshStandardMaterial color={skinColor} roughness={0.8} />
          </Box>
        </group>

        {/* LEGS */}
        <Box args={[0.12, 0.4, 0.12]} position={[-0.08, 0.78, 0]}>
          <meshStandardMaterial color={pantsColor} roughness={0.7} />
        </Box>
        <Box args={[0.12, 0.4, 0.12]} position={[0.08, 0.78, 0]}>
          <meshStandardMaterial color={pantsColor} roughness={0.7} />
        </Box>

        {/* SHOES */}
        <Box args={[0.13, 0.06, 0.18]} position={[-0.08, 0.56, 0.03]}>
          <meshStandardMaterial color={shoeColor} roughness={0.5} metalness={0.2} />
        </Box>
        <Box args={[0.13, 0.06, 0.18]} position={[0.08, 0.56, 0.03]}>
          <meshStandardMaterial color={shoeColor} roughness={0.5} metalness={0.2} />
        </Box>
      </group>
    </group>
  );
}
