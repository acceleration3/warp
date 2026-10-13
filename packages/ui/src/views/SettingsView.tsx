import { useEffect, useState } from 'react';

import { THUMBNAIL_SIZE, TRANSFER_LIMITS, formatBytes, type AppState } from '@share/core';

import { bridge, isAndroid } from '../bridge';
import { Badge, Button, ComboRow, Group, Row, SpinRow, SwitchRow, useToast } from '../components';
import { Icon } from '../icons';
import { useSettings } from '../store';

/**
 * Android kills background network jobs aggressively. The foreground service
 * covers the documented cases, but several OEM skins still freeze sockets
 * unless the app is exempt from battery optimisation, so it is worth asking.
 */
function BackgroundGroup(): React.ReactElement | null {
  const [exempt, setExempt] = useState<boolean | null>(null);
  const toast = useToast();

  useEffect(() => {
    const api = bridge().isBatteryExempt;
    if (!api) return;
    void api().then(setExempt).catch(() => setExempt(null));
  }, []);

  if (!isAndroid()) return null;

  return (
    <Group
      title="Running in the background"
      description="A transfer keeps going with the screen off and the app swiped away. Android needs a couple of things for that to hold."
    >
      <Row
        title="Keep transfers alive"
        subtitle="A notification stays up while files are moving; this is what stops the system suspending the transfer"
        icon="shield"
        suffix={<Badge tone="success">always on</Badge>}
      />
      <Row
        title="Ignore battery optimisation"
        subtitle={
          exempt === null
            ? 'Recommended on Xiaomi, Oppo, Huawei and Samsung devices'
            : exempt
              ? 'Granted - the system will not freeze transfers'
              : 'Not granted, so long transfers may be interrupted'
        }
        icon="bolt"
        activatable={!exempt}
        onClick={
          exempt
            ? undefined
            : () => {
                const api = bridge().requestBatteryExemption;
                if (!api) return;
                void api().then((granted) => {
                  setExempt(granted);
                  toast(granted ? 'Transfers will no longer be interrupted' : 'Permission not granted');
                });
              }
        }
        suffix={
          exempt ? (
            <Badge tone="success" icon="check">
              granted
            </Badge>
          ) : (
            <Button size="small" variant="suggested" pill>
              Allow
            </Button>
          )
        }
      />
    </Group>
  );
}

const CHUNK_CHOICES = [1, 2, 4, 8, 16, 32, 64].map((mb) => ({
  value: String(mb * 1024 * 1024),
  label: `${mb} MB`,
}));

const SPLIT_CHOICES = [1, 4, 16, 64, 256, 1024].map((mb) => ({
  value: String(mb * 1024 * 1024),
  label: mb >= 1024 ? '1 GB' : `${mb} MB`,
}));

const THROTTLE_CHOICES = [
  { value: '0', label: 'Unlimited' },
  { value: String(1024 * 1024), label: '1 MB/s' },
  { value: String(5 * 1024 * 1024), label: '5 MB/s' },
  { value: String(20 * 1024 * 1024), label: '20 MB/s' },
  { value: String(50 * 1024 * 1024), label: '50 MB/s' },
];

