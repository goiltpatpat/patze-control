export interface FilterTab<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly count?: number;
}

export interface FilterTabsProps<T extends string> {
  readonly tabs: ReadonlyArray<FilterTab<T>>;
  readonly active: T;
  readonly onChange: (tab: T) => void;
}

export function FilterTabs<T extends string>(props: FilterTabsProps<T>): JSX.Element {
  return (
    <div className="filter-tabs" role="tablist">
      {props.tabs.map((tab) => {
        const isActive = props.active === tab.id;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            className={`filter-tab${isActive ? ' filter-tab-active' : ''}`}
            onClick={() => {
              props.onChange(tab.id);
            }}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 ? (
              <span className="filter-tab-count">{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
