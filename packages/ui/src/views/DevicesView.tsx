import { useState } from 'react';

import { DISCOVERY_PORT, formatRelativeTime, type AppState, type Peer } from '@share/core';

import { bridge } from '../bridge';
import { Badge, Button, Dialog, Group, Row, StatusPage, Spinner, useToast } from '../components';
import { Icon, iconForPlatform } from '../icons';

function AddPeerDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (): Promise<void> => {
    const trimmed = host.trim();
    if (!trimmed) return;
    setBusy(true);
    const [address, port] = trimmed.split(':');
    try {
      const peer = await bridge().addManualPeer(address ?? trimmed, port ? Number(port) : undefined);
      if (peer) {
        toast(`Added ${peer.name}`);
        onClose();
      } else {
        toast('No device answered at that address', { tone: 'error' });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Connect by address"
      description="For networks that block broadcast, or peers reached over a VPN such as ZeroTier or Tailscale."
      onClose={onClose}
      actions={
        <>
          <Button variant="flat" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="suggested" disabled={busy || !host.trim()} onClick={() => void submit()}>
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </>
      }
    >
      <div className="entry">
        <Icon name="network" size={14} />
        <input
          autoFocus
          value={host}
          placeholder="192.168.1.42 or 10.147.17.5:47655"
          onChange={(event) => setHost(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void submit()}
        />
      </div>
      <p className="caption" style={{ marginTop: 10 }}>
        The other device needs the app open. It will be remembered and probed on every start.
      </p>
    </Dialog>
  );
}

function SendTextDialog({ peer, onClose }: { peer: Peer; onClose: () => void }): React.ReactElement {
  const [text, setText] = useState('');
  const toast = useToast();

  return (
    <Dialog
      title={`Send text to ${peer.name}`}
      onClose={onClose}
      actions={
        <>
          <Button variant="flat" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="suggested"
            disabled={!text.trim()}
            onClick={() => {
              void bridge()
                .sendText(peer.id, text)
                .then(() => toast(`Sent to ${peer.name}`))
                .catch((error: unknown) =>
                  toast(error instanceof Error ? error.message : String(error), { tone: 'error' }),
                );
              onClose();
            }}
          >
            Send
          </Button>
        </>
      }
    >
      <textarea
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Paste a link, a code, anything…"
        rows={6}
        style={{
          width: '100%',
          resize: 'vertical',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--border)',
          background: 'var(--view-bg)',
          color: 'var(--view-fg)',
          padding: 10,
          fontSize: 13.5,
        }}
      />
    </Dialog>
  );
}

export function DevicesView({
  state,
  onPick,
}: {
  state: AppState;
  onPick: () => void;
}): React.ReactElement {
  const [addOpen, setAddOpen] = useState(false);
  const [textPeer, setTextPeer] = useState<Peer | null>(null);

  const overlay = state.interfaces.filter((iface) => iface.overlay);

  return (
    <div className="content__inner">
      <Group
        title="Devices on your network"
        description="Every device running the app announces itself. Nothing is sent until you choose what to share."
        actions={
          <div className="hbox hbox--sm">
            <Button size="small" icon="refresh" onClick={() => void bridge().refreshPeers()}>
              Refresh
            </Button>
            <Button size="small" icon="plus" onClick={() => setAddOpen(true)}>
              By address
            </Button>
          </div>
        }
      >
        {state.peers.length === 0 ? (
          <Row
            title="Looking for devices…"
            subtitle="Make sure the other device is on the same Wi-Fi and has the app open"
            prefix={<Spinner />}
          />
        ) : (
          state.peers.map((peer) => (
            <Row
              key={peer.id}
              title={peer.name}
              subtitle={
                <>
                  {peer.address}:{peer.port} · seen {formatRelativeTime(peer.lastSeen)}
                </>
              }
              icon={iconForPlatform(peer.platform)}
              activatable
              onClick={onPick}
              suffix={
                <>
                  {peer.manual ? (
                    <>
                      <Badge icon="link">manual</Badge>
                      <Button
                        size="small"
                        variant="flat"
                        circular
                        icon="close"
                        title={`Forget ${peer.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          void bridge().removePeer(peer.id);
                        }}
                      />
                    </>
                  ) : null}
                  {peer.via && state.interfaces.find((i) => i.name === peer.via)?.overlay ? (
                    <Badge tone="accent" icon="shield">
                      VPN
                    </Badge>
                  ) : null}
                  <Button
                    size="small"
                    variant="flat"
                    circular
                    icon="text"
                    title={`Send text to ${peer.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setTextPeer(peer);
                    }}
                  />
                  <Button
                    size="small"
                    variant="suggested"
                    pill
                    icon="send"
                    onClick={(event) => {
                      event.stopPropagation();
                      onPick();
                    }}
                  >
                    Send
                  </Button>
                </>
              }
            />
          ))
        )}
      </Group>

      <Group title="This device" description="How other devices see you">
        <Row
          title={state.self.name}
          subtitle={`Port ${state.self.port}`}
          icon={iconForPlatform(state.self.platform)}
        />
        {state.interfaces.map((iface) => (
          <Row
            key={`${iface.name}-${iface.address}`}
            title={iface.address}
            subtitle={iface.name}
            icon="network"
            suffix={iface.overlay ? <Badge tone="accent">overlay network</Badge> : <Badge>local</Badge>}
          />
        ))}
      </Group>

      {overlay.length > 0 ? (
        <p className="caption" style={{ padding: '0 2px 20px' }}>
          <Icon name="info" size={12} /> {overlay.map((iface) => iface.name).join(', ')} looks like a VPN or mesh
          network. Devices joined to it are discovered exactly like devices on your Wi-Fi, so this works off-site too.
        </p>
      ) : null}

      {state.peers.length === 0 ? (
        <StatusPage
          icon="network"
          title="No devices found yet"
          description="Both devices must be on the same network with the app open. On networks that block broadcast, connect by address instead."
        >
          <div className="stack stack--md" style={{ alignItems: 'center' }}>
            <Button variant="suggested" icon="plus" onClick={() => setAddOpen(true)}>
              Connect by address
            </Button>

            {/*
              A default-deny firewall is invisible from the inside: this device
              still announces and still reaches everyone else, it simply never
              receives. That looks identical to an empty network, so name it.
            */}
            {state.firewall ? (
              <div className="boxed-list" style={{ textAlign: 'left', maxWidth: 520 }}>
                <Row
                  title={`${state.firewall} is running on this computer`}
                  subtitle="Other devices cannot reach it until these ports are open"
                  icon="shield"
                />
                <div style={{ padding: '0 14px 14px' }}>
                  <pre
                    className="monospace"
                    style={{
                      margin: 0,
                      padding: 10,
                      whiteSpace: 'pre-wrap',
                      background: 'var(--view-bg)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius)',
                    }}
                  >
                    {state.firewall === 'ufw'
                      ? `sudo ufw allow ${DISCOVERY_PORT}/udp\nsudo ufw allow ${state.self.port}/tcp`
                      : `sudo firewall-cmd --permanent --add-port=${DISCOVERY_PORT}/udp\nsudo firewall-cmd --permanent --add-port=${state.self.port}/tcp\nsudo firewall-cmd --reload`}
                  </pre>
                  <p className="caption" style={{ margin: '8px 0 0' }}>
                    Discovery is inbound UDP {DISCOVERY_PORT}; transfers to this device are inbound TCP{' '}
                    {state.self.port}.
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </StatusPage>
      ) : null}

      {addOpen ? <AddPeerDialog onClose={() => setAddOpen(false)} /> : null}
      {textPeer ? <SendTextDialog peer={textPeer} onClose={() => setTextPeer(null)} /> : null}
    </div>
  );
}
