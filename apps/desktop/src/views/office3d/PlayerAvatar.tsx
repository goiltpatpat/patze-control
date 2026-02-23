import { useRef, useEffect, useCallback } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Box, Text, Cylinder } from '@react-three/drei';
import { Vector3 } from 'three';
import type { Group } from 'three';

interface Obstacle {
  readonly position: Vector3;
  readonly radius: number;
}

interface NearbyObject {
  readonly id: string;
  readonly type: 'desk' | 'furniture';
  readonly position: Vector3;
  readonly radius: number;
}

interface PlayerAvatarProps {
  readonly obstacles: readonly Obstacle[];
  readonly nearbyObjects: readonly NearbyObject[];
  readonly onInteract: (objectId: string, objectType: 'desk' | 'furniture') => void;
  readonly onPositionUpdate?: (x: number, z: number) => void;
  readonly officeBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

const MOVE_SPEED = 3.5;
const SPRINT_SPEED = 5.5;
const AVATAR_RADIUS = 0.35;
const INTERACT_RANGE = 2.5;
const CAMERA_LERP = 0.06;
const CAMERA_OFFSET = new Vector3(0, 8, 10);

export function PlayerAvatar(props: PlayerAvatarProps): JSX.Element {
  const { camera } = useThree();
  const groupRef = useRef<Group>(null);
  const bodyRef = useRef<Group>(null);
  const leftLegRef = useRef<Group>(null);
  const rightLegRef = useRef<Group>(null);
  const leftArmRef = useRef<Group>(null);
  const rightArmRef = useRef<Group>(null);
  const headRef = useRef<Group>(null);

  const position = useRef(new Vector3(0, 0, 6));
  const facing = useRef(0);
  const isMoving = useRef(false);
  const keys = useRef(new Set<string>());
  const propsRef = useRef(props);
  propsRef.current = props;

  const scratchDir = useRef(new Vector3());
  const scratchCamTarget = useRef(new Vector3());
  const scratchNewPos = useRef(new Vector3());

  const nearestRef = useRef<NearbyObject | null>(null);
  const interactCooldown = useRef(0);
  const frameCounter = useRef(0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      keys.current.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys.current.delete(e.code);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const checkCollision = useCallback((pos: Vector3): boolean => {
    const p = propsRef.current;
    if (
      pos.x - AVATAR_RADIUS < p.officeBounds.minX ||
      pos.x + AVATAR_RADIUS > p.officeBounds.maxX ||
      pos.z - AVATAR_RADIUS < p.officeBounds.minZ ||
      pos.z + AVATAR_RADIUS > p.officeBounds.maxZ
    ) {
      return true;
    }
    for (const obs of p.obstacles) {
      const dx = pos.x - obs.position.x;
      const dz = pos.z - obs.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < obs.radius + AVATAR_RADIUS) return true;
    }
    return false;
  }, []);

  useFrame((state, delta) => {
    const p = propsRef.current;
    const pressed = keys.current;
    const dir = scratchDir.current.set(0, 0, 0);

    if (pressed.has('KeyW') || pressed.has('ArrowUp')) dir.z -= 1;
    if (pressed.has('KeyS') || pressed.has('ArrowDown')) dir.z += 1;
    if (pressed.has('KeyA') || pressed.has('ArrowLeft')) dir.x -= 1;
    if (pressed.has('KeyD') || pressed.has('ArrowRight')) dir.x += 1;

    const sprinting = pressed.has('ShiftLeft') || pressed.has('ShiftRight');
    const speed = sprinting ? SPRINT_SPEED : MOVE_SPEED;
    const moving = dir.length() > 0;
    isMoving.current = moving;

    if (moving) {
      dir.normalize();
      facing.current = Math.atan2(dir.x, dir.z);

      const newPos = scratchNewPos.current;
      newPos.copy(position.current);
      newPos.x += dir.x * speed * delta;
      newPos.z += dir.z * speed * delta;

      if (!checkCollision(newPos)) {
        position.current.copy(newPos);
      } else {
        const slideX = scratchNewPos.current.copy(position.current);
        slideX.x += dir.x * speed * delta;
        if (!checkCollision(slideX)) {
          position.current.x = slideX.x;
        }
        const slideZ = scratchNewPos.current.copy(position.current);
        slideZ.z += dir.z * speed * delta;
        if (!checkCollision(slideZ)) {
          position.current.z = slideZ.z;
        }
      }
    }

    if (groupRef.current) {
      groupRef.current.position.set(position.current.x, 0, position.current.z);
      const targetAngle = facing.current;
      const currentAngle = groupRef.current.rotation.y;
      let diff = targetAngle - currentAngle;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      groupRef.current.rotation.y = currentAngle + diff * 0.12;
    }

    const t = state.clock.elapsedTime;
    const walkCycle = moving ? t * (sprinting ? 14 : 10) : 0;
    const legSwing = moving ? Math.sin(walkCycle) * 0.5 : 0;
    const armSwing = moving ? Math.sin(walkCycle) * 0.4 : 0;
    const headBob = moving ? Math.sin(walkCycle * 2) * 0.01 : 0;

    if (leftLegRef.current) leftLegRef.current.rotation.x = legSwing;
    if (rightLegRef.current) rightLegRef.current.rotation.x = -legSwing;
    if (leftArmRef.current) leftArmRef.current.rotation.x = -armSwing;
    if (rightArmRef.current) rightArmRef.current.rotation.x = armSwing;
    if (headRef.current) headRef.current.position.y = 1.55 + headBob;
    if (bodyRef.current) bodyRef.current.position.y = headBob * 0.5;

    const camTarget = scratchCamTarget.current;
    camTarget.set(
      position.current.x + CAMERA_OFFSET.x,
      CAMERA_OFFSET.y,
      position.current.z + CAMERA_OFFSET.z
    );
    camera.position.lerp(camTarget, CAMERA_LERP);
    camera.lookAt(position.current.x, 0.8, position.current.z);

    if (frameCounter.current >= 10) {
      frameCounter.current = 0;
      p.onPositionUpdate?.(position.current.x, position.current.z);
    }
    frameCounter.current += 1;

    let nearest: NearbyObject | null = null;
    let nearestDist = INTERACT_RANGE;
    for (const obj of p.nearbyObjects) {
      const dx = position.current.x - obj.position.x;
      const dz = position.current.z - obj.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = obj;
      }
    }
    nearestRef.current = nearest;

    if (interactCooldown.current > 0) {
      interactCooldown.current -= delta;
    }

    if ((pressed.has('KeyE') || pressed.has('Space')) && nearest && interactCooldown.current <= 0) {
      interactCooldown.current = 0.5;
      p.onInteract(nearest.id, nearest.type);
    }
  });

