import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Icon, type IconName } from './icons';

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'normal' | 'flat' | 'suggested' | 'destructive';

export interface ButtonProps {
  children?: ReactNode;
  icon?: IconName;
  variant?: ButtonVariant;
  pill?: boolean;
  circular?: boolean;
  size?: 'small' | 'normal' | 'large';
  disabled?: boolean;
  active?: boolean;
  title?: string;
  className?: string;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export function Button({
  children,
  icon,
  variant = 'normal',
  pill,
  circular,
  size = 'normal',
  disabled,
  active,
  title,
  className,
  onClick,
}: ButtonProps): React.ReactElement {
  const classes = [
    'btn',
    variant !== 'normal' ? `btn--${variant}` : '',
    pill ? 'btn--pill' : '',
    circular ? 'btn--circular' : '',
    size !== 'normal' ? `btn--${size}` : '',
    active ? 'is-active' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classes} disabled={disabled} title={title} aria-label={title} onClick={onClick}>
      {icon ? <Icon name={icon} size={size === 'small' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Boxed lists                                                                 */
/* -------------------------------------------------------------------------- */

export function Group({
  title,
  description,
  children,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}): React.ReactElement {
  return (
    <section className="group">
      {(title || actions) && (
        <header className="hbox hbox--sm" style={{ marginBottom: description ? 0 : 10 }}>
          {title ? <h2 className="group__title">{title}</h2> : null}
          <div className="spacer" />
          {actions}
        </header>
      )}
      {description ? <p className="group__description">{description}</p> : null}
      <div className="boxed-list">{children}</div>
    </section>
  );
}

export interface RowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: IconName;
  prefix?: ReactNode;
  suffix?: ReactNode;
  activatable?: boolean;
  selected?: boolean;
  onClick?: (event: React.MouseEvent) => void;
  onDoubleClick?: (event: React.MouseEvent) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  className?: string;
  style?: React.CSSProperties;
}

export function Row({
  title,
  subtitle,
  icon,
  prefix,
  suffix,
  activatable,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  className,
  style,
}: RowProps): React.ReactElement {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={['row', activatable || onClick ? 'row--activatable' : '', selected ? 'is-selected' : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      style={style}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      {...(Tag === 'button' ? { type: 'button' as const } : {})}
    >
      {prefix}
      {icon ? (
        <span className="row__icon">
          <Icon name={icon} />
        </span>
      ) : null}
      <span className="row__text">
        <span className="row__title">{title}</span>
        {subtitle ? <span className="row__subtitle">{subtitle}</span> : null}
      </span>
      {suffix ? <span className="row__suffix">{suffix}</span> : null}
    </Tag>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? 'is-on' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
    />
  );
}

export function SwitchRow({
  title,
  subtitle,
  icon,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <Row
      title={title}
      subtitle={subtitle}
      icon={icon}
      activatable={!disabled}
      onClick={disabled ? undefined : () => onChange(!checked)}
      suffix={<Switch checked={checked} onChange={onChange} label={title} />}
      style={disabled ? { opacity: 0.5 } : undefined}
    />
  );
}

export function SpinRow({
  title,
  subtitle,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  title: string;
  subtitle?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}): React.ReactElement {
  const clamp = (next: number): number => Math.min(max, Math.max(min, next));
  return (
    <Row
      title={title}
      subtitle={subtitle}
      suffix={
        <div className="spin">
          <button type="button" onClick={() => onChange(clamp(value - step))} aria-label={`Decrease ${title}`}>
            −
          </button>
          <input
            type="text"
            inputMode="numeric"
            value={suffix ? `${value}${suffix}` : value}
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value.replace(/[^0-9-]/g, ''), 10);
              if (Number.isFinite(parsed)) onChange(clamp(parsed));
            }}
          />
          <button type="button" onClick={() => onChange(clamp(value + step))} aria-label={`Increase ${title}`}>
            +
          </button>
        </div>
      }
    />
  );
}

export function ComboRow<T extends string>({
  title,
  subtitle,
  value,
  options,
  onChange,
}: {
  title: string;
  subtitle?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}): React.ReactElement {
  return (
    <Row
      title={title}
      subtitle={subtitle}
      suffix={
        <select
          className="entry"
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          style={{ minHeight: 32 }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      }
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Small pieces                                                                */
/* -------------------------------------------------------------------------- */

export type CheckState = 'checked' | 'unchecked' | 'partial';

export function Check({
  state,
  onChange,
  label,
}: {
  state: CheckState;
  onChange: () => void;
  label?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`check ${state === 'checked' ? 'is-checked' : ''} ${state === 'partial' ? 'is-partial' : ''}`}
      aria-checked={state === 'partial' ? 'mixed' : state === 'checked'}
      role="checkbox"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
    >
      {state === 'checked' ? <Icon name="check" size={12} /> : null}
      {state === 'partial' ? <Icon name="dash" size={12} /> : null}
    </button>
  );
}

export function ProgressBar({
  value,
  total,
  variant,
  indeterminate,
}: {
  value: number;
  total: number;
  variant?: 'success' | 'error' | 'paused';
  indeterminate?: boolean;
}): React.ReactElement {
  const percent = total > 0 ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div
      className={[
        'progress',
        variant ? `progress--${variant}` : '',
        indeterminate ? 'progress--indeterminate' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      role="progressbar"
      aria-valuenow={Math.round(percent)}
    >
      <div className="progress__bar" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function Badge({
  children,
  tone,
  icon,
}: {
  children: ReactNode;
  tone?: 'accent' | 'success' | 'warning' | 'error';
  icon?: IconName;
}): React.ReactElement {
  return (
    <span className={`badge ${tone ? `badge--${tone}` : ''}`}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export function Spinner({ large }: { large?: boolean }): React.ReactElement {
  return <span className={`spinner ${large ? 'spinner--large' : ''}`} />;
}

export function StatusPage({
  icon,
  title,
  description,
  children,
}: {
  icon: IconName;
  title: string;
  description?: string;
  children?: ReactNode;
}): React.ReactElement {
  return (
    <div className="status-page">
      <span className="status-page__icon">
        <Icon name={icon} size={72} />
      </span>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {children ? <div style={{ marginTop: 10 }}>{children}</div> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dialog                                                                      */
/* -------------------------------------------------------------------------- */

export function Dialog({
  title,
  description,
  children,
  actions,
  onClose,
  width,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  width?: number;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-modal="true">
        <div className="dialog__header">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {children ? <div className="dialog__body">{children}</div> : null}
        {actions ? <div className="dialog__actions">{actions}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Menu (popover)                                                              */
/* -------------------------------------------------------------------------- */

export interface MenuItem {
  label: string;
  icon?: IconName;
  destructive?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  onSelect: () => void;
}

export function Menu({
  items,
  anchor,
  onClose,
}: {
  items: MenuItem[];
  anchor: { x: number; y: number };
  onClose: () => void;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    // Keep the menu on screen, flipping when it would overflow.
    const x = Math.min(anchor.x, window.innerWidth - rect.width - 8);
    const y = anchor.y + rect.height > window.innerHeight ? Math.max(8, anchor.y - rect.height) : anchor.y;
    setPosition({ x: Math.max(8, x), y });
  }, [anchor]);

  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="popover" style={{ left: position.x, top: position.y }} role="menu">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          {item.separatorBefore ? <div className="popover__separator" /> : null}
          <button
            type="button"
            role="menuitem"
            className={`popover__item ${item.destructive ? 'is-destructive' : ''}`}
            disabled={item.disabled}
            style={item.disabled ? { opacity: 0.45 } : undefined}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.icon ? <Icon name={item.icon} /> : <span style={{ width: 16 }} />}
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}

/** Hook that wires up right-click / long-press menus. */
export function useMenu(): {
  menu: ReactNode;
  open: (event: React.MouseEvent, items: MenuItem[]) => void;
} {
  const [state, setState] = useState<{ items: MenuItem[]; anchor: { x: number; y: number } } | null>(null);

  const open = useCallback((event: React.MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setState({ items, anchor: { x: event.clientX, y: event.clientY } });
  }, []);

  const menu = state ? <Menu items={state.items} anchor={state.anchor} onClose={() => setState(null)} /> : null;
  return { menu, open };
}

/* -------------------------------------------------------------------------- */
/* Toasts                                                                      */
/* -------------------------------------------------------------------------- */

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; onClick: () => void };
  tone?: 'error';
}

const ToastContext = createContext<(message: string, options?: Omit<Toast, 'id' | 'message'>) => void>(() => {});

export function useToast(): (message: string, options?: Omit<Toast, 'id' | 'message'>) => void {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, options?: Omit<Toast, 'id' | 'message'>) => {
    const id = ++counter.current;
    setToasts((current) => [...current.slice(-2), { id, message, ...options }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5200);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-area">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            {toast.tone === 'error' ? <Icon name="warning" /> : null}
            <span className="ellipsis" style={{ flex: 1 }}>
              {toast.message}
            </span>
            {toast.action ? (
              <Button variant="flat" size="small" pill onClick={toast.action.onClick}>
                {toast.action.label}
              </Button>
            ) : null}
            <Button
              variant="flat"
              size="small"
              circular
              icon="close"
              title="Dismiss"
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                        */
/* -------------------------------------------------------------------------- */

export function SearchEntry({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}): React.ReactElement {
  return (
    <div className="entry entry--search" style={{ flex: 1, minWidth: 0 }}>
      <Icon name="search" size={14} />
      <input
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="btn btn--flat btn--small btn--circular"
          onClick={() => onChange('')}
          aria-label="Clear search"
        >
          <Icon name="close" size={12} />
        </button>
      ) : null}
    </div>
  );
}

export function Banner({
  children,
  tone,
  action,
}: {
  children: ReactNode;
  tone?: 'error';
  action?: ReactNode;
}): React.ReactElement {
  return (
    <div className={`banner ${tone === 'error' ? 'banner--error' : ''}`}>
      <Icon name={tone === 'error' ? 'warning' : 'info'} />
      <span style={{ flex: 1 }}>{children}</span>
      {action}
    </div>
  );
}
