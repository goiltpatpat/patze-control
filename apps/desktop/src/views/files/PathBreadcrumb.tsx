export interface PathBreadcrumbProps {
  readonly path: string;
  readonly onNavigate: (path: string) => void;
}

export function PathBreadcrumb(props: PathBreadcrumbProps): JSX.Element {
  const { path: currentPath, onNavigate } = props;
  const segments = currentPath.split('/').filter(Boolean);

  return (
    <nav className="fm-breadcrumb" aria-label="Path">
      <button className="fm-breadcrumb-seg fm-breadcrumb-root" onClick={() => onNavigate('/')}>
        /
      </button>
      {segments.map((seg, i) => {
        const fullPath = '/' + segments.slice(0, i + 1).join('/');
        const isLast = i === segments.length - 1;
        return (
          <span key={fullPath} className="fm-breadcrumb-part">
            <span className="fm-breadcrumb-sep">/</span>
            {isLast ? (
              <span className="fm-breadcrumb-seg fm-breadcrumb-current">{seg}</span>
            ) : (
              <button className="fm-breadcrumb-seg" onClick={() => onNavigate(fullPath)}>
                {seg}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
