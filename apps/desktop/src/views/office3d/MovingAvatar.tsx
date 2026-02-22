import { useRef, useEffect, useCallback, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3 } from 'three';
import type { Group } from 'three';
import { VoxelAvatar } from './VoxelAvatar';

function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface Obstacle {
  readonly position: Vector3;
  readonly radius: number;
}

interface MovingAvatarProps {
  readonly id: string;
  readonly emoji: string;
  readonly color: string;
  readonly status: DeskStatus;
  readonly deskPosition: [number, number, number];
  readonly officeBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  readonly obstacles: readonly Obstacle[];
  readonly otherAvatarPositions: ReadonlyMap<string, Vector3>;
  readonly onPositionUpdate: (id: string, pos: Vector3) => void;
}

function getMovementInterval(status: DeskStatus): [number, number] {
  switch (status) {
    case 'active': return [8000, 15000];
    case 'idle': return [3000, 6000];
    case 'error': return [25000, 40000];
    case 'offline': return [60000, 120000];
  }
}

function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function isCollisionFree(
  pos: Vector3,
  obstacles: readonly Obstacle[],
  otherPositions: ReadonlyMap<string, Vector3>,
  selfId: string,
  avatarRadius: number,
): boolean {
  for (const obs of obstacles) {
    if (pos.distanceTo(obs.position) < obs.radius + avatarRadius) return false;
  }
  for (const [id, otherPos] of otherPositions) {
    if (id === selfId) continue;
    if (pos.distanceTo(otherPos) < avatarRadius * 2.5) return false;
  }
  return true;
}

const POSITION_REPORT_INTERVAL = 10;

export function MovingAvatar(props: MovingAvatarProps): JSX.Element {
  const groupRef = useRef<Group>(null);
  const avatarGroupRef = useRef<Group>(null);
  const currentPos = useRef(new Vector3(props.deskPosition[0], 0, props.deskPosition[2] + 1.2));
  const targetPos = useRef(new Vector3(props.deskPosition[0], 0, props.deskPosition[2] + 1.2));
  const frameCounter = useRef(0);

  const pickNewTarget = useCallback(() => {
    const bounds = props.officeBounds;
    const avatarRadius = 0.4;

    for (let attempt = 0; attempt < 30; attempt++) {
      const candidate = new Vector3(
        randomInRange(bounds.minX + 1, bounds.maxX - 1),
        0,
        randomInRange(bounds.minZ + 1, bounds.maxZ - 1),
      );

      if (props.status === 'active') {
        const dx = props.deskPosition[0];
        const dz = props.deskPosition[2] + 1.2;
        candidate.x = dx + randomInRange(-1.5, 1.5);
        candidate.z = dz + randomInRange(-0.8, 0.8);
      }

      if (isCollisionFree(candidate, props.obstacles, props.otherAvatarPositions, props.id, avatarRadius)) {
        targetPos.current.copy(candidate);
        return;
      }
    }
  }, [props.id, props.status, props.deskPosition, props.officeBounds, props.obstacles, props.otherAvatarPositions]);

  useEffect(() => {
    const [minMs, maxMs] = getMovementInterval(props.status);
    const scheduleNext = () => {
      const delay = randomInRange(minMs, maxMs);
      return window.setTimeout(() => {
        pickNewTarget();
        timerId = scheduleNext();
      }, delay);
    };
    let timerId = scheduleNext();
    return () => { window.clearTimeout(timerId); };
  }, [props.status, pickNewTarget]);

  const propsRef = useLatest(props);
  const scratchDir = useRef(new Vector3());

  useFrame(() => {
    const p = propsRef.current;
    const cur = currentPos.current;
    const tgt = targetPos.current;
    const speed = p.status === 'idle' ? 0.02 : 0.012;

    cur.lerp(tgt, speed);

    frameCounter.current += 1;
    if (frameCounter.current >= POSITION_REPORT_INTERVAL) {
      frameCounter.current = 0;
      p.onPositionUpdate(p.id, cur.clone());
    }

    if (avatarGroupRef.current) {
      avatarGroupRef.current.position.set(cur.x, 0, cur.z);
    }

    if (groupRef.current) {
      scratchDir.current.copy(tgt).sub(cur);
      if (scratchDir.current.length() > 0.05) {
        const angle = Math.atan2(scratchDir.current.x, scratchDir.current.z);
        const currentY = groupRef.current.rotation.y;
        groupRef.current.rotation.y = currentY + (angle - currentY) * 0.05;
      }
    }
  });

  return (
    <group ref={groupRef}>
      <group ref={avatarGroupRef} position={[currentPos.current.x, 0, currentPos.current.z]}>
        <VoxelAvatar
          emoji={props.emoji}
          color={props.color}
          status={props.status}
          position={[0, 0, 0]}
        />
      </group>
    </group>
  );
}
