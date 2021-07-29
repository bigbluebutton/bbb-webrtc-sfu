'use strict';

import config from 'config';
import { Logger } from './utils/Logger';

const HttpServer = require('./connection-manager/HttpServer.js');
const WebsocketConnectionManager = require('./connection-manager/WebsocketConnectionManager.js');
const ConnectionManager = require('./connection-manager/ConnectionManager.js');
const SFUModuleManager = require('./sfu-module-manager.js');

const HTTP_SERVER_HOST = config.has('clientHost') ? config.get('clientHost') : '127.0.0.1';
const HTTP_SERVER_PORT = config.get('clientPort');

const HTTPServer = new HttpServer(HTTP_SERVER_HOST, HTTP_SERVER_PORT);
HTTPServer.start();
const WSManager = new WebsocketConnectionManager(HTTPServer.getServerObject(), '/bbb-webrtc-sfu');
const CM = new ConnectionManager();

SFUModuleManager.start();
CM.setupModuleRouting(SFUModuleManager.modules);
CM.setHttpServer(HTTPServer);
CM.addAdapter(WSManager);
CM.listen(() => {
  Logger.info("[bbb-webrtc-sfu] API transport: up");
});
