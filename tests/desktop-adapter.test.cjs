const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('desktop chat adapter preserves the native browser chrome object', () => {
  const nativeChrome = {app:{isInstalled:false}, csi:() => ({})};
  const context = {location:{hostname:'chatgpt.com'}, chrome:nativeChrome, desktopBridge:async()=>({})};
  vm.runInNewContext(fs.readFileSync(require.resolve('../desktop/adapter.js'),'utf8'),context);
  assert.equal(context.chrome,nativeChrome);
  assert.equal(typeof context.desktopBridgeChrome.runtime.sendMessage,'function');
  assert.equal(typeof context.__bridgeWake,'function');
});
