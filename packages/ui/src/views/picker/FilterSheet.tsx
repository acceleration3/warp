import { useState } from 'react';

import { DEFAULT_IGNORES, formatBytes, type FileCategory, type FilterRules } from '@share/core';

import { Button, Dialog, Group, Row, SwitchRow } from '../../components';
import { Icon } from '../../icons';

const CATEGORIES: Array<{ value: FileCategory; label: string }> = [
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Audio' },
  { value: 'document', label: 'Documents' },
  { value: 'spreadsheet', label: 'Spreadsheets' },
  { value: 'presentation', label: 'Presentations' },
  { value: 'archive', label: 'Archives' },
  { value: 'code', label: 'Code' },
  { value: 'app', label: 'Apps' },
  { value: 'other', label: 'Other' },
];

const SIZE_STEPS = [0, 1024, 100 * 1024, 1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024, 1024 ** 3, 10 * 1024 ** 3];

function sizeToStep(bytes: number | undefined, fallback: number): number {
  if (bytes === undefined) return fallback;
  const index = SIZE_STEPS.findIndex((step) => step >= bytes);
  return index === -1 ? SIZE_STEPS.length - 1 : index;
}

const DAY = 86_400_000;
const AGE_PRESETS = [
  { label: 'Any time', value: 0 },
  { label: 'Today', value: 1 },
  { label: 'Past week', value: 7 },
  { label: 'Past month', value: 30 },
  { label: 'Past year', value: 365 },
];

