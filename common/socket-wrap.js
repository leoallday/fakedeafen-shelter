export function getSocket(storesFlat) {
  const store =
    (typeof storesFlat.ConnectionStore?.getSocket === "function" && storesFlat.ConnectionStore) ||
    Object.values(storesFlat).find((s) => typeof s?.getSocket === "function");
  return store?.getSocket() ?? null;
}

export function makeSocketWrap(storesFlat, patchedSend) {
  let currentSocket = null;
  const ensureWrapped = () => {
    const socket = getSocket(storesFlat);
    if (!socket || socket.send === patchedSend) return;
    for (let f = socket.send; f; f = f.__realSend) {
      if (f === patchedSend) return;
    }
    patchedSend.__realSend = socket.send;
    socket.send = patchedSend;
    currentSocket = socket;
  };
  const restore = () => {
    if (currentSocket && currentSocket.send === patchedSend) {
      currentSocket.send = patchedSend.__realSend;
    }
    currentSocket = null;
  };
  return { ensureWrapped, restore };
}
