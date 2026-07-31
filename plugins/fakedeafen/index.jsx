const {
  flux: { storesFlat },
  plugin: { scoped, store },
  solid: { createSignal, createEffect, onCleanup },
  ui: { SwitchItem, Button, Divider },
} = shelter;

store.fakeDeafen ??= false;
store.keybind ??= "Ctrl+Shift+F";

let socketStore = null;
let currentSocket = null;

function hasGetSocket(s) {
  return s && typeof s.getSocket === "function";
}

function findInWebpack() {
  const chunk = window.webpackChunkdiscord_app;
  if (!chunk) return null;
  let cache = null;
  try {
    chunk.push([["__fakedeafen"], {}, (r) => (cache = r.c)]);
    chunk.pop();
  } catch {
    return null;
  }
  if (!cache) return null;
  for (const id in cache) {
    const mod = cache[id];
    if (hasGetSocket(mod?.exports)) return mod.exports;
  }
  return null;
}

function findSocketStore() {
  if (socketStore) return socketStore;
  socketStore =
    (hasGetSocket(storesFlat["ConnectionStore"]) && storesFlat["ConnectionStore"]) ||
    Object.values(storesFlat).find(hasGetSocket) ||
    findInWebpack();
  return socketStore;
}

function getSocket() {
  return findSocketStore()?.getSocket() ?? null;
}

function patchedSend(op, data, ...args) {
  if (op === 4 && store.fakeDeafen && data) data.self_deaf = true;
  return patchedSend.__realSend.call(this, op, data, ...args);
}

function ensureWrapped() {
  const socket = getSocket();
  if (!socket || socket.send === patchedSend) return;
  for (let f = socket.send; f; f = f.__realSend) {
    if (f === patchedSend) return;
  }
  patchedSend.__realSend = socket.send;
  socket.send = patchedSend;
  currentSocket = socket;
}

function realMuteDeaf() {
  const me = storesFlat["MediaEngineStore"];
  return { mute: !!me?.isMute(), deaf: !!me?.isDeaf() };
}

// op 4 = VOICE_STATE_UPDATE; the gateway uses this to broadcast your
// mute/deafen state to everyone in the channel, but it does NOT touch the
// local media engine, so your own audio keeps flowing.
function sendVoiceStateUpdate() {
  const socket = getSocket();
  const channelId = storesFlat["SelectedChannelStore"]?.getVoiceChannelId();
  if (!socket || !channelId) return;
  const channel = storesFlat["ChannelStore"]?.getChannel(channelId);
  const { mute, deaf } = realMuteDeaf();
  socket.send(4, {
    guild_id: channel?.guild_id ?? null,
    channel_id: channelId,
    self_mute: mute,
    self_deaf: store.fakeDeafen || deaf,
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
  // capture phase so Discord's own keybind handlers never also fire
  document.addEventListener("keydown", onKeyDown, true);
}

export function onUnload() {
  document.removeEventListener("keydown", onKeyDown, true);
  if (currentSocket && currentSocket.send === patchedSend) {
    currentSocket.send = patchedSend.__realSend;
  }
  currentSocket = null;
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
