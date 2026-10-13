/**
 * Symbolic icons in the Adwaita spirit: 16px grid, single colour, stroke-based
 * where possible so they stay legible in both themes.
 */

export type IconName =
  | 'folder'
  | 'folder-open'
  | 'file'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'app'
  | 'document'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-up'
  | 'chevron-down'
  | 'check'
  | 'dash'
  | 'plus'
  | 'minus'
  | 'close'
  | 'search'
  | 'funnel'
  | 'grid'
  | 'list'
  | 'tree'
  | 'refresh'
  | 'send'
  | 'download'
  | 'upload'
  | 'pause'
  | 'play'
  | 'stop'
  | 'trash'
  | 'more'
  | 'settings'
  | 'laptop'
  | 'phone'
  | 'network'
  | 'home'
  | 'star'
  | 'eye'
  | 'sort'
  | 'clock'
  | 'warning'
  | 'info'
  | 'arrow-up'
  | 'arrow-down'
  | 'window-min'
  | 'window-max'
  | 'sidebar'
  | 'text'
  | 'link'
  | 'shield'
  | 'bolt';

const PATHS: Record<IconName, string> = {
  folder: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z',
  'folder-open': 'M2 11.5V4.5A1.5 1.5 0 0 1 3.5 3h3L8 5h4.5A1.5 1.5 0 0 1 14 6.5v1M2 11.5 3.8 7.6a1 1 0 0 1 .9-.6h9.6a.6.6 0 0 1 .55.85l-1.6 3.9a1.5 1.5 0 0 1-1.4.85H3.5A1.5 1.5 0 0 1 2 11.5',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  image: 'M2.5 3.5h11v9h-11zM2.5 10l3-3 2.5 2.5L10.5 7l3 3M6 6.2a.8.8 0 1 1-1.6 0 .8.8 0 0 1 1.6 0',
  video: 'M2 4.5h8v7H2zM10 7l4-2.5v7L10 9',
  audio: 'M6 11V3.5l7-1.5v7.5M6 11a2 2 0 1 1-4 0 2 2 0 0 1 4 0m7-2a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  archive: 'M2 4.5h12v8H2zM2 4.5 3 2h10l1 2.5M7 7h2v2H7z',
  code: 'm5.5 5-3 3 3 3m5-6 3 3-3 3M9.5 3.5l-3 9',
  app: 'M3 3h4.5v4.5H3zM8.5 3H13v4.5H8.5zM3 8.5h4.5V13H3zM8.5 8.5H13V13H8.5z',
  document: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4',
  'chevron-left': 'm10 3.5-4.5 4.5 4.5 4.5',
  'chevron-right': 'm6 3.5 4.5 4.5L6 12.5',
  'chevron-up': 'm3.5 10 4.5-4.5 4.5 4.5',
  'chevron-down': 'm3.5 6 4.5 4.5L12.5 6',
  check: 'm3 8.5 3.5 3.5L13 4.5',
  dash: 'M4 8h8',
  plus: 'M8 3.5v9M3.5 8h9',
  minus: 'M3.5 8h9',
  close: 'm4 4 8 8M12 4l-8 8',
  search: 'M11.5 11.5 14 14M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10',
  funnel: 'M2.5 3.5h11l-4.2 5v4l-2.6 1.3v-5.3z',
  grid: 'M2.5 2.5h5v5h-5zM8.5 2.5h5v5h-5zM2.5 8.5h5v5h-5zM8.5 8.5h5v5h-5z',
  list: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  tree: 'M3 3h4M3 3v9h3M6 8H3M8.5 3h5M6 8h7.5M6 12h7.5',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 2v3.5H10',
  send: 'm2 8 12-5.5-4.5 12L7.5 10z',
  download: 'M8 2.5v8M4.5 7.5 8 11l3.5-3.5M2.5 13.5h11',
  upload: 'M8 13.5v-8M4.5 8.5 8 5l3.5 3.5M2.5 2.5h11',
  pause: 'M5.5 3v10M10.5 3v10',
  play: 'M4.5 3 13 8l-8.5 5z',
  stop: 'M4 4h8v8H4z',
  trash: 'M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5 5 13.5h6l.5-9M6.5 7v4M9.5 7v4',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  settings: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4M12.8 9.8a1.2 1.2 0 0 0 .24 1.32l.05.05a1.45 1.45 0 1 1-2.06 2.06l-.04-.05a1.2 1.2 0 0 0-2.05.86v.12a1.45 1.45 0 1 1-2.9 0v-.06a1.2 1.2 0 0 0-2.1-.8l-.05.05A1.45 1.45 0 1 1 1.83 11.3l.05-.05a1.2 1.2 0 0 0-.86-2.05H.9a1.45 1.45 0 1 1 0-2.9h.06a1.2 1.2 0 0 0 .8-2.1l-.05-.05A1.45 1.45 0 1 1 3.77 2.1l.05.05a1.2 1.2 0 0 0 2.05-.86V1.2a1.45 1.45 0 1 1 2.9 0v.06a1.2 1.2 0 0 0 2.05.86l.05-.05a1.45 1.45 0 1 1 2.06 2.05l-.05.05a1.2 1.2 0 0 0 .86 2.05h.12a1.45 1.45 0 0 1 0 2.9h-.06a1.2 1.2 0 0 0-1.1.73',
  laptop: 'M3 4h10v6H3zM1.5 12.5h13',
  phone: 'M4.5 1.5h7v13h-7zM7 12.8h2',
  network: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13M1.5 8h13M8 1.5A10 10 0 0 1 8 14.5 10 10 0 0 1 8 1.5',
  home: 'M2.5 7 8 2.5 13.5 7v6.5h-11zM6.5 13.5v-4h3v4',
  star: 'm8 2 1.8 3.8 4.2.6-3 3 .7 4.1L8 11.6l-3.7 1.9.7-4.1-3-3 4.2-.6z',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8m6.5 2a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  sort: 'M4.5 2.5v11M2 11l2.5 2.5L7 11M11.5 13.5v-11M9 5l2.5-2.5L14 5',
  clock: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13M8 4.5V8l2.5 1.5',
  warning: 'M8 2 1.5 13.5h13zM8 6.5v3.5M8 12h.01',
  info: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13M8 7.5v4M8 5h.01',
  'arrow-up': 'M8 13V3.5M4 7l4-4 4 4',
  'arrow-down': 'M8 3v9.5M4 9l4 4 4-4',
  'window-min': 'M4 8.5h8',
  'window-max': 'M4 4.5h8v7H4z',
  sidebar: 'M2 3h12v10H2zM6.5 3v10',
  text: 'M3 4h10M3 8h10M3 12h6',
  link: 'M6.5 9.5a2.5 2.5 0 0 0 3.54 0l2-2a2.5 2.5 0 1 0-3.54-3.54l-1 1M9.5 6.5a2.5 2.5 0 0 0-3.54 0l-2 2a2.5 2.5 0 1 0 3.54 3.54l1-1',
  shield: 'M8 1.5 13.5 4v4c0 3.4-2.4 5.6-5.5 6.5C4.9 13.6 2.5 11.4 2.5 8V4z',
  bolt: 'M9 1.5 3.5 9h4l-.5 5.5L12.5 7h-4z',
};

const FILLED: ReadonlySet<IconName> = new Set<IconName>(['folder', 'play', 'send', 'stop', 'app', 'grid']);

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function Icon({ name, size = 16, className, style }: IconProps): React.ReactElement {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      style={style}
      aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Picks a meaningful icon for a file based on its category. */
export function iconForCategory(category: string): IconName {
  switch (category) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'archive':
      return 'archive';
    case 'code':
      return 'code';
    case 'app':
      return 'app';
    case 'document':
    case 'spreadsheet':
    case 'presentation':
      return 'document';
    default:
      return 'file';
  }
}

export function iconForPlatform(platform: string): IconName {
  if (platform === 'android' || platform === 'ios') return 'phone';
  return 'laptop';
}
