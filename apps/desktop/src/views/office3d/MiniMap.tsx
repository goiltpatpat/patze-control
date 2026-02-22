import { useEffect, useRef } from 'react';

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface MiniMapDesk {
  readonly x: number;
  readonly z: number;
  readonly status: DeskStatus;
  readonly label: string;
}

interface MiniMapProps {
  readonly desks: readonly MiniMapDesk[];
  readonly playerPosition: { readonly x: number; readonly z: number } | null;
  readonly roomBounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
}

const MAP_SIZE = 140;
const PADDING = 10;

function statusToColor(status: DeskStatus): string {
  switch (status) {
    case 'active':
      return '#2fc977';
    case 'idle':
      return '#f2bf4d';
    case 'error':
      return '#ee5d5d';
    case 'offline':
      return '#5e6772';
  }
}

function worldToMap(wx: number, wz: number, bounds: MiniMapProps['roomBounds']): [number, number] {
  const rangeX = bounds.maxX - bounds.minX;
  const rangeZ = bounds.maxZ - bounds.minZ;
  const mx = PADDING + ((wx - bounds.minX) / rangeX) * (MAP_SIZE - PADDING * 2);
  const my = PADDING + ((wz - bounds.minZ) / rangeZ) * (MAP_SIZE - PADDING * 2);
  return [mx, my];
}

export function MiniMap(props: MiniMapProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const p = propsRef.current;

      ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

      ctx.fillStyle = 'rgba(8, 12, 24, 0.85)';
      ctx.beginPath();
      ctx.roundRect(0, 0, MAP_SIZE, MAP_SIZE, 8);
      ctx.fill();

      ctx.strokeStyle = 'rgba(74, 158, 255, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(1, 1, MAP_SIZE - 2, MAP_SIZE - 2, 7);
      ctx.stroke();

      const [wallTL_x, wallTL_y] = worldToMap(p.roomBounds.minX, p.roomBounds.minZ, p.roomBounds);
      const [wallBR_x, wallBR_y] = worldToMap(p.roomBounds.maxX, p.roomBounds.maxZ, p.roomBounds);
      ctx.strokeStyle = 'rgba(100, 120, 160, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(wallTL_x, wallTL_y, wallBR_x - wallTL_x, wallBR_y - wallTL_y);

      for (const desk of p.desks) {
        const [dx, dy] = worldToMap(desk.x, desk.z, p.roomBounds);
        ctx.fillStyle = statusToColor(desk.status);
        ctx.globalAlpha = 0.8;
        ctx.fillRect(dx - 4, dy - 3, 8, 6);
        ctx.globalAlpha = 1;
      }

      if (p.playerPosition) {
        const [plx, ply] = worldToMap(p.playerPosition.x, p.playerPosition.z, p.roomBounds);
        const time = Date.now() * 0.003;
        const pulseR = 5 + Math.sin(time) * 1.5;

        ctx.fillStyle = 'rgba(74, 158, 255, 0.2)';
        ctx.beginPath();
        ctx.arc(plx, ply, pulseR + 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#4a9eff';
        ctx.beginPath();
        ctx.arc(plx, ply, 3.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(plx, ply, 3.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, []);

  return (
    <div className="office-minimap">
      <canvas
        ref={canvasRef}
        width={MAP_SIZE}
        height={MAP_SIZE}
        style={{ width: MAP_SIZE, height: MAP_SIZE }}
      />
    </div>
  );
}