/** Comma/space separated token editor used for extensions and globs. */
function TokenField({
  value,
  onChange,
  placeholder,
  monospace,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  monospace?: boolean;
}): React.ReactElement {
  const [draft, setDraft] = useState('');

  const commit = (): void => {
    const tokens = draft
      .split(/[\s,]+/)
      .map((token) => token.trim())
      .filter(Boolean);
    if (tokens.length === 0) return;
    onChange([...new Set([...value, ...tokens])]);
    setDraft('');
  };

  return (
    <div className="stack stack--sm" style={{ width: '100%' }}>
      <div className="entry">
        <input
          value={draft}
          placeholder={placeholder}
          className={monospace ? 'monospace' : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
            if (event.key === 'Backspace' && draft === '' && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={commit}
        />
        <Button size="small" variant="flat" circular icon="plus" title="Add" onClick={commit} />
      </div>
      {value.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {value.map((token) => (
            <button
              key={token}
              type="button"
              className="badge"
              style={{ cursor: 'default', border: 0 }}
              onClick={() => onChange(value.filter((item) => item !== token))}
              title="Remove"
            >
              <span className={monospace ? 'monospace' : undefined}>{token}</span>
              <Icon name="close" size={10} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FilterSheet({
  filter,
  onChange,
  onClose,
}: {
  filter: FilterRules;
  onChange: (next: FilterRules) => void;
  onClose: () => void;
}): React.ReactElement {
  const patch = (next: Partial<FilterRules>): void => onChange({ ...filter, ...next });

  const minStep = sizeToStep(filter.minSize, 0);
  const maxStep = sizeToStep(filter.maxSize, SIZE_STEPS.length - 1);
  const ageDays = filter.modifiedAfter ? Math.round((Date.now() - filter.modifiedAfter) / DAY) : 0;

  return (
    <Dialog
      title="Filters"
      description="Applied while browsing and again when the selection is expanded"
      width={620}
      onClose={onClose}
      actions={
        <>
          <Button
            variant="flat"
            onClick={() =>
              onChange({
                includeGlobs: [],
                excludeGlobs: [],
                extensions: [],
                categories: [],
                includeHidden: false,
                followSymlinks: false,
                useDefaultIgnores: true,
              })
            }
          >
            Reset
          </Button>
          <Button variant="suggested" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <Group title="File kinds">
        <Row
          title="Categories"
          subtitle={filter.categories.length === 0 ? 'Everything' : `${filter.categories.length} selected`}
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, padding: '4px 14px 14px' }}>
          {CATEGORIES.map((category) => {
            const active = filter.categories.includes(category.value);
            return (
              <Button
                key={category.value}
                size="small"
                pill
                variant={active ? 'suggested' : 'normal'}
                onClick={() =>
                  patch({
                    categories: active
                      ? filter.categories.filter((item) => item !== category.value)
                      : [...filter.categories, category.value],
                  })
                }
              >
                {category.label}
              </Button>
            );
          })}
        </div>
      </Group>

      <Group title="Extensions" description="Only send files with these extensions">
        <Row
          title="Allowed extensions"
          subtitle={filter.extensions.length === 0 ? 'Any extension' : undefined}
          suffix={null}
        />
        <div style={{ padding: '0 14px 14px' }}>
          <TokenField
            value={filter.extensions}
            onChange={(extensions) => patch({ extensions })}
            placeholder="jpg, png, pdf"
          />
        </div>
      </Group>

      <Group title="Size">
        <Row
          title="Smallest"
          subtitle={minStep === 0 ? 'No minimum' : formatBytes(SIZE_STEPS[minStep] ?? 0)}
          suffix={
            <input
              type="range"
              min={0}
              max={SIZE_STEPS.length - 1}
              value={minStep}
              style={{ width: 180 }}
              onChange={(event) => {
                const step = Number(event.target.value);
                patch({ minSize: step === 0 ? undefined : SIZE_STEPS[step] });
              }}
            />
          }
        />
        <Row
          title="Largest"
          subtitle={
            maxStep === SIZE_STEPS.length - 1 ? 'No maximum' : formatBytes(SIZE_STEPS[maxStep] ?? 0)
          }
          suffix={
            <input
              type="range"
              min={0}
              max={SIZE_STEPS.length - 1}
              value={maxStep}
              style={{ width: 180 }}
              onChange={(event) => {
                const step = Number(event.target.value);
                patch({ maxSize: step === SIZE_STEPS.length - 1 ? undefined : SIZE_STEPS[step] });
              }}
            />
          }
        />
      </Group>

      <Group title="Modified">
        <Row
          title="Changed within"
          suffix={
            <select
              className="entry"
              style={{ minHeight: 32 }}
              value={ageDays}
              onChange={(event) => {
                const days = Number(event.target.value);
                patch({ modifiedAfter: days === 0 ? undefined : Date.now() - days * DAY });
              }}
            >
              {AGE_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
            </select>
          }
        />
      </Group>

      <Group title="Patterns" description="Glob syntax: * matches within a folder, ** across folders">
        <Row title="Include only" subtitle="Leave empty to include everything" />
        <div style={{ padding: '0 14px 12px' }}>
          <TokenField
            monospace
            value={filter.includeGlobs}
            onChange={(includeGlobs) => patch({ includeGlobs })}
            placeholder="**/*.raw"
          />
        </div>
        <Row title="Exclude" />
        <div style={{ padding: '0 14px 14px' }}>
          <TokenField
            monospace
            value={filter.excludeGlobs}
            onChange={(excludeGlobs) => patch({ excludeGlobs })}
            placeholder="**/cache/**"
          />
        </div>
      </Group>

      <Group title="Rules">
        <SwitchRow
          title="Skip junk folders"
          subtitle={`Ignores ${DEFAULT_IGNORES.length} patterns such as node_modules, .git and .DS_Store`}
          checked={filter.useDefaultIgnores}
          onChange={(useDefaultIgnores) => patch({ useDefaultIgnores })}
        />
        <SwitchRow
          title="Show hidden files"
          subtitle="Files and folders starting with a dot"
          checked={filter.includeHidden}
          onChange={(includeHidden) => patch({ includeHidden })}
        />
        <SwitchRow
          title="Follow symbolic links"
          subtitle="Off is safer: links can point outside the folder you picked"
          checked={filter.followSymlinks}
          onChange={(followSymlinks) => patch({ followSymlinks })}
        />
        <Row
          title="Folder depth"
          subtitle={filter.maxDepth === undefined ? 'Unlimited' : `${filter.maxDepth} levels below the folder`}
          suffix={
            <input
              type="range"
              min={0}
              max={20}
              value={filter.maxDepth ?? 20}
              style={{ width: 180 }}
              onChange={(event) => {
                const depth = Number(event.target.value);
                patch({ maxDepth: depth >= 20 ? undefined : depth });
              }}
            />
          }
        />
      </Group>
    </Dialog>
  );
}
