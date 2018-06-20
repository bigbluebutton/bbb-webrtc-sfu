'use strict';

const config = require('config');
const ws = require('ws');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const PONG_TIMEOUT = config.get('websocketPongTimeout');
const PING_INTERVAL = config.get('websocketPingInterval');
const PONG_ID = 0x8a

// ID counter
let connectionIDCounter = 0;

ws.prototype.sendMessage = function(json) {

  let websocket = this;

  if (this._closeCode === 1000) {
    Logger.error("[WebsocketConnectionManager] Websocket closed, not sending");
    this._errorCallback("[WebsocketConnectionManager] Error: not opened");
  }

  return this.send(JSON.stringify(json), function(error) {
    if(error) {
      Logger.error('[WebsocketConnectionManager] Websocket error "' + error + '" on message "' + json.id + '"');

      websocket._errorCallback(error);
    }
  });

};



module.exports = class WebsocketConnectionManager {
  constructor (server, path) {
    this.wss = new ws.Server({
      server,
      path
    });

    this.webSockets = {};
    this.pingIntervals = {};

    this.wss.on('connection', this._onNewConnection.bind(this));
  }

  setEventEmitter (emitter) {
    this.emitter = emitter;
    this.emitter.on('response', this._onServerResponse.bind(this));
  }

  _onServerResponse (data) {
    // Here this is the 'ws' instance
    const connectionId = data? data.connectionId : null;
    const ws = this.webSockets[connectionId];
    if (ws) {
      ws.sendMessage(data);
    }
  }

  _onNewConnection (ws) {
    ws.id = connectionIDCounter++;
    this.webSockets[ws.id] = ws;
    Logger.info("[WebsocketConnectionManager] New connection with id [ " + ws.id + " ]");

    ws.on('message', (data) => {
      this._onMessage(ws, data);
    });

    ws.on('close', (err) => {
      this._onClose(ws, err);
    });

    ws.on('error', (err) => {
      this._onError(ws, err);
    });

    this._setupHeartbeat(ws);
  };

  _setupHeartbeat (ws) {
    let pongTimestamp = Date.now();
    ws._socket.on('data', (data) => {
      if (data[0] == PONG_ID) {
        pongTimestamp = Date.now();
      }
    });

    this.pingIntervals[ws.id] = setInterval(() => {
      if (Date.now() - pongTimestamp > PONG_TIMEOUT) {
        clearInterval(this.pingIntervals[ws.id]);
        if (ws && ws._socket) {
          Logger.warn('[WebsocketConnectionManager] Connection', ws.id, 'keepalive failed, cleaning it...');
          ws._socket.destroy();
        }
      }
      if (ws && ws.readyState === 1) {
        ws.ping('.', false);
      }
    }, PING_INTERVAL);
  }

  _onMessage (ws, data) {
    let message = {};

    try {
      message = JSON.parse(data);

      if (message.id === 'ping') {
        ws.sendMessage({id: 'pong'});
        return;
      }

      message.connectionId = ws.id;

      if (!ws.sessionId) {
        ws.sessionId = message.voiceBridge;
      }

      if (!ws.route) {
        ws.route = message.type;
      }

      if (!ws.role) {
        ws.role = message.role;
      }
    } catch(e) {
      Logger.error("  [WebsocketConnectionManager] JSON message parse error " + e);
      message = {};
    }

    // Test for empty or invalid JSON
    if (Object.getOwnPropertyNames(message).length !== 0) {
      this.emitter.emit(C.WEBSOCKET_MESSAGE, message);
    }
  }

  _onError (ws, err) {
    Logger.debug('[WebsocketConnectionManager] Connection error [' + ws.id + ']', err);
    let message = {
      id: 'error',
      type: ws.route,
      role: ws.role,
      voiceBridge: ws.sessionId,
      connectionId: ws.id
    }

    this.emitter.emit(C.WEBSOCKET_MESSAGE, message);

    delete this.webSockets[ws.id];
  }

  _onClose (ws, err) {
    Logger.info('[WebsocketConnectionManager] Closed connection on [' + ws.id + ']');
    let message = {
      id: 'close',
      type: ws.route,
      role: ws.role,
      voiceBridge: ws.sessionId,
      connectionId: ws.id
    }

    this.emitter.emit(C.WEBSOCKET_MESSAGE, message);

    delete this.webSockets[ws.id];
  }
}
