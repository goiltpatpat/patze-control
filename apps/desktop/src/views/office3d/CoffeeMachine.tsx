import { useRef, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box, Cylinder, Text } from '@react-three/drei';
import type { Group } from 'three';

interface CoffeeMachineProps {
  readonly position: [number, number, number];
  readonly onClick: () => void;
}

export function CoffeeMachine(props: CoffeeMachineProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const steamRef = useRef<Group>(null);
  const [px, py, pz] = props.position;

  useEffect(() => {
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, []);

  useFrame((state) => {
    if (steamRef.current) {
      steamRef.current.position.y = 1.15 + Math.sin(state.clock.elapsedTime * 2) * 0.03;
      steamRef.current.scale.setScalar(0.8 + Math.sin(state.clock.elapsedTime * 3) * 0.2);
    }
  });

  return (
    <group
      position={[px, py, pz]}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      onPointerOver={() => {
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = 'auto';
      }}
    >
      {/* Body */}
      <Box args={[0.35, 0.6, 0.25]} position={[0, 0.3, 0]}>
        <meshStandardMaterial color="#2a2a32" roughness={0.4} metalness={0.5} />
      </Box>

      {/* Water tank (back) */}
      <Box args={[0.28, 0.5, 0.08]} position={[0, 0.28, -0.14]}>
        <meshStandardMaterial color="#3a4a6a" transparent opacity={0.6} roughness={0.1} />
      </Box>

      {/* Spout */}
      <Box args={[0.06, 0.08, 0.06]} position={[0, 0.52, 0.06]}>
        <meshStandardMaterial color="#1a1a22" metalness={0.7} roughness={0.2} />
      </Box>

      {/* Drip tray */}
      <Box args={[0.3, 0.02, 0.2]} position={[0, 0.02, 0.04]}>
        <meshStandardMaterial color="#333340" metalness={0.5} roughness={0.3} />
      </Box>

      {/* Coffee cup */}
      <Cylinder args={[0.04, 0.035, 0.08, 8]} position={[0, 0.07, 0.04]}>
        <meshStandardMaterial color="#f0f0f0" roughness={0.4} />
      </Cylinder>

      {/* Coffee liquid */}
      <Cylinder args={[0.035, 0.035, 0.01, 8]} position={[0, 0.105, 0.04]}>
        <meshStandardMaterial color="#3a2010" roughness={0.8} />
      </Cylinder>

      {/* Steam */}
      <group ref={steamRef}>
        <mesh position={[0, 1.15, 0.04]}>
          <sphereGeometry args={[0.015, 6, 6]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.25} />
        </mesh>
        <mesh position={[0.02, 1.2, 0.04]}>
          <sphereGeometry args={[0.01, 6, 6]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.15} />
        </mesh>
      </group>

      {/* Power button */}
      <mesh position={[0.12, 0.5, 0.126]}>
        <sphereGeometry args={[0.015, 8, 8]} />
        <meshStandardMaterial color="#44cc44" emissive="#44cc44" emissiveIntensity={0.6} />
      </mesh>

      {/* Hover label */}
      {hovered ? (
        <Text
          position={[0, 0.75, 0]}
          fontSize={0.08}
          color="#e8f0ff"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.005}
          outlineColor="#05070e"
        >
          COFFEE
        </Text>
      ) : null}
    </group>
  );
}
