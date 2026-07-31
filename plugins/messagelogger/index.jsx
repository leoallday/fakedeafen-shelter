const {
  flux: { storesFlat, dispatcher },
  plugin: { scoped, store },
  solid: { createSignal, createEffect, onCleanup, For, Show },
  ui: { Header, HeaderTags, Text, TextTags, TextBox, Button, ButtonColors, ButtonSizes, ButtonLooks, Divider, SwitchItem, Slider },
} = shelter;

const MAX_LOGS = 300;
const MAX_CONTENT = 1000;
const MAX_EDITS = 20;
const MAX_EDIT_TRACKS = 500;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_KEPT = 500;
const EPHEMERAL = 64;

store.logs ??= [];
store.edits ??= {};
store.ignoreBots ??= false;
store.ignoreSelf ??= false;
store.cacheMedia ??= true;
store.mediaMaxMB ??= 100;
store.keepInChat ??= true;
store.kept ??= {};

const pendingKeeps = new Map();
let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("MessageLogger", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("media", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
function idbReq(mode, op) {
  return idb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("media", mode);
        const req = op(tx.objectStore("media"));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
      })
  );
}
const idbPut = (rec) => idbReq("readwrite", (s) => s.put(rec));
const idbGet = (id) => idbReq("readonly", (s) => s.get(id));
const idbGetAll = () => idbReq("readonly", (s) => s.getAll());
const idbDelete = (id) => idbReq("readwrite", (s) => s.delete(id));
const idbClear = () => idbReq("readwrite", (s) => s.clear());

async function evictIfNeeded() {
  const recs = await idbGetAll();
  let total = recs.reduce((s, r) => s + r.size, 0);
  const max = store.mediaMaxMB * 1024 * 1024;
  if (total <= max) return;
  recs.sort((a, b) => a.cachedAt - b.cachedAt);
  for (const r of recs) {
    if (total <= max) break;
    await idbDelete(r.id);
    total -= r.size;
  }
}

function cacheMedia(attachments) {
  if (!store.cacheMedia) return;
  for (const a of attachments) {
    fetch(a.url)
      .then((r) => (r.ok ? r.blob() : null))
      .then(async (blob) => {
        if (!blob || blob.size > MAX_ATTACHMENT_BYTES) return;
        await idbPut({ id: a.id, blob, size: blob.size, cachedAt: Date.now(), filename: a.filename });
        await evictIfNeeded();
      })
      .catch(() => {});
  }
}

function authorFrom(msg) {
  return msg.author?.id
    ? {
        id: msg.author.id,
        name: msg.author.username ?? msg.author.global_name ?? "Unknown",
        bot: !!msg.author.bot,
      }
    : { id: msg.author_id ?? "unknown", name: "Unknown", bot: false };
}

function shouldIgnore(author) {
  return (
    (store.ignoreBots && author.bot) ||
    (store.ignoreSelf && author.id === storesFlat.UserStore?.getCurrentUser()?.id)
  );
}

function serializeMessage(channelId, guildId, id) {
  const msg = storesFlat.MessageStore?.getMessage(channelId, id);
  if (!msg || msg.flags & EPHEMERAL) return null;

  const author = authorFrom(msg);
  if (shouldIgnore(author)) return null;

  const content = (msg.content || "").slice(0, MAX_CONTENT);
  const attachments = (msg.attachments || []).map((a) => ({
    id: a.id,
    filename: a.filename,
    url: a.url,
    contentType: a.content_type,
    size: a.size,
  }));
  if (!content && !attachments.length && !(msg.embeds || []).length) return null;

  const me = storesFlat.UserStore?.getCurrentUser();
  const ghostPing =
    !!me && ((msg.mentions || []).some((m) => (m.id ?? m) === me.id) || !!msg.mention_everyone);

  return {
    id,
    channelId,
    guildId,
    author,
    content,
    attachments,
    ghostPing,
    timestamp: msg.timestamp ?? new Date().toISOString(),
  };
}

