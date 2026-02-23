import { Suspense, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import { Vector3 } from 'three';
import { formatRelativeTime } from '../utils/time';
import { navigate } from '../shell/routes';

import { Floor } from './office3d/Floor';
import { Walls } from './office3d/Walls';
import { Lights } from './office3d/Lights';
import { AgentDesk } from './office3d/AgentDesk';
import { MovingAvatar } from './office3d/MovingAvatar';
import { PlantPot } from './office3d/PlantPot';
import { WallClock } from './office3d/WallClock';
import { CoffeeMachine } from './office3d/CoffeeMachine';
import { FileCabinet } from './office3d/FileCabinet';
import { Whiteboard } from './office3d/Whiteboard';
import { AgentPanel } from './office3d/AgentPanel';
import { FirstPersonControls } from './office3d/FirstPersonControls';
import { PlayerAvatar } from './office3d/PlayerAvatar';
import { HologramHUD } from './office3d/HologramHUD';
import { FleetWallScreen } from './office3d/FleetWallScreen';
import { SkyWindow } from './office3d/SkyWindow';
import { AmbientParticles } from './office3d/AmbientParticles';
import { VoxelDinosaur } from './office3d/VoxelDinosaur';
import { MiniMap } from './office3d/MiniMap';

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

export interface OfficeSceneDesk {
  readonly id: string;
  readonly label: string;
  readonly type: 'local' | 'remote';
  readonly status: DeskStatus;
  readonly activeRuns: number;
  readonly lastSeen: string | null;
  readonly emoji: string;
}

export type CameraMode = 'orbit' | 'fps' | 'player';

type InteractionModal = 'memory' | 'roadmap' | 'coffee' | 'dinosaur' | null;

interface OfficeScene3DProps {
  readonly desks: readonly OfficeSceneDesk[];
  readonly onSelectDesk: (deskId: string) => void;
  readonly cameraMode: CameraMode;
}

interface DeskWithPosition extends OfficeSceneDesk {
  readonly x: number;
  readonly z: number;
}

const DESK_SPACING = 4.0;
const OFFICE_BOUNDS = { minX: -10, maxX: 10, minZ: -8, maxZ: 8 };

function getStatusColor(status: DeskStatus): string {
  switch (status) {
    case 'active':
      return '#2fc977';
    case 'idle':
      return '#f2bf4d';
    case 'error':
      return '#ee5d5d';
    case 'offline':
      return '#5e6772';
    default: {
      const impossible: never = status;
      return impossible;
    }
  }
}

function layoutDesks(desks: readonly OfficeSceneDesk[]): readonly DeskWithPosition[] {
  if (desks.length === 0) return [];
  const columns = Math.max(2, Math.ceil(Math.sqrt(desks.length)));
  const rows = Math.max(1, Math.ceil(desks.length / columns));
  const xOffset = ((columns - 1) * DESK_SPACING) / 2;
  const zOffset = ((rows - 1) * DESK_SPACING) / 2;

  return desks.map((desk, index) => {
    const row = Math.floor(index / columns);
    const col = index % columns;
    return {
      ...desk,
      x: col * DESK_SPACING - xOffset,
      z: row * DESK_SPACING - zOffset,
    };
  });
}

function SceneContent(props: {
  readonly deskLayout: readonly DeskWithPosition[];
  readonly selectedAgent: string | null;
  readonly onDeskClick: (id: string) => void;
  readonly onInteraction: (modal: InteractionModal) => void;
  readonly onPlayerPositionUpdate: (x: number, z: number) => void;
  readonly cameraMode: CameraMode;
}): JSX.Element {
  const avatarPositions = useRef<Map<string, Vector3>>(new Map());

  const furnitureObjects = useMemo(
    () => [
      {
        id: 'furniture:memory',
        type: 'furniture' as const,
        position: new Vector3(-9, 0, -5),
        radius: 1.2,
      },
      {
        id: 'furniture:roadmap',
        type: 'furniture' as const,
        position: new Vector3(0, 2.8, -9.75),
        radius: 2.0,
      },
      {
        id: 'furniture:coffee',
        type: 'furniture' as const,
        position: new Vector3(9, 0, -5),
        radius: 1.2,
      },
      {
        id: 'furniture:dinosaur',
        type: 'furniture' as const,
        position: new Vector3(10, 0, 7),
        radius: 1.5,
      },
    ],
    []
  );

  const nearbyObjects = useMemo(
    () => [
      ...props.deskLayout.map((desk) => ({
        id: `desk:${desk.id}`,
        type: 'desk' as const,
        position: new Vector3(desk.x, 0, desk.z),
        radius: 1.5,
      })),
      ...furnitureObjects,
    ],
    [props.deskLayout, furnitureObjects]
  );

  const handlePlayerInteract = useCallback(
    (objectId: string, objectType: 'desk' | 'furniture') => {
      if (objectType === 'desk') {
        const deskId = objectId.replace('desk:', '');
        props.onDeskClick(deskId);
      } else {
        const furnitureId = objectId.replace('furniture:', '');
        if (
          furnitureId === 'memory' ||
          furnitureId === 'roadmap' ||
          furnitureId === 'coffee' ||
          furnitureId === 'dinosaur'
        ) {
          props.onInteraction(furnitureId);
        }
      }
    },
    [props.onDeskClick, props.onInteraction]
  );

  const handleAvatarPositionUpdate = useCallback((id: string, pos: Vector3) => {
    avatarPositions.current.set(id, pos);
  }, []);

  const handleMemoryClick = useCallback(() => props.onInteraction('memory'), [props.onInteraction]);
  const handleRoadmapClick = useCallback(
    () => props.onInteraction('roadmap'),
    [props.onInteraction]
  );
  const handleCoffeeClick = useCallback(() => props.onInteraction('coffee'), [props.onInteraction]);
  const handleDinoClick = useCallback(() => props.onInteraction('dinosaur'), [props.onInteraction]);

  const fleetDesks = useMemo(
    () => props.deskLayout.map((d) => ({ status: d.status, label: d.label })),
    [props.deskLayout]
  );

  const deskLights = useMemo(
    () =>
      props.deskLayout.map((desk) => ({
        x: desk.x,
        z: desk.z,
        color: getStatusColor(desk.status),
        intensity: desk.status === 'active' ? 0.6 : 0.35,
      })),
    [props.deskLayout]
  );

  const obstacles = useMemo(
    () => [
      ...props.deskLayout.map((desk) => ({
        position: new Vector3(desk.x, 0, desk.z),
        radius: 1.5,
      })),
      { position: new Vector3(-9, 0, -5), radius: 0.8 },
      { position: new Vector3(0, 0, -8.5), radius: 1.5 },
      { position: new Vector3(9, 0, -5), radius: 0.6 },
      { position: new Vector3(-10.5, 0, -8.5), radius: 0.5 },
      { position: new Vector3(10.5, 0, -8.5), radius: 0.5 },
      { position: new Vector3(-10.5, 0, 7), radius: 0.5 },
      { position: new Vector3(10.5, 0, 0), radius: 0.5 },
      { position: new Vector3(10, 0, 7), radius: 0.7 },
    ],
    [props.deskLayout]
  );

  return (
    <>
      <Lights deskLights={deskLights} />
      <Environment preset="lobby" />

      <Floor />
      <Walls />

      {/* Desks */}
      {props.deskLayout.map((desk) => (
        <AgentDesk
          key={desk.id}
          id={desk.id}
          label={desk.label}
          emoji={desk.emoji}
          status={desk.status}
          activeRuns={desk.activeRuns}
          position={[desk.x, 0, desk.z]}
          statusColor={getStatusColor(desk.status)}
          isSelected={props.selectedAgent === desk.id}
          onClick={() => {
            props.onDeskClick(desk.id);
          }}
        />
      ))}

      {/* Moving Avatars */}
      {props.deskLayout.map((desk) => (
        <MovingAvatar
          key={`avatar-${desk.id}`}
          id={desk.id}
          label={desk.label}
          emoji={desk.emoji}
          color={getStatusColor(desk.status)}
          status={desk.status}
          deskPosition={[desk.x, 0, desk.z]}
          officeBounds={OFFICE_BOUNDS}
          obstacles={obstacles}
          otherAvatarPositions={avatarPositions.current}
          onPositionUpdate={handleAvatarPositionUpdate}
        />
      ))}

      {/* Interactive Props */}
      <FileCabinet position={[-9, 0, -5]} onClick={handleMemoryClick} />
      <Whiteboard position={[0, 2.8, -9.75]} rotation={[0, 0, 0]} onClick={handleRoadmapClick} />
      <CoffeeMachine position={[9, 0, -5]} onClick={handleCoffeeClick} />

      {/* Holographic HUDs above desks */}
      {props.deskLayout.map((desk) => (
        <HologramHUD
          key={`hud-${desk.id}`}
          position={[desk.x, 0, desk.z]}
          status={desk.status}
          statusColor={getStatusColor(desk.status)}
          activeRuns={desk.activeRuns}
          label={desk.label}
        />
      ))}

      {/* Fleet Wall Screen */}
      <FleetWallScreen position={[-5, 2.8, -9.75]} desks={fleetDesks} />

      {/* Sky Window */}
      <SkyWindow position={[5, 3.0, -9.8]} />

      {/* Ambient Particles */}
      <AmbientParticles count={80} area={[20, 5, 16]} />

      {/* Decorative Props */}
      <PlantPot position={[-10.5, 0, -8.5]} size="large" />
      <PlantPot position={[10.5, 0, -8.5]} size="medium" />
      <PlantPot position={[-10.5, 0, 7]} size="small" />
      <PlantPot position={[10.5, 0, 0]} size="small" />

      {/* Dinosaur mascot — interactive */}
      <VoxelDinosaur
        position={[10, 0, 7]}
        rotation={[0, -Math.PI * 0.7, 0]}
        onClick={handleDinoClick}
      />

      <WallClock position={[8.5, 3.5, -9.75]} />

      {/* Player Avatar (third-person mode) */}
      {props.cameraMode === 'player' ? (
        <PlayerAvatar
          obstacles={obstacles}
          nearbyObjects={nearbyObjects}
          onInteract={handlePlayerInteract}
          onPositionUpdate={props.onPlayerPositionUpdate}
          officeBounds={OFFICE_BOUNDS}
        />
      ) : null}

      {/* Camera Controls */}
      {props.cameraMode === 'orbit' ? (
        <OrbitControls
          enableDamping
          dampingFactor={0.1}
          maxPolarAngle={Math.PI / 2.08}
          minPolarAngle={Math.PI / 4}
          minDistance={5}
          maxDistance={30}
          target={[0, 0.7, 0]}
        />
      ) : props.cameraMode === 'fps' ? (
        <FirstPersonControls moveSpeed={4} />
      ) : null}
    </>
  );
}

const DINO_QUOTES = [
  "RAWR! That means 'your agents are doing great' in dinosaur.",
  "I've been guarding this office for 65 million milliseconds.",
  'Even a T-Rex knows: small arms, big deployments.',
  'Fun fact: I can monitor your fleet while juggling asteroids.',
  'They said AI would replace me. I said I AM the mascot.',
  'Patze-Dinosaw tip: always commit before extinction events.',
  "My obstacle avoidance is better than your agents'. Just saying.",
  'I was containerized before Docker was cool. Literally — in amber.',
];

const DINO_REACTIONS = [
  { quote: '...wait, you actually clicked that?', btn: 'Okay try again' },
  { quote: 'RAWR! Stop poking me!', btn: 'Poke again' },
  { quote: '*wiggles tiny arms aggressively*', btn: "I'm sorry" },
  { quote: "You're not sorry. I can tell.", btn: 'Feed a cookie 🍪' },
  { quote: '*nom nom* ...okay we cool now.', btn: 'Pat on head' },
  { quote: '*purrs like a 3-ton kitten*', btn: 'One more pat' },
  { quote: "That's enough. I have a reputation to maintain.", btn: 'Hug 🫂' },
  { quote: '...fine. ONE hug. Tell no one.', btn: '🤫' },
  { quote: '*hugs back with tiny arms*\nBest. Human. Ever.', btn: 'Again!' },
  { quote: 'Security! We have a hugger!', btn: 'Run away 🏃' },
];

function InteractionModalOverlay(props: {
  readonly modal: InteractionModal;
  readonly onClose: () => void;
}): JSX.Element | null {
  const [dinoClicks, setDinoClicks] = useState(0);
  const [shaking, setShaking] = useState(false);
  const shakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (props.modal === 'dinosaur') {
      setDinoClicks(0);
    }
  }, [props.modal]);

  useEffect(() => {
    return () => {
      if (shakeTimer.current != null) clearTimeout(shakeTimer.current);
    };
  }, []);

  useEffect(() => {
    if (props.modal == null) return;
    const handleEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('keydown', handleEsc);
    };
  }, [props.modal, props.onClose]);

  if (props.modal == null) return null;

  const titles: Record<NonNullable<InteractionModal>, string> = {
    memory: 'Memory Browser',
    roadmap: 'Roadmap',
    coffee: 'Coffee Break',
    dinosaur: 'Patze-Dinosaw',
  };

  const baseQuote = DINO_QUOTES[Math.floor(Date.now() / 60000) % DINO_QUOTES.length]!;

  const descriptions: Record<NonNullable<InteractionModal>, string> = {
    memory: 'Browse and search agent memory files, workspace documents, and configuration.',
    roadmap: 'View the project roadmap, milestones, and upcoming features.',
    coffee: 'Take a break. Your agents are working hard for you.',
    dinosaur:
      dinoClicks === 0
        ? baseQuote
        : DINO_REACTIONS[Math.min(dinoClicks - 1, DINO_REACTIONS.length - 1)]!.quote,
  };

  const actions: Record<NonNullable<InteractionModal>, { label: string; route: string } | null> = {
    memory: { label: 'Open Memory View', route: 'memory' },
    roadmap: { label: 'Open Workspace', route: 'workspace' },
    coffee: null,
    dinosaur: null,
  };

  const action = actions[props.modal];

  const icons: Record<NonNullable<InteractionModal>, string> = {
    memory: '🧠',
    roadmap: '🗺️',
    coffee: '☕',
    dinosaur: '🦖',
  };

  const isDino = props.modal === 'dinosaur';

  const dinoReaction =
    dinoClicks === 0 ? null : DINO_REACTIONS[Math.min(dinoClicks - 1, DINO_REACTIONS.length - 1)]!;

  const dinoBtnLabel = dinoClicks === 0 ? 'Pet the dinosaur 🦖' : (dinoReaction?.btn ?? 'Again!');

  const handleDinoClick = () => {
    setDinoClicks((c) => c + 1);
    setShaking(true);
    if (shakeTimer.current != null) clearTimeout(shakeTimer.current);
    shakeTimer.current = setTimeout(() => {
      setShaking(false);
      shakeTimer.current = null;
    }, 400);
  };

  const dinoModalStyle: React.CSSProperties = {
    borderColor: '#44bb77',
    boxShadow: `0 0 ${12 + dinoClicks * 4}px rgba(68,187,119,${0.25 + dinoClicks * 0.05})`,
    transition: 'box-shadow 0.3s ease, transform 0.1s ease',
    ...(shaking ? { animation: 'dino-shake 0.4s ease' } : {}),
  };

  return (
    <div
      className="office-interaction-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={titles[props.modal]}
      onClick={props.onClose}
    >
      <div
        className="office-interaction-modal"
        style={isDino ? dinoModalStyle : undefined}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="office-interaction-modal-header">
          <h3>
            {icons[props.modal]} {titles[props.modal]}
            {isDino && dinoClicks > 5 ? ' 💚' : ''}
          </h3>
          <button
            type="button"
            className="office-agent-panel-close"
            aria-label="Close"
            onClick={props.onClose}
          >
            &times;
          </button>
        </div>
        <p
          className="office-interaction-modal-desc"
          style={
            isDino
              ? {
                  fontStyle: 'italic',
                  color: '#88ddaa',
                  fontSize: '0.95rem',
                  whiteSpace: 'pre-line',
                  transition: 'all 0.3s ease',
                }
              : undefined
          }
        >
          {descriptions[props.modal]}
        </p>
        {isDino ? (
          <p
            className="office-interaction-modal-desc"
            style={{ marginTop: '0.5rem', opacity: 0.6, fontSize: '0.75rem' }}
          >
            {dinoClicks === 0
              ? 'Office mascot since deployment #1'
              : `Interaction count: ${dinoClicks} — ${dinoClicks >= 8 ? 'best friends now' : dinoClicks >= 5 ? 'getting attached...' : dinoClicks >= 3 ? 'warming up to you' : 'suspicious of you'}`}
          </p>
        ) : null}
        {isDino ? (
          <button
            type="button"
            className="office-agent-panel-action-btn office-agent-panel-action-primary"
            style={{
              background: `hsl(${150 + dinoClicks * 5}, 60%, ${40 + dinoClicks * 2}%)`,
              transition: 'background 0.3s ease',
            }}
            onClick={handleDinoClick}
          >
            {dinoBtnLabel}
          </button>
        ) : null}
        {action != null ? (
          <button
            type="button"
            className="office-agent-panel-action-btn office-agent-panel-action-primary"
            onClick={() => {
              navigate(action.route as Parameters<typeof navigate>[0]);
              props.onClose();
            }}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function OfficeScene3D(props: OfficeScene3DProps): JSX.Element {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [interactionModal, setInteractionModal] = useState<InteractionModal>(null);
  const playerPosRef = useRef<{ x: number; z: number } | null>(null);
  const deskLayout = useMemo(() => layoutDesks(props.desks), [props.desks]);

  useEffect(() => {
    if (props.cameraMode !== 'player') playerPosRef.current = null;
  }, [props.cameraMode]);

  const selectedDesk = useMemo(() => {
    if (selectedAgent == null) return null;
    return props.desks.find((d) => d.id === selectedAgent) ?? null;
  }, [selectedAgent, props.desks]);

  const handleDeskClick = useCallback((id: string) => {
    setSelectedAgent((prev) => (prev === id ? null : id));
  }, []);

  const handleClosePanel = useCallback(() => {
    setSelectedAgent(null);
  }, []);

  const handleInteraction = useCallback((modal: InteractionModal) => {
    setInteractionModal(modal);
  }, []);

  const handleCloseModal = useCallback(() => {
    setInteractionModal(null);
  }, []);

  const handlePlayerPositionUpdate = useCallback((x: number, z: number) => {
    playerPosRef.current = { x, z };
  }, []);

  const miniMapDesks = useMemo(
    () => deskLayout.map((d) => ({ x: d.x, z: d.z, status: d.status, label: d.label })),
    [deskLayout]
  );

  const sceneSpan = Math.max(
    deskLayout.length > 0 ? Math.max(...deskLayout.map((d) => Math.abs(d.x))) * 2 + 8 : 16,
    deskLayout.length > 0 ? Math.max(...deskLayout.map((d) => Math.abs(d.z))) * 2 + 8 : 16
  );
  const cameraY = Math.max(7, sceneSpan * 0.6);
  const cameraZ = Math.max(10, sceneSpan * 0.8);

  return (
    <div className="office-3d-wrap office-3d-wrap-full">
      <div
        className={`office-3d-canvas office-3d-canvas-full${selectedDesk != null ? ' office-3d-canvas-with-panel' : ''}`}
      >
        <Canvas
          camera={{ position: [0, cameraY, cameraZ], fov: 50 }}
          shadows
          dpr={[1, 1.5]}
          aria-label="3D Office — interactive agent workspace"
        >
          <color attach="background" args={['#0b1320']} />
          <fog attach="fog" args={['#0b1320', 20, 45]} />
          <Suspense fallback={null}>
            <SceneContent
              deskLayout={deskLayout}
              selectedAgent={selectedAgent}
              onDeskClick={handleDeskClick}
              onInteraction={handleInteraction}
              onPlayerPositionUpdate={handlePlayerPositionUpdate}
              cameraMode={props.cameraMode}
            />
          </Suspense>
        </Canvas>

        {/* Controls legend overlay */}
        <div className="office-controls-legend">
          {props.cameraMode === 'orbit' ? (
            <>
              <span>Drag to rotate</span>
              <span>Scroll to zoom</span>
              <span>Click desk for info</span>
            </>
          ) : props.cameraMode === 'player' ? (
            <>
              <span>WASD to walk</span>
              <span>Shift to sprint</span>
              <span>E to interact</span>
            </>
          ) : (
            <>
              <span>WASD to move</span>
              <span>Mouse to look</span>
              <span>Space/Shift for up/down</span>
            </>
          )}
        </div>

        {/* Mini-map overlay */}
        <MiniMap desks={miniMapDesks} playerPositionRef={playerPosRef} roomBounds={OFFICE_BOUNDS} />
      </div>

      {/* Agent Panel Sidebar */}
      {selectedDesk != null ? (
        <AgentPanel
          id={selectedDesk.id}
          label={selectedDesk.label}
          emoji={selectedDesk.emoji}
          type={selectedDesk.type}
          status={selectedDesk.status}
          activeRuns={selectedDesk.activeRuns}
          lastSeen={selectedDesk.lastSeen}
          statusColor={getStatusColor(selectedDesk.status)}
          onClose={handleClosePanel}
        />
      ) : null}

      {/* Interaction Modal */}
      <InteractionModalOverlay modal={interactionModal} onClose={handleCloseModal} />

      {/* Desk list below canvas */}
      <div className="office-3d-list">
        {props.desks.map((desk) => (
          <button
            key={desk.id}
            type="button"
            className={`office-desk office-status-${desk.status}${selectedAgent === desk.id ? ' office-desk-selected' : ''}`}
            onClick={() => {
              handleDeskClick(desk.id);
            }}
            title={`${desk.label} (${desk.type})`}
          >
            <div className="office-desk-avatar">{desk.emoji}</div>
            <div className="office-desk-title">
              <span>{desk.label}</span>
            </div>
            <div className="office-desk-meta">
              <span>{desk.type}</span>
              <span>
                {desk.activeRuns > 0 ? `${desk.activeRuns.toString()} active` : desk.status}
              </span>
            </div>
            <div className="office-desk-seen">
              {desk.lastSeen ? formatRelativeTime(desk.lastSeen) : 'never synced'}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
