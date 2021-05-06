'use strict';

const config = require('config');
const HttpServer = require('./lib/connection-manager/HttpServer.js');
const WebsocketConnectionManager = require('./lib/connection-manager/WebsocketConnectionManager.js');
const ConnectionManager = require('./lib/connection-manager/ConnectionManager.js');
const SFUModuleManager = require('./lib/sfu-module-manager.js');
const Logger = require('./lib/utils/Logger.js');

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
  Logger.info("[MainProcess] Server started");
});