function pushLog(entry) {
  store.logs = [entry, ...store.logs.filter((l) => l.id !== entry.id)].slice(0, MAX_LOGS);
  if (entry.type === "delete") cacheMedia(entry.attachments);
}

function addKept(id, channelId) {
  if (store.kept[id]) return;
  const kept = { ...store.kept, [id]: channelId };
  const keys = Object.keys(kept);
  if (keys.length > MAX_KEPT) delete kept[keys[0]];
  store.kept = kept;
}

function keepLive(channelId, id) {
  const msg = storesFlat.MessageStore?.getMessage(channelId, id);
  if (!msg) return;
  pendingKeeps.set(id, msg);
  setTimeout(() => restoreMessage(channelId, id), 0);
}

function restoreMessage(channelId, id) {
  const msg = pendingKeeps.get(id);
  pendingKeeps.delete(id);
  if (!msg || !store.kept[id]) return;
  try {
    msg.deleted = true;
    for (const a of msg.attachments || []) a.deleted = true;
    const cache = storesFlat.MessageStore?.getMessages?.(channelId);
    if (!cache) return;
    if (cache.has?.(id)) {
      cache.update?.(id, () => msg);
    } else if (typeof cache.add === "function") {
      cache.add(msg);
    } else if (typeof cache.set === "function") {
      cache.set(id, msg);
    }
    dispatcher.dispatch({ type: "MESSAGE_UPDATE", message: { id, channel_id: channelId } });
  } catch {}
}

function forceDelete(id) {
  const channelId = store.kept[id];
  if (!channelId) return;
  const kept = { ...store.kept };
  delete kept[id];
  store.kept = kept;
  dispatcher.dispatch({ type: "MESSAGE_DELETE", channelId, id, mlForced: true });
}

function logDelete(channelId, guildId, id) {
  const entry = serializeMessage(channelId, guildId, id);
  if (!entry) return;

  const key = `${channelId}:${id}`;
  const history = store.edits[key];
  if (history?.length) {
    entry.editHistory = history;
    const rest = { ...store.edits };
    delete rest[key];
    store.edits = rest;
  }

  entry.type = "delete";
  entry.loggedAt = new Date().toISOString();
  pushLog(entry);
}

function logEdit(channelId, guildId, msg) {
  if (!msg?.content) return;
  const oldMsg = storesFlat.MessageStore?.getMessage(channelId, msg.id);
  if (!oldMsg || msg.content === oldMsg.content) return;

  const author = authorFrom(oldMsg);
  if (shouldIgnore(author)) return;

  const key = `${channelId}:${msg.id}`;
  const history = store.edits[key] ?? [];
  const rest = { ...store.edits };
  rest[key] = [
    ...history,
    { content: oldMsg.content.slice(0, MAX_CONTENT), timestamp: msg.edited_timestamp ?? new Date().toISOString() },
  ].slice(-MAX_EDITS);
  const keys = Object.keys(rest);
  if (keys.length > MAX_EDIT_TRACKS) delete rest[keys[0]];
  store.edits = rest;

  pushLog({
    id: msg.id,
    channelId,
    guildId,
    type: "edit",
    author,
    content: oldMsg.content.slice(0, MAX_CONTENT),
    attachments: [],
    timestamp: oldMsg.timestamp ?? new Date().toISOString(),
    loggedAt: new Date().toISOString(),
  });
}

scoped.flux.intercept((dispatch) => {
  if (dispatch.type === "MESSAGE_DELETE") {
    if (dispatch.mlForced) return;
    if (logDelete(dispatch.channelId, dispatch.guildId, dispatch.id) && store.keepInChat) {
      addKept(dispatch.id, dispatch.channelId);
      keepLive(dispatch.channelId, dispatch.id);
    }
  } else if (dispatch.type === "MESSAGE_DELETE_BULK") {
    if (dispatch.mlForced) return;
    for (const id of dispatch.ids || []) {
      if (logDelete(dispatch.channelId, dispatch.guildId, id) && store.keepInChat) {
        addKept(id, dispatch.channelId);
        keepLive(dispatch.channelId, id);
      }
    }
  } else if (dispatch.type === "MESSAGE_UPDATE") {
    logEdit(dispatch.channelId, dispatch.guildId, dispatch.message);
  }
});

