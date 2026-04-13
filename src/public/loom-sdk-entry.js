import { createInstance, setup } from '@loomhq/record-sdk';
import { isSupported } from '@loomhq/record-sdk/is-supported';

window.loomSdk = Object.assign({}, window.loomSdk || {}, {
  createInstance,
  setup,
  isSupported,
});
