'use strict';

const config = require('config');
const WebsocketConnectionManager = require('./lib/main/ws-connection-manager.js');
const ConnectionManager = require('./lib/main/connection-manager.js');
const SFUModuleManager = require('./lib/main/sfu-module-manager.js');
const Janitor = require('./lib/main/janitor.js');

const HTTP_SERVER_HOST = config.has('clientHost') ? config.get('clientHost') : '127.0.0.1';
const HTTP_SERVER_PORT = config.get('clientPort');
const WS_SERVER_OPTIONS = config.has('wsServerOptions')
  ? config.get('wsServerOptions')
  : { maxPayload: 51200 };

const WSManager = new WebsocketConnectionManager(
  HTTP_SERVER_HOST,
  HTTP_SERVER_PORT,
  '/bbb-webrtc-sfu',
  WS_SERVER_OPTIONS
);

const CM = new ConnectionManager();

SFUModuleManager.start();
CM.setupModuleRouting(SFUModuleManager.modules);
CM.addAdapter(WSManager);
Janitor.clockIn();
