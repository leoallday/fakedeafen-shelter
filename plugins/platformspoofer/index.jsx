const {
  flux: { storesFlat },
  plugin: { scoped, store },
  ui: { Header, HeaderTags, Divider },
} = shelter;

const PLATFORMS = {
  desktop: "Discord Client",
  web: "Discord Web",
  android: "Discord Android",
  ios: "Discord iOS",
  xbox: "Discord Embedded",
  playstation: "Discord Embedded",
  vr: "Discord VR",
};

store.platform ??= "desktop";

let socketStore = null;
let currentSocket = null;
let realSend = null;

function hasGetSocket(s) {
  return s && typeof s.getSocket === "function";
}

function findInWebpack() {
  const chunk = window.webpackChunkdiscord_app;
  if (!chunk) return null;
  let cache = null;
  try {
    chunk.push([["__platformspoofer"], {}, (r) => (cache = r.c)]);
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
  if (op === 2 && data?.properties) {
    const browser = PLATFORMS[store.platform];
    if (browser) {
      data = { ...data, properties: { ...data.properties, browser } };
    }
  }
  return realSend.call(this, op, data, ...args);
}

function ensureWrapped() {
  const socket = getSocket();
  if (!socket || socket.send === patchedSend) return;
  realSend = socket.send;
  socket.send = patchedSend;
  currentSocket = socket;
}

const RECONNECT_EVENTS = ["READY", "RESUMED", "CONNECTION_OPEN"];

export function onLoad() {
  ensureWrapped();
  for (const t of RECONNECT_EVENTS) scoped.flux.subscribe(t, ensureWrapped);
}

export function onUnload() {
  if (currentSocket && currentSocket.send === patchedSend) {
    currentSocket.send = realSend;
  }
  currentSocket = null;
}

export function settings() {
  return (
    <div style="display:flex;flex-direction:column;gap:12px;">
      <Header tag={HeaderTags.EYEBROW}>Platform</Header>
      <select
        value={store.platform}
        onChange={(e) => {
          store.platform = e.target.value;
        }}
        style="background:var(--background-secondary);color:var(--text-normal);border:1px solid var(--background-modifier-accent);border-radius:4px;padding:6px 8px;"
      >
        {Object.keys(PLATFORMS).map((p) => (
          <option value={p}>{p}</option>
        ))}
      </select>
      <Divider />
      <p style="color:var(--text-muted);font-size:12px;">
        Takes effect on your next reconnect. We can't guarantee this won't get you warned or banned.
      </p>
    </div>
  );
}