scoped.ui.injectCss(`
  .ml-kept-deleted {
    background-color: rgba(240, 71, 71, 0.15);
    border-radius: 8px;
  }
  .ml-kept-deleted div {
    color: #f04747;
  }
  .ml-kept-deleted img,
  .ml-kept-deleted video {
    filter: grayscale(1);
  }
`);

function addDeleteToMenu(menu, id) {
  if (menu.querySelector(".ml-delete-item")) return;
  const template = menu.querySelector('[role="menuitem"]');
  if (!template) return;
  const item = template.cloneNode(true);
  item.classList.add("ml-delete-item");
  const icon = item.querySelector('[class*="menuItemIcon"]');
  if (icon) icon.textContent = "";
  const label = item.querySelector('[class*="menuItemLabel"]') ?? item;
  label.textContent = "Delete from logs";
  label.style.color = "#f04747";
  item.onclick = (e) => {
    e.stopPropagation();
    forceDelete(id);
    dispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" });
  };
  menu.appendChild(item);
}

scoped.observeDom('[id^="chat-messages-"]', (el) => {
  const parts = el.id.split("-");
  if (parts.length < 4) return;
  const id = parts[parts.length - 1];
  if (!store.kept[id]) return;
  el.classList.add("ml-kept-deleted");
  if (el.dataset.mlCm) return;
  el.dataset.mlCm = 1;
  el.addEventListener("contextmenu", () => {
    if (!store.kept[id]) return;
    const timer = setInterval(() => {
      const menu = document.querySelector('[role="menu"]');
      if (menu) {
        clearInterval(timer);
        addDeleteToMenu(menu, id);
      }
    }, 20);
    setTimeout(() => clearInterval(timer), 1000);
  });
});

function fmtTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function channelLabel(entry) {
  try {
    const ch = storesFlat.ChannelStore?.getChannel(entry.channelId);
    if (ch?.name) return `#${ch.name}`;
    if (ch?.getName) return ch.getName();
  } catch {}
  return entry.channelId;
}

function Media({ a }) {
  const [cached, setCached] = createSignal(null);
  createEffect(() => {
    let objUrl = null;
    let done = false;
    idbGet(a.id).then((rec) => {
      if (done || !rec?.blob) return;
      objUrl = URL.createObjectURL(rec.blob);
      setCached(objUrl);
    });
    onCleanup(() => {
      done = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
    });
  });
  const src = () => cached() || a.url;
  const kind = a.contentType?.split("/")[0];

  if (kind === "image") {
    return <img src={src()} alt={a.filename} loading="lazy" style="max-width:100%;max-height:280px;border-radius:8px;display:block;margin:4px 0;" />;
  }
  if (kind === "video") {
    return <video src={src()} controls style="max-width:100%;max-height:280px;border-radius:8px;display:block;margin:4px 0;" />;
  }
  if (kind === "audio") {
    return <audio src={src()} controls style="display:block;margin:4px 0;" />;
  }
  return (
    <a href={a.url} target="_blank" style="color:var(--text-link);word-break:break-all;">
      {a.filename}
      {a.size ? ` (${(a.size / 1024).toFixed(0)} KB)` : ""}
    </a>
  );
}

function removeLog(id) {
  const entry = store.logs.find((l) => l.id === id);
  store.logs = store.logs.filter((l) => l.id !== id);
  if (entry?.type === "delete") forceDelete(id);
  if (entry) for (const a of entry.attachments || []) idbDelete(a.id).catch(() => {});
}

function clearAll() {
  const kept = store.kept;
  store.logs = [];
  store.edits = {};
  store.kept = {};
  for (const [id, channelId] of Object.entries(kept)) {
    dispatcher.dispatch({ type: "MESSAGE_DELETE", channelId, id, mlForced: true });
  }
  idbClear().catch(() => {});
}

