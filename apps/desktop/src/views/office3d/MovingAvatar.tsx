import { useRef, useEffect, type MutableRefObject } from 'react';
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
  readonly label: string;
  readonly emoji: string;
  readonly color: string;
  readonly status: DeskStatus;
  readonly deskPosition: [number, number, number];
  readonly officeBounds: {
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  };
  readonly obstacles: readonly Obstacle[];
  readonly otherAvatarPositions: ReadonlyMap<string, Vector3>;
  readonly onPositionUpdate: (id: string, pos: Vector3) => void;
}

const MIN_DIST_OBSTACLE = 0.3;
const MIN_DIST_AVATAR = 1.0;
const REPORT_EVERY = 30;

function distSq(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function isPositionFree(
  pos: Vector3,
  obstacles: readonly Obstacle[],
  others: ReadonlyMap<string, Vector3>,
  selfId: string
): boolean {
  for (const obs of obstacles) {
    const minD = obs.radius + MIN_DIST_OBSTACLE;
    if (distSq(pos, obs.position) < minD * minD) {
      return false;
    }
  }
  for (const [id, otherPos] of others) {
    if (id === selfId) continue;
    if (distSq(pos, otherPos) < MIN_DIST_AVATAR * MIN_DIST_AVATAR) {
      return false;
    }
  }
  return true;
}

function getSpeed(status: DeskStatus): number {
  switch (status) {
    case 'idle':
      return 0.9;
    case 'active':
      return 0.5;
    case 'error':
      return 0.35;
    case 'offline':
      return 0.75;
  }
}

function getMoveInterval(status: DeskStatus): [number, number] {
  switch (status) {
    case 'active':
      return [8000, 15000];
    case 'idle':
      return [3000, 6000];
    case 'error':
      return [15000, 30000];
    case 'offline':
      return [4000, 8000];
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function MovingAvatar(props: MovingAvatarProps): JSX.Element {
  const groupRef = useRef<Group>(null);
  const currentPos = useRef(new Vector3(props.deskPosition[0], 0, props.deskPosition[2] + 2.0));
  const isWalking = useRef(false);
  const frameCount = useRef(0);

  const propsRef = useLatest(props);

  const startX = props.deskPosition[0];
  const startZ = props.deskPosition[2] + 2.0;

  const targetPos = useRef(new Vector3(startX, 0, startZ));
  const scratchCandidate = useRef(new Vector3());

  useEffect(() => {
    function pickNewTarget(): void {
      const pr = propsRef.current;
      const bounds = pr.officeBounds;
      const dx = pr.deskPosition[0];
      const dz = pr.deskPosition[2];

      for (let attempt = 0; attempt < 30; attempt++) {
        let cx: number;
        let cz: number;

        if (pr.status === 'active') {
          cx = dx + rand(-1.5, 1.5);
          cz = dz + 2.0 + rand(-0.8, 0.8);
        } else {
          cx = rand(bounds.minX + 1.5, bounds.maxX - 1.5);
          cz = rand(bounds.minZ + 1.5, bounds.maxZ - 1.5);
        }

        scratchCandidate.current.set(cx, 0, cz);
        if (
          isPositionFree(scratchCandidate.current, pr.obstacles, pr.otherAvatarPositions, pr.id)
        ) {
          targetPos.current.set(cx, 0, cz);
          return;
        }
      }
    }

    pickNewTarget();

    const [minMs, maxMs] = getMoveInterval(props.status);
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const scheduleNext = (): void => {
      if (cancelled) return;
      timerId = setTimeout(
        () => {
          pickNewTarget();
          scheduleNext();
        },
        rand(minMs, maxMs)
      );
    };
    scheduleNext();

    return () => {
      cancelled = true;
      if (timerId != null) clearTimeout(timerId);
    };
  }, [props.status]);

  const scratchDir = useRef(new Vector3());
  const scratchNext = useRef(new Vector3());

  useFrame((_state, rawDelta) => {
    if (!groupRef.current) return;

    const pr = propsRef.current;
    const dt = Math.min(rawDelta, 0.05);
    const speed = getSpeed(pr.status);

    scratchDir.current.subVectors(targetPos.current, currentPos.current);
    scratchDir.current.y = 0;
    const dist = scratchDir.current.length();

    isWalking.current = dist > 0.12;

    if (dist > 0.08) {
      const step = Math.min(speed * dt, dist);
      scratchDir.current.normalize().multiplyScalar(step);
      scratchNext.current.copy(currentPos.current).add(scratchDir.current);
      scratchNext.current.y = 0;

      if (isPositionFree(scratchNext.current, pr.obstacles, pr.otherAvatarPositions, pr.id)) {
        currentPos.current.copy(scratchNext.current);
        groupRef.current.position.copy(currentPos.current);

        if (dist > 0.1) {
          const desired = Math.atan2(scratchDir.current.x, scratchDir.current.z);
          const cur = groupRef.current.rotation.y;
          let diff = desired - cur;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          groupRef.current.rotation.y = cur + diff * Math.min(1, 6.0 * dt);
        }
      } else {
        isWalking.current = false;
        const bounds = pr.officeBounds;
        for (let attempt = 0; attempt < 8; attempt++) {
          const cx = rand(bounds.minX + 1.5, bounds.maxX - 1.5);
          const cz = rand(bounds.minZ + 1.5, bounds.maxZ - 1.5);
          scratchNext.current.set(cx, 0, cz);
          if (isPositionFree(scratchNext.current, pr.obstacles, pr.otherAvatarPositions, pr.id)) {
            targetPos.current.set(cx, 0, cz);
            break;
          }
        }
      }
    } else {
      isWalking.current = false;
    }

    frameCount.current += 1;
    if (frameCount.current >= REPORT_EVERY) {
      frameCount.current = 0;
      pr.onPositionUpdate(pr.id, currentPos.current.clone());
    }
  });

  return (
    <group ref={groupRef} position={[startX, 0, startZ]}>
      <VoxelAvatar
        agentId={props.id}
        label={props.label}
        emoji={props.emoji}
        color={props.color}
        status={props.status}
        position={[0, 0, 0]}
        walkingRef={isWalking}
      />
    </group>
  );
}
