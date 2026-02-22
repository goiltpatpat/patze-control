import { useRef, useMemo, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Text, Cylinder } from '@react-three/drei';
import type { Group } from 'three';

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface VoxelAvatarProps {
  readonly agentId?: string;
  readonly label?: string;
  readonly emoji: string;
  readonly color: string;
  readonly status: DeskStatus;
  readonly position: [number, number, number];
  readonly walkingRef?: MutableRefObject<boolean>;
}

interface AvatarTraits {
  skin: string;
  shirt: string;
  pants: string;
  shoes: string;
  hair: string;
  hairStyle: 'none' | 'flat' | 'spiky' | 'side' | 'tall';
  hasGlasses: boolean;
  hasTie: boolean;
  tieColor: string;
  eyeColor: string;
}

const SKIN_TONES = [
  '#f9dcc4', '#f5c7a1', '#e8b48a', '#d4956b',
  '#c68642', '#a0622e', '#8d5524', '#6b3e1f',
  '#ffe0bd', '#f7c5a0',
];
const SHIRT_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#a855f7', '#f59e0b',
  '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#06b6d4',
  '#84cc16', '#e11d48', '#0ea5e9', '#8b5cf6', '#10b981',
];
const PANTS_COLORS = [
  '#1e293b', '#334155', '#1a1a2e', '#2d2d44', '#3b3b56',
  '#1e3a5f', '#2c1810', '#3d2914',
];
const SHOE_COLORS = [
  '#1a1a22', '#2d1b0e', '#111827', '#4a2c1a', '#1f1f2e',
  '#3d1c00', '#0f172a',
];
const HAIR_COLORS = [
  '#1a1a1a', '#3b2414', '#8b6914', '#c4a35a',
  '#e63946', '#2d3436', '#6c5ce7', '#a8a8a8',
  '#4a2c17', '#d4a574',
];
const EYE_COLORS = ['#1a1a2a', '#2c5f7c', '#3d6b3d', '#6b4226', '#4a3a6a'];
const TIE_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899'];

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function pick<T>(arr: readonly T[], hash: number, offset: number): T {
  return arr[((hash >>> offset) ^ (hash >>> (offset + 7))) % arr.length]!;
}

function deriveTraits(agentId: string): AvatarTraits {
  const h = hashId(agentId);
  const h2 = hashId(agentId + ':traits');

  const styles: AvatarTraits['hairStyle'][] = ['none', 'flat', 'spiky', 'side', 'tall'];

  return {
    skin: pick(SKIN_TONES, h, 0),
    shirt: pick(SHIRT_COLORS, h, 4),
    pants: pick(PANTS_COLORS, h, 8),
    shoes: pick(SHOE_COLORS, h, 12),
    hair: pick(HAIR_COLORS, h, 16),
    hairStyle: styles[h2 % styles.length]!,
    hasGlasses: h2 % 4 === 0,
    hasTie: h2 % 5 === 0,
    tieColor: pick(TIE_COLORS, h2, 3),
    eyeColor: pick(EYE_COLORS, h2, 6),
  };
}