export function settings() {
  const [q, setQ] = createSignal("");

  const filtered = () => {
    const query = q().trim().toLowerCase();
    if (!query) return store.logs;
    return store.logs.filter(
      (e) => e.content.toLowerCase().includes(query) || e.author.name.toLowerCase().includes(query)
    );
  };

  return (
    <div style="display:flex;flex-direction:column;gap:12px;">
      <SwitchItem checked={store.ignoreBots} onChange={(v) => (store.ignoreBots = v)}>
        Ignore bots
      </SwitchItem>
      <SwitchItem checked={store.ignoreSelf} onChange={(v) => (store.ignoreSelf = v)}>
        Ignore my own messages
      </SwitchItem>
      <SwitchItem checked={store.keepInChat} onChange={(v) => (store.keepInChat = v)}>
        Keep deleted messages in chat (red)
      </SwitchItem>
      <Text tag={TextTags.textSM} style="color:var(--text-muted);">
        Deleting an entry in the log below also removes it from chat.
      </Text>
      <SwitchItem checked={store.cacheMedia} onChange={(v) => (store.cacheMedia = v)}>
        Cache attachments locally
      </SwitchItem>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <Text tag={TextTags.textSM}>Media cache limit: {store.mediaMaxMB} MB</Text>
        <Slider value={store.mediaMaxMB} min={10} max={500} step={10} onInput={(v) => (store.mediaMaxMB = v)} />
      </div>
      <Divider />
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <Header tag={HeaderTags.HeadingLG}>Message Log</Header>
        <Button color={ButtonColors.CRITICAL_PRIMARY} onClick={clearAll}>
          Clear All
        </Button>
      </div>
      <TextBox placeholder="Search messages or authors..." value={q()} onInput={setQ} />
      <Text tag={TextTags.textSM} style="color:var(--text-muted);">
        {store.logs.length} logged
      </Text>
      <For each={filtered()}>
        {(e) => (
          <div style="background:var(--background-secondary);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
              <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                <span style="font-weight:600;color:var(--text-normal);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  {e.author.name}
                </span>
                <span style="color:var(--text-muted);font-size:12px;white-space:nowrap;">
                  {channelLabel(e)} · {fmtTime(e.loggedAt)}
                </span>
                <Show when={e.ghostPing}>
                  <span style="color:var(--status-danger,#f23f43);font-size:12px;font-weight:600;white-space:nowrap;">
                    ghost ping
                  </span>
                </Show>
                <Show when={e.type === "edit"}>
                  <span style="color:var(--text-muted);font-size:12px;font-weight:600;white-space:nowrap;">
                    edited
                  </span>
                </Show>
              </div>
              <div style="display:flex;gap:4px;flex-shrink:0;">
                {e.content && (
                  <Button look={ButtonLooks.FILLED} color={ButtonColors.SECONDARY} size={ButtonSizes.MIN} onClick={() => navigator.clipboard?.writeText(e.content)}>
                    Copy
                  </Button>
                )}
                <Button look={ButtonLooks.FILLED} color={ButtonColors.CRITICAL_SECONDARY} size={ButtonSizes.MIN} onClick={() => removeLog(e.id)}>
                  Delete
                </Button>
              </div>
            </div>
            <Show when={e.editHistory?.length}>
              <For each={[...e.editHistory].reverse()}>
                {(h) => (
                  <div style="color:var(--text-muted);font-size:12px;white-space:pre-wrap;word-break:break-word;">
                    <span style="color:var(--text-normal);">edited:</span> {h.content} · {fmtTime(h.timestamp)}
                  </div>
                )}
              </For>
            </Show>
            {e.content && <div style="color:var(--text-normal);white-space:pre-wrap;word-break:break-word;">{e.content}</div>}
            <For each={e.attachments}>{(a) => <Media a={a} />}</For>
          </div>
        )}
      </For>
      <Show when={!filtered().length}>
        <Text tag={TextTags.textSM} style="color:var(--text-muted);">
          {store.logs.length ? "No matches." : "No deleted messages logged yet."}
        </Text>
      </Show>
    </div>
  );
}
