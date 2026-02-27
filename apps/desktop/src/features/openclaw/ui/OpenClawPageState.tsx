import { IconCpu } from '../../../components/Icons';
import { getOpenClawStateMessage, type OpenClawPageStateKind } from './messages';

export interface OpenClawPageStateProps {
  readonly kind: OpenClawPageStateKind;
  readonly featureName: string;
  readonly errorMessage?: string | null | undefined;
  readonly className?: string | undefined;
  readonly onRetry?: (() => void) | undefined;
}

export function OpenClawPageState(props: OpenClawPageStateProps): JSX.Element {
  if (props.kind === 'error') {
    const message = getOpenClawStateMessage('error', { featureName: props.featureName });
    return (
      <div
        className={`error-banner-smart${props.className ? ` ${props.className}` : ''}`}
        role="alert"
      >
        <span className="error-banner-smart-icon">!</span>
        <span className="error-banner-smart-msg">
          {props.errorMessage ? `${message.title} ${props.errorMessage}` : message.title}
        </span>
        {props.onRetry ? (
          <button type="button" className="error-banner-smart-retry" onClick={props.onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  if (props.kind === 'loading') {
    return (
      <div className={`empty-state-smart${props.className ? ` ${props.className}` : ''}`}>
        <div className="empty-state-smart-icon">
          <div className="mini-spinner" />
        </div>
        <h4>Loading {props.featureName}...</h4>
        <p>Fetching latest target-scoped data.</p>
      </div>
    );
  }

  const message = getOpenClawStateMessage(props.kind, { featureName: props.featureName });
  return (
    <div className={`empty-state-smart${props.className ? ` ${props.className}` : ''}`}>
      <div className="empty-state-smart-icon">
        <IconCpu width={24} height={24} />
      </div>
      <h4>{message.title}</h4>
      <p>{message.description}</p>
    </div>
  );
}
