'use strict';

const HttpServer = require('./lib/connection-manager/HttpServer.js');
const WebsocketConnectionManager = require('./lib/connection-manager/WebsocketConnectionManager.js');
const ConnectionManager = require('./lib/connection-manager/ConnectionManager.js');
const ProcessManager = require('./lib/ProcessManager.js');
const Logger = require('./lib/utils/Logger.js');

const HTTPServer = new HttpServer();
const WSManager = new WebsocketConnectionManager(HTTPServer.getServerObject(), '/bbb-webrtc-sfu');
const CM = new ConnectionManager();

ProcessManager.start();
CM.setupModuleRouting(ProcessManager.modules);
CM.setHttpServer(HTTPServer);
CM.addAdapter(WSManager);
CM.listen(() => {
  Logger.info("[MainProcess] Server started");
});