export function VoxelAvatar(props: VoxelAvatarProps): JSX.Element {
  const headRef = useRef<Group>(null);
  const leftArmRef = useRef<Group>(null);
  const rightArmRef = useRef<Group>(null);
  const leftLegRef = useRef<Group>(null);
  const rightLegRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const statusRef = useRef(props.status);
  statusRef.current = props.status;
  const walkRefProp = props.walkingRef;
  const [px, py, pz] = props.position;

  const traits = useMemo(
    () => (props.agentId ? deriveTraits(props.agentId) : null),
    [props.agentId],
  );

  const skinColor = traits?.skin ?? '#f0d0b0';
  const shirtColor = traits?.shirt ?? props.color;
  const pantsColor = traits?.pants ?? '#2a2a3a';
  const shoeColor = traits?.shoes ?? '#1a1a22';
  const hairColor = traits?.hair ?? '#3b2414';
  const hairStyle = traits?.hairStyle ?? 'flat';
  const hasGlasses = traits?.hasGlasses ?? false;
  const hasTie = traits?.hasTie ?? false;
  const tieColor = traits?.tieColor ?? '#ef4444';
  const eyeColor = traits?.eyeColor ?? '#1a1a2a';

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const status = statusRef.current;
    const walking = walkRefProp?.current ?? false;

    if (bodyRef.current) bodyRef.current.position.y = py;
    if (headRef.current) {
      headRef.current.rotation.x = 0;
      headRef.current.rotation.y = 0;
      headRef.current.rotation.z = 0;
    }
    if (leftArmRef.current) leftArmRef.current.rotation.x = 0;
    if (rightArmRef.current) rightArmRef.current.rotation.x = 0;
    if (leftLegRef.current) leftLegRef.current.rotation.x = 0;
    if (rightLegRef.current) rightLegRef.current.rotation.x = 0;

    if (walking) {
      const walkCycle = t * 4;
      const legSwing = Math.sin(walkCycle) * 0.35;
      const armSwing = Math.sin(walkCycle) * 0.25;
      const headBob = Math.sin(walkCycle * 2) * 0.008;

      if (leftLegRef.current) leftLegRef.current.rotation.x = legSwing;
      if (rightLegRef.current) rightLegRef.current.rotation.x = -legSwing;
      if (leftArmRef.current) leftArmRef.current.rotation.x = -armSwing;
      if (rightArmRef.current) rightArmRef.current.rotation.x = armSwing;
      if (bodyRef.current) bodyRef.current.position.y = py + headBob;
      return;
    }

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

  const groundOffset = -0.53;

  return (
    <group ref={bodyRef} position={[px, py, pz]}>
      <group position={[0, groundOffset, 0]}>
        {/* HEAD */}
        <group ref={headRef} position={[0, 1.55, 0]}>
          <Box args={[0.28, 0.28, 0.28]} position={[0, 0, 0]}>
            <meshStandardMaterial color={skinColor} roughness={0.8} />
          </Box>

          {/* HAIR */}
          {hairStyle === 'flat' ? (
            <Box args={[0.3, 0.08, 0.3]} position={[0, 0.16, -0.01]}>
              <meshStandardMaterial color={hairColor} roughness={0.9} />
            </Box>
          ) : null}
          {hairStyle === 'spiky' ? (
            <>
              <Box args={[0.3, 0.12, 0.3]} position={[0, 0.18, -0.01]}>
                <meshStandardMaterial color={hairColor} roughness={0.9} />
              </Box>
              <Box args={[0.08, 0.08, 0.08]} position={[-0.08, 0.24, 0.02]}>
                <meshStandardMaterial color={hairColor} roughness={0.9} />
              </Box>
              <Box args={[0.08, 0.08, 0.08]} position={[0.08, 0.26, -0.02]}>
                <meshStandardMaterial color={hairColor} roughness={0.9} />
              </Box>
              <Box args={[0.06, 0.07, 0.06]} position={[0, 0.27, 0.04]}>
                <meshStandardMaterial color={hairColor} roughness={0.9} />
              </Box>
            </>
          ) : null}
          {hairStyle === 'side' ? (
            <>
              <Box args={[0.3, 0.06, 0.3]} position={[0, 0.16, -0.01]}>
                <meshStandardMaterial color={hairColor} roughness={0.9} />
              </Box>
              <Box args={[0.06, 0.18, 0.28]} position={[0.16, 0.06, -0.01]}>
                <meshStandardMaterial color={hairColor} roughness={0.9} />
              </Box>
            </>
          ) : null}
          {hairStyle === 'tall' ? (
            <Box args={[0.26, 0.2, 0.26]} position={[0, 0.22, -0.01]}>
              <meshStandardMaterial color={hairColor} roughness={0.9} />
            </Box>
          ) : null}

          {/* EYES */}
          <Box args={[0.05, 0.05, 0.02]} position={[-0.07, 0.03, 0.14]}>
            <meshStandardMaterial color={eyeColor} />
          </Box>
          <Box args={[0.05, 0.05, 0.02]} position={[0.07, 0.03, 0.14]}>
            <meshStandardMaterial color={eyeColor} />
          </Box>

          {/* PUPILS */}
          <Box args={[0.025, 0.025, 0.01]} position={[-0.07, 0.03, 0.155]}>
            <meshStandardMaterial color="#ffffff" />
          </Box>
          <Box args={[0.025, 0.025, 0.01]} position={[0.07, 0.03, 0.155]}>
            <meshStandardMaterial color="#ffffff" />
          </Box>

          {/* GLASSES */}
          {hasGlasses ? (
            <>
              <Box args={[0.08, 0.06, 0.02]} position={[-0.07, 0.03, 0.155]}>
                <meshStandardMaterial
                  color="#333333"
                  transparent
                  opacity={0.4}
                  metalness={0.5}
                />
              </Box>
              <Box args={[0.08, 0.06, 0.02]} position={[0.07, 0.03, 0.155]}>
                <meshStandardMaterial
                  color="#333333"
                  transparent
                  opacity={0.4}
                  metalness={0.5}
                />
              </Box>
              <Box args={[0.04, 0.015, 0.015]} position={[0, 0.035, 0.155]}>
                <meshStandardMaterial color="#555555" metalness={0.6} />
              </Box>
            </>
          ) : null}

          {/* MOUTH */}
          <Box args={[0.1, 0.02, 0.02]} position={[0, -0.06, 0.14]}>
            <meshStandardMaterial
              color={props.status === 'error' ? '#ee5555' : '#cc8888'}
            />
          </Box>

          {/* NAME + EMOJI floating above head */}
          <Text
            position={[0, 0.28 + (hairStyle === 'tall' ? 0.15 : hairStyle === 'spiky' ? 0.1 : 0), 0]}
            fontSize={0.18}
            anchorX="center"
            anchorY="middle"
          >
            {props.emoji}
          </Text>
          {props.label ? (
            <Text
              position={[0, 0.48 + (hairStyle === 'tall' ? 0.15 : hairStyle === 'spiky' ? 0.1 : 0), 0]}
              fontSize={0.08}
              color="#e0e8f0"
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.004}
              outlineColor="#0a0e17"
            >
              {props.label}
            </Text>
          ) : null}

          {/* ERROR PARTICLES */}
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

        {/* TIE */}
        {hasTie ? (
          <>
            <Box args={[0.06, 0.04, 0.02]} position={[0, 1.36, 0.11]}>
              <meshStandardMaterial color={tieColor} roughness={0.6} />
            </Box>
            <Box args={[0.04, 0.2, 0.02]} position={[0, 1.2, 0.11]}>
              <meshStandardMaterial color={tieColor} roughness={0.6} />
            </Box>
            <Box args={[0.06, 0.06, 0.02]} position={[0, 1.08, 0.11]}>
              <meshStandardMaterial color={tieColor} roughness={0.6} />
            </Box>
          </>
        ) : null}

        {/* COLLAR (when has tie) */}
        {hasTie ? (
          <>
            <Box args={[0.08, 0.04, 0.06]} position={[-0.08, 1.38, 0.08]}>
              <meshStandardMaterial color="#f0f0f0" roughness={0.7} />
            </Box>
            <Box args={[0.08, 0.04, 0.06]} position={[0.08, 1.38, 0.08]}>
              <meshStandardMaterial color="#f0f0f0" roughness={0.7} />
            </Box>
          </>
        ) : null}

        {/* LEFT ARM */}
        <group ref={leftArmRef} position={[-0.24, 1.37, 0]}>
          <Box args={[0.1, 0.38, 0.1]} position={[0, -0.19, 0]}>
            <meshStandardMaterial color={shirtColor} roughness={0.7} />
          </Box>
          <Box args={[0.08, 0.08, 0.08]} position={[0, -0.41, 0]}>
            <meshStandardMaterial color={skinColor} roughness={0.8} />
          </Box>
        </group>

        {/* RIGHT ARM */}
        <group ref={rightArmRef} position={[0.24, 1.37, 0]}>
          <Box args={[0.1, 0.38, 0.1]} position={[0, -0.19, 0]}>
            <meshStandardMaterial color={shirtColor} roughness={0.7} />
          </Box>
          <Box args={[0.08, 0.08, 0.08]} position={[0, -0.41, 0]}>
            <meshStandardMaterial color={skinColor} roughness={0.8} />
          </Box>
        </group>

        {/* LEFT LEG */}
        <group ref={leftLegRef} position={[-0.08, 0.98, 0]}>
          <Box args={[0.12, 0.4, 0.12]} position={[0, -0.2, 0]}>
            <meshStandardMaterial color={pantsColor} roughness={0.7} />
          </Box>
          <Box args={[0.13, 0.06, 0.18]} position={[0, -0.42, 0.03]}>
            <meshStandardMaterial
              color={shoeColor}
              roughness={0.5}
              metalness={0.2}
            />
          </Box>
        </group>

        {/* RIGHT LEG */}
        <group ref={rightLegRef} position={[0.08, 0.98, 0]}>
          <Box args={[0.12, 0.4, 0.12]} position={[0, -0.2, 0]}>
            <meshStandardMaterial color={pantsColor} roughness={0.7} />
          </Box>
          <Box args={[0.13, 0.06, 0.18]} position={[0, -0.42, 0.03]}>
            <meshStandardMaterial
              color={shoeColor}
              roughness={0.5}
              metalness={0.2}
            />
          </Box>
        </group>

        {/* STATUS RING on ground */}
        <Cylinder args={[0.25, 0.25, 0.02, 16]} position={[0, 0.54, 0]}>
          <meshBasicMaterial color={props.color} transparent opacity={0.5} />
        </Cylinder>
      </group>
    </group>
  );
}
