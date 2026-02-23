import { useState, useEffect } from 'react';
import { Box, Text } from '@react-three/drei';

interface WhiteboardProps {
  readonly position: [number, number, number];
  readonly rotation?: [number, number, number];
  readonly onClick: () => void;
}

export function Whiteboard(props: WhiteboardProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [px, py, pz] = props.position;
  const [rx, ry, rz] = props.rotation ?? [0, 0, 0];

  useEffect(() => {
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, []);

  const markerColors = ['#ee4444', '#44aa44', '#4488ee', '#eeaa22'] as const;

  return (
    <group
      position={[px, py, pz]}
      rotation={[rx, ry, rz]}
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
      {/* Board surface */}
      <Box args={[2.0, 1.2, 0.04]} position={[0, 0, 0]}>
        <meshStandardMaterial color="#f0f0f0" roughness={0.3} metalness={0.05} />
      </Box>

      {/* Frame */}
      <Box args={[2.08, 0.04, 0.06]} position={[0, 0.6, 0]}>
        <meshStandardMaterial color="#555568" metalness={0.5} roughness={0.3} />
      </Box>
      <Box args={[2.08, 0.04, 0.06]} position={[0, -0.6, 0]}>
        <meshStandardMaterial color="#555568" metalness={0.5} roughness={0.3} />
      </Box>
      <Box args={[0.04, 1.2, 0.06]} position={[-1.02, 0, 0]}>
        <meshStandardMaterial color="#555568" metalness={0.5} roughness={0.3} />
      </Box>
      <Box args={[0.04, 1.2, 0.06]} position={[1.02, 0, 0]}>
        <meshStandardMaterial color="#555568" metalness={0.5} roughness={0.3} />
      </Box>

      {/* Marker tray */}
      <Box args={[0.8, 0.03, 0.08]} position={[0, -0.65, 0.04]}>
        <meshStandardMaterial color="#555568" metalness={0.5} roughness={0.3} />
      </Box>

      {/* Markers */}
      {markerColors.map((color, i) => (
        <group key={i}>
          <Box args={[0.12, 0.02, 0.02]} position={[-0.25 + i * 0.16, -0.63, 0.06]}>
            <meshStandardMaterial color={color} roughness={0.5} />
          </Box>
          {/* Marker cap */}
          <Box args={[0.025, 0.022, 0.022]} position={[-0.19 + i * 0.16, -0.63, 0.06]}>
            <meshStandardMaterial color="#222230" roughness={0.4} />
          </Box>
        </group>
      ))}

      {/* Board text */}
      <Text
        position={[0, 0.35, 0.025]}
        fontSize={0.1}
        color="#555568"
        anchorX="center"
        anchorY="middle"
      >
        ROADMAP
      </Text>

      {/* Fake bullet points */}
      {[-0.5, -0.2, 0.1].map((yOff, i) => (
        <Box key={`line-${i}`} args={[0.8 - i * 0.15, 0.015, 0.003]} position={[0, yOff, 0.025]}>
          <meshStandardMaterial color={`hsl(${210 + i * 30}, 40%, 65%)`} />
        </Box>
      ))}

      {/* Hover label */}
      {hovered ? (
        <Text
          position={[0, 0.8, 0.05]}
          fontSize={0.08}
          color="#e8f0ff"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.005}
          outlineColor="#05070e"
        >
          CLICK TO VIEW
        </Text>
      ) : null}
    </group>
  );
}
