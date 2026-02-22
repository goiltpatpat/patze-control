import { useRef, useEffect } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import { PointerLockControls } from '@react-three/drei';
import { Vector3 } from 'three';

interface FirstPersonControlsProps {
  readonly moveSpeed?: number;
}

const BOUNDS = { minX: -11, maxX: 11, minZ: -9, maxZ: 9, minY: 1.2, maxY: 6 };

export function FirstPersonControls(props: FirstPersonControlsProps): JSX.Element {
  const speed = props.moveSpeed ?? 4;
  const { camera } = useThree();
  const keys = useRef<Set<string>>(new Set());
  const velocity = useRef(new Vector3());
  const scratchDir = useRef(new Vector3());
  const scratchForward = useRef(new Vector3());
  const scratchRight = useRef(new Vector3());
  const scratchUp = useRef(new Vector3(0, 1, 0));

  useEffect(() => {
    camera.position.set(0, 2.5, 8);

    const onKeyDown = (e: KeyboardEvent) => { keys.current.add(e.code); };
    const onKeyUp = (e: KeyboardEvent) => { keys.current.delete(e.code); };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [camera]);

  useFrame((_, delta) => {
    const pressed = keys.current;
    const dir = scratchDir.current.set(0, 0, 0);

    if (pressed.has('KeyW') || pressed.has('ArrowUp')) dir.z -= 1;
    if (pressed.has('KeyS') || pressed.has('ArrowDown')) dir.z += 1;
    if (pressed.has('KeyA') || pressed.has('ArrowLeft')) dir.x -= 1;
    if (pressed.has('KeyD') || pressed.has('ArrowRight')) dir.x += 1;

    let verticalDelta = 0;
    if (pressed.has('Space')) verticalDelta = 1;
    if (pressed.has('ShiftLeft') || pressed.has('ShiftRight')) verticalDelta = -1;

    if (dir.length() > 0) {
      dir.normalize();
      const forward = scratchForward.current;
      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const right = scratchRight.current.crossVectors(forward, scratchUp.current).normalize();

      velocity.current.x = (forward.x * -dir.z + right.x * dir.x) * speed;
      velocity.current.z = (forward.z * -dir.z + right.z * dir.x) * speed;
    } else {
      velocity.current.x *= 0.85;
      velocity.current.z *= 0.85;
    }

    velocity.current.y = verticalDelta * speed * 0.6;

    camera.position.x += velocity.current.x * delta;
    camera.position.y += velocity.current.y * delta;
    camera.position.z += velocity.current.z * delta;

    camera.position.x = Math.max(BOUNDS.minX, Math.min(BOUNDS.maxX, camera.position.x));
    camera.position.y = Math.max(BOUNDS.minY, Math.min(BOUNDS.maxY, camera.position.y));
    camera.position.z = Math.max(BOUNDS.minZ, Math.min(BOUNDS.maxZ, camera.position.z));
  });

  return <PointerLockControls />;
}