  const groundOffset = -0.53;
  const playerColor = '#4a9eff';
  const skinColor = '#f0d0b0';
  const pantsColor = '#1a2a4a';
  const shoeColor = '#1a1a22';

  return (
    <group ref={groupRef} position={[0, 0, 6]}>
      <group position={[0, groundOffset, 0]}>
        <group ref={bodyRef}>
          {/* HEAD */}
          <group ref={headRef} position={[0, 1.55, 0]}>
            <Box args={[0.3, 0.3, 0.3]} position={[0, 0, 0]}>
              <meshStandardMaterial color={skinColor} roughness={0.8} />
            </Box>

            <Box args={[0.06, 0.06, 0.02]} position={[-0.08, 0.04, 0.15]}>
              <meshStandardMaterial color="#1a1a2a" />
            </Box>
            <Box args={[0.06, 0.06, 0.02]} position={[0.08, 0.04, 0.15]}>
              <meshStandardMaterial color="#1a1a2a" />
            </Box>
            <Box args={[0.03, 0.03, 0.01]} position={[-0.08, 0.04, 0.16]}>
              <meshStandardMaterial color="#ffffff" />
            </Box>
            <Box args={[0.03, 0.03, 0.01]} position={[0.08, 0.04, 0.16]}>
              <meshStandardMaterial color="#ffffff" />
            </Box>

            <Box args={[0.1, 0.02, 0.02]} position={[0, -0.06, 0.15]}>
              <meshStandardMaterial color="#cc8888" />
            </Box>

            <Text position={[0, 0.3, 0]} fontSize={0.2} anchorX="center" anchorY="middle">
              {'👤'}
            </Text>
          </group>

          {/* TORSO */}
          <Box args={[0.34, 0.44, 0.22]} position={[0, 1.2, 0]}>
            <meshStandardMaterial color={playerColor} roughness={0.6} metalness={0.1} />
          </Box>

          {/* LEFT ARM */}
          <group ref={leftArmRef} position={[-0.26, 1.37, 0]}>
            <Box args={[0.1, 0.4, 0.1]} position={[0, -0.2, 0]}>
              <meshStandardMaterial color={playerColor} roughness={0.6} />
            </Box>
            <Box args={[0.09, 0.09, 0.09]} position={[0, -0.43, 0]}>
              <meshStandardMaterial color={skinColor} roughness={0.8} />
            </Box>
          </group>

          {/* RIGHT ARM */}
          <group ref={rightArmRef} position={[0.26, 1.37, 0]}>
            <Box args={[0.1, 0.4, 0.1]} position={[0, -0.2, 0]}>
              <meshStandardMaterial color={playerColor} roughness={0.6} />
            </Box>
            <Box args={[0.09, 0.09, 0.09]} position={[0, -0.43, 0]}>
              <meshStandardMaterial color={skinColor} roughness={0.8} />
            </Box>
          </group>

          {/* LEFT LEG */}
          <group ref={leftLegRef} position={[-0.09, 0.98, 0]}>
            <Box args={[0.13, 0.42, 0.13]} position={[0, -0.21, 0]}>
              <meshStandardMaterial color={pantsColor} roughness={0.7} />
            </Box>
            <Box args={[0.14, 0.06, 0.19]} position={[0, -0.44, 0.03]}>
              <meshStandardMaterial color={shoeColor} roughness={0.5} metalness={0.2} />
            </Box>
          </group>

          {/* RIGHT LEG */}
          <group ref={rightLegRef} position={[0.09, 0.98, 0]}>
            <Box args={[0.13, 0.42, 0.13]} position={[0, -0.21, 0]}>
              <meshStandardMaterial color={pantsColor} roughness={0.7} />
            </Box>
            <Box args={[0.14, 0.06, 0.19]} position={[0, -0.44, 0.03]}>
              <meshStandardMaterial color={shoeColor} roughness={0.5} metalness={0.2} />
            </Box>
          </group>
        </group>
      </group>

      {/* Player marker glow ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <ringGeometry args={[0.4, 0.52, 32]} />
        <meshBasicMaterial color={playerColor} transparent opacity={0.35} />
      </mesh>

      {/* Direction indicator */}
      <Cylinder
        args={[0, 0.08, 0.15, 4]}
        position={[0, 0.02, -0.55]}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <meshBasicMaterial color={playerColor} transparent opacity={0.5} />
      </Cylinder>

      {/* "YOU" label */}
      <Text
        position={[0, 2.1, 0]}
        fontSize={0.12}
        color={playerColor}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.006}
        outlineColor="#05070e"
      >
        YOU
      </Text>

      {/* Interaction prompt */}
      <InteractionPrompt nearestRef={nearestRef} playerPos={position} />
    </group>
  );
}

function InteractionPrompt(props: {
  readonly nearestRef: React.RefObject<NearbyObject | null>;
  readonly playerPos: React.RefObject<Vector3>;
}): JSX.Element | null {
  const ref = useRef<Group>(null);
  const visibleRef = useRef(false);

  useFrame(() => {
    if (!ref.current) return;
    const nearest = props.nearestRef.current;
    if (nearest) {
      visibleRef.current = true;
      ref.current.visible = true;
      ref.current.position.set(0, 2.4, 0);
    } else {
      visibleRef.current = false;
      ref.current.visible = false;
    }
  });

  return (
    <group ref={ref} visible={false}>
      <Text
        position={[0, 0, 0]}
        fontSize={0.1}
        color="#ffcc44"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.005}
        outlineColor="#05070e"
      >
        Press E to interact
      </Text>
    </group>
  );
}
