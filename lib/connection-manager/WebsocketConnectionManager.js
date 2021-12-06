'use strict';

const ws = require('ws');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const { v4: uuidv4 } = require('uuid');
const { extractUserInfos } = require('./utils.js');
const config = require('config');


const LOG_PREFIX = '[WebsocketConnectionManager]';
const WS_STRICT_HEADER_PARSING = config.get('wsStrictHeaderParsing');

module.exports = class WebsocketConnectionManager {
  constructor (server, path) {
    this.wss = new ws.Server({
      server,
      path
    });

    this.webSockets = {};

    this.wss.on('connection', this._onNewConnection.bind(this));
  }

  setEventEmitter (emitter) {
    this.emitter = emitter;
    this.emitter.on('response', this._onServerResponse.bind(this));
  }

  _closeSocket (ws) {
    try {
      ws.close();
    } catch (error) {
      Logger.error(LOG_PREFIX, 'WS close failed', {
        connectionId: ws.id,
        errorMessage: error.message,
        errorCode: error.code
      });
    }
  }

  _onServerResponse (data) {
    const connectionId = data ? data.connectionId : null;
    const ws = this.webSockets[connectionId];
    if (ws) {
      if (data.id === 'close') {
        this._closeSocket(ws);
      } else {
        // Strip connectionId from the outbound message. Should save some bytes
        if (data.connectionId) data.connectionId = undefined;
        this.sendMessage(ws, data);
      }
    }
  }

  _onNewConnection (ws, req) {
    try {
      ws.id = uuidv4();
      this.webSockets[ws.id] = ws;
      ws.userInfos = extractUserInfos(req);
      Logger.debug(LOG_PREFIX, "WS connection opened", { connectionId: ws.id });
    } catch (error) {
      if (WS_STRICT_HEADER_PARSING) {
        Logger.debug(LOG_PREFIX, 'Failure on WS connection startup', {
          errorMessage: error.message,
        });
        this._closeSocket(ws);
        this._onError(ws, error);
        return;
      }
    }

    ws.on('message', (data) => {
      this._onMessage(ws, data);
    });

    ws.on('close', (error) => {
      this._onClose(ws, error);
    });

    ws.on('error', (error) => {
      this._onError(ws, error);
    });
  }

  _onMessage (ws, data) {
    let message = {};

    try {
      message = JSON.parse(data);

      switch (message.id) {
        case 'ping':
          return this.sendMessage(ws, { id: 'pong' });
        case 'close':
          return;
        default: {
          message.connectionId = ws.id;
          message.sfuUserHeader = ws.userInfos;

          if (!ws.sessionId) {
            ws.sessionId = message.voiceBridge;
          }
          if (!ws.route) {
            ws.route = message.type;
          }
          if (!ws.role) {
            ws.role = message.role;
          }
        }
      }
    } catch(error) {
      Logger.error(LOG_PREFIX, "JSON message parse failed", {
        errorMessage: error.message, errorCode: error.code
      });
      message = {};
    }

    // Test for empty or invalid JSON
    // FIXME yuck, maybe this should be reviewed. - prlanzarin
    if (Object.getOwnPropertyNames(message).length !== 0) {
      this.emitter.emit(C.CLIENT_REQ, message);
    }
  }

  _onError (ws, error) {
    Logger.debug(LOG_PREFIX, "WS error event", {
      connectionId: ws.id || 'unknown',
      errorMessage: error.message,
      errorCode: error.code
    });

    const message = {
      id: 'error',
      type: ws.route,
      role: ws.role,
      voiceBridge: ws.sessionId,
      connectionId: ws.id,
      sfuUserHeader: ws.userInfos,
    }

    this.emitter.emit(C.CLIENT_REQ, message);

    delete this.webSockets[ws.id];
  }

  _onClose (ws) {
    Logger.debug(LOG_PREFIX, "WS connection closed", { connectionId: ws.id });

    const message = {
      id: 'close',
      type: ws.route,
      role: ws.role,
      voiceBridge: ws.sessionId,
      connectionId: ws.id,
      sfuUserHeader: ws.userInfos,
    }

    this.emitter.emit(C.CLIENT_REQ, message);

    delete this.webSockets[ws.id];
  }

  sendMessage (ws, json) {
    if (ws._closeCode === 1000) {
      Logger.error(LOG_PREFIX, "WS is closed, won't send message", {
        connectionId: ws ? ws.id : 'unknown',
        requestId: json.id,
      });
      this._onError(ws, new Error('WS closed'));
    }

    return ws.send(JSON.stringify(json), (error) => {
      if (error) {
        Logger.error(LOG_PREFIX, 'WS send failed', {
          connectionId: ws ? ws.id : 'unknown',
          errorMessage: error.message,
          requestId: json.id,
        });

        return this._onError(ws, error);
      }
    });
  }
}
