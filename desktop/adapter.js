(() => {
  const host = location.hostname;
  const chat = /(^|\.)nomi\.ai$/.test(host) || ['chatgpt.com', 'chat.openai.com'].includes(host);
  if (!chat && host !== 'bridge.local') return;
  const listeners = [];
  globalThis.__bridgeInspect = () => new Promise(resolve => {
    for (const listener of listeners) listener({type:'inspect'}, {}, resolve);
  });
  globalThis.__bridgeWake = () => {
    for (const listener of listeners) listener({type:'wake'}, {}, () => {});
  };
  const bridgeAPI = {
    runtime: {
      getManifest: () => ({version:'0.2.0'}),
      sendMessage: message => globalThis.desktopBridge(message),
      onMessage: {addListener: listener => listeners.push(listener)}
    },
    storage: {local: {get: async () => ({})}, onChanged: {addListener: () => {}}}
  };
  if (chat) globalThis.desktopBridgeChrome = bridgeAPI;
  else globalThis.chrome = bridgeAPI;
})();