export function SettingsView({ state }: { state: AppState }): React.ReactElement {
  const { settings, update, updateTransfer } = useSettings(state);
  const toast = useToast();
  const transfer = settings.transfer;

  const maxInFlight = transfer.parallelFiles * transfer.connectionsPerFile;

  return (
    <div className="content__inner">
      <Group title="This device">
        <Row
          title="Device name"
          subtitle="Shown to everyone else on the network"
          icon="laptop"
          suffix={
            <div className="entry" style={{ minWidth: 220 }}>
              <input
                value={settings.deviceName}
                onChange={(event) => update({ deviceName: event.target.value })}
              />
            </div>
          }
        />
        <ComboRow
          title="Appearance"
          value={settings.theme}
          options={[
            { value: 'system', label: 'Follow system' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={(theme) => update({ theme })}
        />
        <SwitchRow
          title="Notifications"
          subtitle="Tell me when a transfer arrives or finishes"
          checked={settings.notifications}
          onChange={(notifications) => update({ notifications })}
        />
      </Group>

      <BackgroundGroup />

      <Group title="Receiving">
        <Row
          title="Save files to"
          subtitle={settings.downloadDirectory || 'Not set'}
          icon="folder"
          activatable
          onClick={() =>
            void bridge()
              .chooseDownloadDirectory()
              .then((dir) => dir && toast(`Saving to ${dir}`))
          }
          suffix={<Icon name="chevron-right" />}
        />
        <SwitchRow
          title="Group by sender"
          subtitle="Put incoming files in a subfolder named after the device that sent them"
          checked={settings.groupBySender}
          onChange={(groupBySender) => update({ groupBySender })}
        />
        <SwitchRow
          title="Ask before accepting"
          subtitle="Turn this off only on networks you trust completely"
          checked={settings.confirmIncoming}
          onChange={(confirmIncoming) => update({ confirmIncoming })}
        />
      </Group>

      <Group
        title="Queue"
        description="How many transfers run at once. The rest wait in line and can be reordered."
      >
        <SpinRow
          title="Transfers at once"
          subtitle="Each one still uses the parallel settings below"
          value={transfer.maxConcurrentTransfers}
          min={TRANSFER_LIMITS.maxConcurrentTransfers.min}
          max={TRANSFER_LIMITS.maxConcurrentTransfers.max}
          onChange={(maxConcurrentTransfers) => updateTransfer({ maxConcurrentTransfers })}
        />
        <SwitchRow
          title="Start automatically"
          subtitle="Off means new transfers wait in the queue until you press play"
          checked={transfer.autoStartQueue}
          onChange={(autoStartQueue) => updateTransfer({ autoStartQueue })}
        />
        <SpinRow
          title="Retry failed transfers"
          subtitle="Automatic attempts before it gives up and waits for you"
          value={transfer.queueAutoRetries}
          min={TRANSFER_LIMITS.queueAutoRetries.min}
          max={TRANSFER_LIMITS.queueAutoRetries.max}
          onChange={(queueAutoRetries) => updateTransfer({ queueAutoRetries })}
        />
      </Group>

      <Group
        title="Speed"
        description={`Currently up to ${maxInFlight} simultaneous connections per transfer. More is not always faster: on a wired LAN 2-4 usually saturates the link, while Wi-Fi and VPNs benefit from more.`}
      >
        <SpinRow
          title="Files at once"
          subtitle="How many files are uploaded simultaneously"
          value={transfer.parallelFiles}
          min={TRANSFER_LIMITS.parallelFiles.min}
          max={TRANSFER_LIMITS.parallelFiles.max}
          onChange={(parallelFiles) => updateTransfer({ parallelFiles })}
        />
        <SpinRow
          title="Connections per file"
          subtitle="Splits one large file across several connections"
          value={transfer.connectionsPerFile}
          min={TRANSFER_LIMITS.connectionsPerFile.min}
          max={TRANSFER_LIMITS.connectionsPerFile.max}
          onChange={(connectionsPerFile) => updateTransfer({ connectionsPerFile })}
        />
        <ComboRow
          title="Split files larger than"
          subtitle="Smaller files are sent whole - splitting them costs more than it saves"
          value={String(transfer.splitThresholdBytes)}
          options={SPLIT_CHOICES}
          onChange={(value) => updateTransfer({ splitThresholdBytes: Number(value) })}
        />
        <ComboRow
          title="Chunk size"
          subtitle="Bytes per ranged request when a file is split"
          value={String(transfer.chunkSizeBytes)}
          options={CHUNK_CHOICES}
          onChange={(value) => updateTransfer({ chunkSizeBytes: Number(value) })}
        />
        <SwitchRow
          title="Adapt automatically"
          subtitle="Open and close connections based on the throughput actually observed"
          checked={transfer.adaptiveConcurrency}
          onChange={(adaptiveConcurrency) => updateTransfer({ adaptiveConcurrency })}
        />
        <ComboRow
          title="Speed limit"
          value={String(transfer.throttleBytesPerSecond)}
          options={THROTTLE_CHOICES}
          onChange={(value) => updateTransfer({ throttleBytesPerSecond: Number(value) })}
        />
      </Group>

      <Group title="Reliability">
        <SwitchRow
          title="Resume interrupted transfers"
          subtitle="Asks the other device which parts it already has instead of starting over"
          checked={transfer.resumeEnabled}
          onChange={(resumeEnabled) => updateTransfer({ resumeEnabled })}
        />
        <SpinRow
          title="Retries per chunk"
          value={transfer.retries}
          min={TRANSFER_LIMITS.retries.min}
          max={TRANSFER_LIMITS.retries.max}
          onChange={(retries) => updateTransfer({ retries })}
        />
      </Group>

      <Group
        title="Discovery"
        description="Devices find each other with small UDP announcements. Both methods are used because some access points drop one or the other."
      >
        <SwitchRow
          title="Announce on the network"
          subtitle="Turning this off makes this device invisible, but it can still send"
          checked={settings.discovery.broadcast}
          onChange={(broadcast) => update({ discovery: { ...settings.discovery, broadcast } })}
        />
        <SwitchRow
          title="Use multicast"
          subtitle="Helps on networks that filter broadcast traffic"
          checked={settings.discovery.multicast}
          onChange={(multicast) => update({ discovery: { ...settings.discovery, multicast } })}
        />
        <Row
          title="Remembered addresses"
          subtitle={
            settings.discovery.manualPeers.length > 0
              ? settings.discovery.manualPeers.join(', ')
              : 'None - add one from the Devices page'
          }
          icon="link"
          suffix={
            settings.discovery.manualPeers.length > 0 ? (
              <Button
                size="small"
                variant="flat"
                onClick={() => update({ discovery: { ...settings.discovery, manualPeers: [] } })}
              >
                Clear
              </Button>
            ) : undefined
          }
        />
        <Row title="Listening on port" subtitle={`${state.self.port}`} icon="network" />
      </Group>

      <Group title="Picker defaults">
        <SwitchRow
          title="Skip junk folders"
          subtitle="node_modules, .git, cache folders and similar"
          checked={settings.picker.filter.useDefaultIgnores}
          onChange={(useDefaultIgnores) =>
            update({ picker: { ...settings.picker, filter: { ...settings.picker.filter, useDefaultIgnores } } })
          }
        />
        <SwitchRow
          title="Show thumbnails"
          subtitle="Preview images instead of type icons"
          checked={settings.picker.showThumbnails}
          onChange={(showThumbnails) => update({ picker: { ...settings.picker, showThumbnails } })}
        />
        <Row
          title="Thumbnail size"
          subtitle={`${settings.picker.thumbnailSize} px in the thumbnail view`}
          icon="image"
          suffix={
            <input
              type="range"
              min={THUMBNAIL_SIZE.min}
              max={THUMBNAIL_SIZE.max}
              step={THUMBNAIL_SIZE.step}
              value={settings.picker.thumbnailSize}
              aria-label="Thumbnail size"
              style={{ width: 180 }}
              disabled={!settings.picker.showThumbnails}
              onChange={(event) =>
                update({ picker: { ...settings.picker, thumbnailSize: Number(event.target.value) } })
              }
            />
          }
        />
        <Row
          title="Bookmarks"
          subtitle={
            settings.picker.bookmarks.length > 0
              ? `${settings.picker.bookmarks.length} saved`
              : 'Star a folder in the picker to save it here'
          }
          icon="star"
          suffix={
            settings.picker.bookmarks.length > 0 ? (
              <Button
                size="small"
                variant="flat"
                onClick={() => update({ picker: { ...settings.picker, bookmarks: [] } })}
              >
                Clear
              </Button>
            ) : undefined
          }
        />
      </Group>

      <p className="caption" style={{ padding: '0 2px 24px' }}>
        Transfers stay on your local network. Files are written to{' '}
        <span className="monospace">{settings.downloadDirectory}</span> and nothing is uploaded anywhere else.
        Total staged so far this session: {formatBytes(state.transfers.reduce((sum, t) => sum + t.bytesTransferred, 0))}.
      </p>
    </div>
  );
}
