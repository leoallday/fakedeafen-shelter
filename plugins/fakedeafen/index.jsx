import { getSocket, makeSocketWrap } from "../../common/socket-wrap.js";

const {
  flux: { storesFlat },
  plugin: { scoped, store },
  solid: { createSignal, createEffect, onCleanup },
  ui: { SwitchItem, Button, Divider },
} = shelter;

store.fakeDeafen ??= false;
store.keybind ??= "Ctrl+Shift+F";

function patchedSend(op, data, ...args) {
  if (op === 4 && store.fakeDeafen && data) {
    data.self_deaf = true;
    data.self_mute = true;
  }
  return patchedSend.__realSend.call(this, op, data, ...args);
}

const { ensureWrapped, restore } = makeSocketWrap(storesFlat, patchedSend);

function sendVoiceStateUpdate() {
  const socket = getSocket(storesFlat);
  const channelId = storesFlat["SelectedChannelStore"]?.getVoiceChannelId();
  if (!socket || !channelId) return;
  const channel = storesFlat["ChannelStore"]?.getChannel(channelId);
  const me = storesFlat["MediaEngineStore"];
  socket.send(4, {
    guild_id: channel?.guild_id ?? null,
    channel_id: channelId,
    self_mute: store.fakeDeafen || !!me?.isMute(),
    self_deaf: store.fakeDeafen || !!me?.isDeaf(),
    self_video: false,
    flags: 0,
  });
}

function setFake(on) {
  if (store.fakeDeafen === on) return;
  store.fakeDeafen = on;
  sendVoiceStateUpdate();
}

function parseKeybind(kb) {
  if (!kb) return null;
  const parts = kb.split("+").map((p) => p.trim());
  const key = parts.pop();
  if (!key) return null;
  return {
    key,
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}

function onKeyDown(e) {
  const kb = parseKeybind(store.keybind);
  if (!kb) return;
  if (
    e.key.toLowerCase() === kb.key.toLowerCase() &&
    e.ctrlKey === kb.ctrl &&
    e.shiftKey === kb.shift &&
    e.altKey === kb.alt
  ) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    setFake(!store.fakeDeafen);
  }
}

const RECONNECT_EVENTS = ["READY", "RESUMED", "CONNECTION_OPEN", "VOICE_STATE_UPDATES"];

export function onLoad() {
  ensureWrapped();
  for (const t of RECONNECT_EVENTS) scoped.flux.subscribe(t, ensureWrapped);
  document.addEventListener("keydown", onKeyDown, true);
}

export function onUnload() {
  document.removeEventListener("keydown", onKeyDown, true);
  restore();
  if (store.fakeDeafen) {
    store.fakeDeafen = false;
    sendVoiceStateUpdate();
  }
}

export function settings() {
  const [recording, setRecording] = createSignal(false);
  const [kb, setKb] = createSignal(store.keybind);

  createEffect(() => {
    if (!recording()) return;
    const onRecord = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(false);
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const parts = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
      const combo = parts.join("+");
      store.keybind = combo;
      setKb(combo);
      setRecording(false);
    };
    document.addEventListener("keydown", onRecord, true);
    onCleanup(() => document.removeEventListener("keydown", onRecord, true));
  });

  return (
    <div style="display:flex;flex-direction:column;gap:12px;">
      <SwitchItem value={store.fakeDeafen} onChange={setFake}>
        Fake Deafen
      </SwitchItem>
      <Divider />
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <span>Keybind</span>
        <div style="display:flex;gap:8px;">
          <Button onClick={() => setRecording(!recording())}>
            {recording() ? "Press a key combination..." : kb() || "Click to set"}
          </Button>
          {!recording() && kb() && (
            <Button
              onClick={() => {
                store.keybind = "";
                setKb("");
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
