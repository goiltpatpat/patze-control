import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Text } from '@react-three/drei';
import type { Group } from 'three';

interface VoxelDinosaurProps {
  readonly position: [number, number, number];
  readonly rotation?: [number, number, number];
  readonly color?: string;
}

export function VoxelDinosaur(props: VoxelDinosaurProps): JSX.Element {
  const [px, py, pz] = props.position;
  const [rx, ry, rz] = props.rotation ?? [0, 0, 0];
  const color = props.color ?? '#44bb77';
  const belly = '#6edd99';
  const dark = '#2a8855';

  const headRef = useRef<Group>(null);
  const tailRef = useRef<Group>(null);
  const jawRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const leftArmRef = useRef<Group>(null);
  const rightArmRef = useRef<Group>(null);

  useFrame((state) => {
    const t = state.clock.elapsedTime;

    if (headRef.current) {
      headRef.current.rotation.y = Math.sin(t * 0.6) * 0.12;
      headRef.current.rotation.x = Math.sin(t * 0.8) * 0.04;
    }

    if (jawRef.current) {
      jawRef.current.rotation.x = Math.max(0, Math.sin(t * 1.2) * 0.15);
    }

    if (tailRef.current) {
      tailRef.current.rotation.y = Math.sin(t * 0.9 + 1) * 0.2;
    }

    if (bodyRef.current) {
      bodyRef.current.position.y = py + Math.sin(t * 1.5) * 0.008;
    }

    if (leftArmRef.current) {
      leftArmRef.current.rotation.x = Math.sin(t * 2) * 0.25;
    }
    if (rightArmRef.current) {
      rightArmRef.current.rotation.x = Math.sin(t * 2 + Math.PI) * 0.25;
    }
  });

  return (
    <group position={[px, py, pz]} rotation={[rx, ry, rz]}>
      <group ref={bodyRef}>
        {/* BODY - main torso */}
        <Box args={[0.5, 0.55, 0.4]} position={[0, 0.7, 0]}>
          <meshStandardMaterial color={color} roughness={0.7} />
        </Box>

        {/* BELLY */}
        <Box args={[0.42, 0.45, 0.1]} position={[0, 0.68, 0.16]}>
          <meshStandardMaterial color={belly} roughness={0.7} />
        </Box>

        {/* BACK RIDGE - spinal plates */}
        {[0.18, 0.08, -0.02, -0.12].map((zOff, i) => (
          <Box
            key={`spine-${i}`}
            args={[0.06, 0.08 + i * 0.01, 0.04]}
            position={[0, 1.02 + i * 0.01, zOff]}
          >
            <meshStandardMaterial color={dark} roughness={0.6} />
          </Box>
        ))}

        {/* HEAD */}
        <group ref={headRef} position={[0, 0.95, 0.22]}>
          {/* Skull */}
          <Box args={[0.38, 0.32, 0.36]} position={[0, 0.08, 0.12]}>
            <meshStandardMaterial color={color} roughness={0.7} />
          </Box>

          {/* Snout */}
          <Box args={[0.3, 0.22, 0.2]} position={[0, 0, 0.34]}>
            <meshStandardMaterial color={color} roughness={0.7} />
          </Box>

          {/* Snout belly */}
          <Box args={[0.24, 0.12, 0.18]} position={[0, -0.04, 0.34]}>
            <meshStandardMaterial color={belly} roughness={0.7} />
          </Box>

          {/* Nostrils */}
          <Box args={[0.04, 0.04, 0.02]} position={[-0.06, 0.04, 0.445]}>
            <meshStandardMaterial color={dark} />
          </Box>
          <Box args={[0.04, 0.04, 0.02]} position={[0.06, 0.04, 0.445]}>
            <meshStandardMaterial color={dark} />
          </Box>

          {/* Eyes */}
          <Box args={[0.09, 0.09, 0.04]} position={[-0.14, 0.14, 0.22]}>
            <meshStandardMaterial color="#ffffee" roughness={0.3} />
          </Box>
          <Box args={[0.09, 0.09, 0.04]} position={[0.14, 0.14, 0.22]}>
            <meshStandardMaterial color="#ffffee" roughness={0.3} />
          </Box>

          {/* Pupils */}
          <Box args={[0.045, 0.06, 0.02]} position={[-0.14, 0.13, 0.24]}>
            <meshStandardMaterial color="#111122" />
          </Box>
          <Box args={[0.045, 0.06, 0.02]} position={[0.14, 0.13, 0.24]}>
            <meshStandardMaterial color="#111122" />
          </Box>

          {/* Eye highlight */}
          <Box args={[0.02, 0.02, 0.01]} position={[-0.12, 0.16, 0.25]}>
            <meshStandardMaterial color="#ffffff" />
          </Box>
          <Box args={[0.02, 0.02, 0.01]} position={[0.16, 0.16, 0.25]}>
            <meshStandardMaterial color="#ffffff" />
          </Box>

          {/* Brow ridges */}
          <Box args={[0.11, 0.03, 0.06]} position={[-0.14, 0.2, 0.2]}>
            <meshStandardMaterial color={dark} roughness={0.6} />
          </Box>
          <Box args={[0.11, 0.03, 0.06]} position={[0.14, 0.2, 0.2]}>
            <meshStandardMaterial color={dark} roughness={0.6} />
          </Box>

          {/* JAW (animated) */}
          <group ref={jawRef} position={[0, -0.08, 0.2]}>
            <Box args={[0.28, 0.06, 0.28]} position={[0, -0.03, 0.05]}>
              <meshStandardMaterial color={color} roughness={0.7} />
            </Box>

            {/* Teeth - upper */}
            {[-0.08, 0, 0.08].map((tx, i) => (
              <Box key={`tooth-u-${i}`} args={[0.03, 0.04, 0.02]} position={[tx, -0.01, 0.2]}>
                <meshStandardMaterial color="#ffffee" />
              </Box>
            ))}

            {/* Teeth - lower */}
            {[-0.05, 0.05].map((tx, i) => (
              <Box key={`tooth-l-${i}`} args={[0.025, 0.035, 0.02]} position={[tx, -0.06, 0.18]}>
                <meshStandardMaterial color="#ffffee" />
              </Box>
            ))}
          </group>

          {/* Head spikes */}
          <Box args={[0.04, 0.06, 0.04]} position={[-0.1, 0.26, 0.05]}>
            <meshStandardMaterial color={dark} />
          </Box>
          <Box args={[0.04, 0.06, 0.04]} position={[0.1, 0.26, 0.05]}>
            <meshStandardMaterial color={dark} />
          </Box>
        </group>

        {/* ARMS (tiny T-Rex arms) */}
        <group ref={leftArmRef} position={[-0.28, 0.82, 0.12]}>
          <Box args={[0.08, 0.2, 0.08]} position={[0, -0.1, 0]}>
            <meshStandardMaterial color={color} roughness={0.7} />
          </Box>
          <Box args={[0.06, 0.06, 0.06]} position={[0, -0.22, 0.02]}>
            <meshStandardMaterial color={belly} roughness={0.7} />
          </Box>
        </group>

        <group ref={rightArmRef} position={[0.28, 0.82, 0.12]}>
          <Box args={[0.08, 0.2, 0.08]} position={[0, -0.1, 0]}>
            <meshStandardMaterial color={color} roughness={0.7} />
          </Box>
          <Box args={[0.06, 0.06, 0.06]} position={[0, -0.22, 0.02]}>
            <meshStandardMaterial color={belly} roughness={0.7} />
          </Box>
        </group>

        {/* LEGS */}
        {/* Left leg */}
        <Box args={[0.18, 0.35, 0.18]} position={[-0.15, 0.28, -0.02]}>
          <meshStandardMaterial color={color} roughness={0.7} />
        </Box>
        <Box args={[0.2, 0.08, 0.28]} position={[-0.15, 0.08, 0.04]}>
          <meshStandardMaterial color={dark} roughness={0.5} />
        </Box>

        {/* Right leg */}
        <Box args={[0.18, 0.35, 0.18]} position={[0.15, 0.28, -0.02]}>
          <meshStandardMaterial color={color} roughness={0.7} />
        </Box>
        <Box args={[0.2, 0.08, 0.28]} position={[0.15, 0.08, 0.04]}>
          <meshStandardMaterial color={dark} roughness={0.5} />
        </Box>

        {/* Toe claws */}
        {[-0.15, 0.15].map((lx) =>
          [-0.04, 0.04].map((tz, j) => (
            <Box key={`claw-${lx}-${j}`} args={[0.04, 0.03, 0.06]} position={[lx, 0.05, 0.16 + tz]}>
              <meshStandardMaterial color="#ddddcc" roughness={0.4} />
            </Box>
          ))
        )}

        {/* TAIL */}
        <group ref={tailRef} position={[0, 0.65, -0.22]}>
          <Box args={[0.3, 0.28, 0.3]} position={[0, 0, -0.1]}>
            <meshStandardMaterial color={color} roughness={0.7} />
          </Box>
          <Box args={[0.22, 0.2, 0.28]} position={[0, -0.02, -0.35]}>
            <meshStandardMaterial color={color} roughness={0.7} />
          </Box>
          <Box args={[0.14, 0.14, 0.25]} position={[0, -0.04, -0.58]}>
            <meshStandardMaterial color={color} roughness={0.7} />
          </Box>
          <Box args={[0.08, 0.08, 0.2]} position={[0, -0.06, -0.76]}>
            <meshStandardMaterial color={dark} roughness={0.7} />
          </Box>

          {/* Tail spikes */}
          {[-0.15, -0.35, -0.55].map((tz, i) => (
            <Box
              key={`tail-spike-${i}`}
              args={[0.04, 0.05 - i * 0.01, 0.04]}
              position={[0, 0.16 - i * 0.04, tz]}
            >
              <meshStandardMaterial color={dark} />
            </Box>
          ))}
        </group>

        {/* Nameplate */}
        <Text
          position={[0, 1.45, 0.2]}
          fontSize={0.09}
          color="#88ddaa"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.004}
          outlineColor="#05070e"
        >
          {'🦖 Rex'}
        </Text>
      </group>
    </group>
  );
}
