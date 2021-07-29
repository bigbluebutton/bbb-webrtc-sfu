'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = __importDefault(require("config"));
const Logger_1 = require("./utils/Logger");
const HttpServer = require('./connection-manager/HttpServer.js');
const WebsocketConnectionManager = require('./connection-manager/WebsocketConnectionManager.js');
const ConnectionManager = require('./connection-manager/ConnectionManager.js');
const SFUModuleManager = require('./sfu-module-manager.js');
const HTTP_SERVER_HOST = config_1.default.has('clientHost') ? config_1.default.get('clientHost') : '127.0.0.1';
const HTTP_SERVER_PORT = config_1.default.get('clientPort');
const HTTPServer = new HttpServer(HTTP_SERVER_HOST, HTTP_SERVER_PORT);
HTTPServer.start();
const WSManager = new WebsocketConnectionManager(HTTPServer.getServerObject(), '/bbb-webrtc-sfu');
const CM = new ConnectionManager();
SFUModuleManager.start();
CM.setupModuleRouting(SFUModuleManager.modules);
CM.setHttpServer(HTTPServer);
CM.addAdapter(WSManager);
CM.listen(() => {
    Logger_1.Logger.info("[bbb-webrtc-sfu] API transport: up");
});
