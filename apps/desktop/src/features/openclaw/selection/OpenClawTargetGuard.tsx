import { OpenClawPageState } from '../ui/OpenClawPageState';
import { useRequiredTarget } from './useRequiredTarget';

export interface OpenClawTargetGuardProps {
  readonly connected: boolean;
  readonly selectedTargetId: string | null;
  readonly featureName: string;
  readonly children: (targetId: string) => JSX.Element;
}

export function OpenClawTargetGuard(props: OpenClawTargetGuardProps): JSX.Element {
  const target = useRequiredTarget({
    connected: props.connected,
    selectedTargetId: props.selectedTargetId,
  });

  if (target.state === 'notReady') {
    return <OpenClawPageState kind="notReady" featureName={props.featureName} />;
  }

  if (target.state === 'noTarget' || !target.targetId) {
    return <OpenClawPageState kind="noTarget" featureName={props.featureName} />;
  }

  return props.children(target.targetId);
}
