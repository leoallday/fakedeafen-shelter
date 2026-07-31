import { getSocket, makeSocketWrap } from "../../common/socket-wrap.js";

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

function patchedSend(op, data, ...args) {
  if (op === 2 && data?.properties) {
    const browser = PLATFORMS[store.platform];
    if (browser) {
      data = { ...data, properties: { ...data.properties, browser } };
    }
  }
  return patchedSend.__realSend.call(this, op, data, ...args);
}

const { ensureWrapped, restore } = makeSocketWrap(storesFlat, patchedSend);

let didBootReidentify = false;

function forceFreshIdentify() {
  const socket = getSocket(storesFlat);
  if (!socket || !socket.sessionId || socket.send !== patchedSend) return false;
  socket.sessionId = null;
  socket.close();
  return true;
}

const RECONNECT_EVENTS = ["READY", "RESUMED", "CONNECTION_OPEN"];

export function onLoad() {
  ensureWrapped();
  for (const t of RECONNECT_EVENTS) scoped.flux.subscribe(t, ensureWrapped);
  const poll = setInterval(() => {
    ensureWrapped();
    if (!didBootReidentify && forceFreshIdentify()) didBootReidentify = true;
  }, 300);
  setTimeout(() => clearInterval(poll), 15000);
}

export function onUnload() {
  restore();
}

export function settings() {
  return (
    <div style="display:flex;flex-direction:column;gap:12px;">
      <Header tag={HeaderTags.EYEBROW}>Platform</Header>
      <select
        value={store.platform}
        onChange={(e) => {
          store.platform = e.target.value;
          forceFreshIdentify();
        }}
        style="background:var(--background-secondary);color:var(--text-normal);border:1px solid var(--background-modifier-accent);border-radius:4px;padding:6px 8px;"
      >
        {Object.keys(PLATFORMS).map((p) => (
          <option value={p}>{p}</option>
        ))}
      </select>
      <Divider />
      <p style="color:var(--text-muted);font-size:12px;">
        Applies immediately. We can't guarantee this won't get you warned or banned.
      </p>
    </div>
  );
}
