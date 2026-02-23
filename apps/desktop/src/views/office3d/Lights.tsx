interface DeskLight {
  readonly x: number;
  readonly z: number;
  readonly color: string;
  readonly intensity: number;
}

interface LightsProps {
  readonly deskLights: readonly DeskLight[];
}

const CEILING_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [-5, -4],
  [5, -4],
  [-5, 4],
  [5, 4],
  [0, 0],
];

export function Lights(props: LightsProps): JSX.Element {
  return (
    <>
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[8, 14, 6]}
        intensity={0.7}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-far={50}
        shadow-camera-left={-15}
        shadow-camera-right={15}
        shadow-camera-top={15}
        shadow-camera-bottom={-15}
      />
      <hemisphereLight args={['#2a3a5a', '#0e1423', 0.3]} />

      {/* Subtle ceiling fill lights - no visible mesh */}
      {CEILING_POSITIONS.map(([cx, cz], idx) => (
        <pointLight
          key={`ceil-${idx}`}
          position={[cx, 4.9, cz]}
          intensity={0.2}
          color="#c0d0ff"
          distance={12}
          decay={2}
        />
      ))}

      {/* Per-desk accent lights */}
      {props.deskLights.map((light, idx) => (
        <pointLight
          key={idx}
          position={[light.x, 3.5, light.z]}
          intensity={light.intensity}
          color={light.color}
          distance={8}
          decay={2}
        />
      ))}
    </>
  );
}
