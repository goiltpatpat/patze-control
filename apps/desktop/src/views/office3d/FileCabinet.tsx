import { useState, useEffect } from 'react';
import { Box, Text } from '@react-three/drei';

interface FileCabinetProps {
  readonly position: [number, number, number];
  readonly onClick: () => void;
}

export function FileCabinet(props: FileCabinetProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [px, py, pz] = props.position;

  useEffect(() => {
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, []);

  const drawerColor = '#2a2a35';
  const handleColor = '#888898';

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
      {/* Cabinet body */}
      <Box args={[0.5, 1.0, 0.4]} position={[0, 0.5, 0]}>
        <meshStandardMaterial color="#222230" roughness={0.5} metalness={0.4} />
      </Box>

      {/* 3 Drawers */}
      {[0.22, 0.52, 0.82].map((dy, i) => (
        <group key={i}>
          <Box args={[0.44, 0.24, 0.02]} position={[0, dy, 0.2]}>
            <meshStandardMaterial color={drawerColor} roughness={0.4} metalness={0.3} />
          </Box>
          {/* Handle */}
          <Box args={[0.12, 0.02, 0.02]} position={[0, dy, 0.22]}>
            <meshStandardMaterial color={handleColor} metalness={0.7} roughness={0.2} />
          </Box>
        </group>
      ))}

      {/* Hover label */}
      {hovered ? (
        <Text
          position={[0, 1.15, 0]}
          fontSize={0.08}
          color="#e8f0ff"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.005}
          outlineColor="#05070e"
        >
          MEMORY
        </Text>
      ) : null}
    </group>
  );
}
