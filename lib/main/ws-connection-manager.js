'use strict';

const { WebSocketServer } = require('ws');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const { v4: uuidv4 } = require('uuid');
const { extractUserInfos } = require('./utils.js');
const config = require('config');
const { PrometheusAgent, SFUM_NAMES } = require('./metrics/main-metrics.js');

const LOG_PREFIX = '[WebsocketConnectionManager]';
const WS_STRICT_HEADER_PARSING = config.get('wsStrictHeaderParsing');

module.exports = class WebsocketConnectionManager {
  constructor (host, port, path, wsServerOptions) {
    this.wss = new WebSocketServer({
      host, port, path, ...wsServerOptions,
    });
    this.webSockets = new Map(); // <uuid, WebSocket>

    this.wss.on('connection', this._onNewConnection.bind(this));
    PrometheusAgent.setCollectorWithGenerator(SFUM_NAMES.WEBSOCKETS, () => {
      return this.webSockets.size;
    });
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
    const ws = this.webSockets.get(connectionId);
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
      this.webSockets.set(ws.id, ws);
      ws.userInfos = extractUserInfos(req);
      Logger.debug(LOG_PREFIX, "WS connection opened", { connectionId: ws.id });
    } catch (error) {
      if (WS_STRICT_HEADER_PARSING && error.message === 'InvalidHeaders') {
        Logger.error(LOG_PREFIX, 'Failure on WS connection startup', {
          errorMessage: error.message,
        });
        this._closeSocket(ws);
        this._onError(ws, error, 'InvalidHeaders');
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
      this._onError(ws, error, 'ServerError');
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
      PrometheusAgent.increment(SFUM_NAMES.WEBSOCKET_IN_MSGS);
      this.emitter.emit(C.CLIENT_REQ, message);
    }
  }

  _onError (ws, error, reason = 'UnknownReason') {
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
    this.webSockets.delete(ws.id);
    PrometheusAgent.increment(SFUM_NAMES.WEBSOCKET_ERRORS, { reason, code: error.code });
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
    this.webSockets.delete(ws.id);
  }

  sendMessage (ws, json) {
    if (ws._closeCode === 1000) {
      Logger.error(LOG_PREFIX, "WS is closed, won't send message", {
        connectionId: ws ? ws.id : 'unknown',
        requestId: json.id,
      });
      this._onError(ws, new Error('SendWhileClosed'), 'SendWhileClosed');
    }

    return ws.send(JSON.stringify(json), (error) => {
      if (error) {
        Logger.error(LOG_PREFIX, 'WS send failed', {
          connectionId: ws ? ws.id : 'unknown',
          errorMessage: error.message,
          requestId: json.id,
        });

        return this._onError(ws, error, 'SendFailure');
      }

      if (json.id !== 'pong') {
        PrometheusAgent.increment(SFUM_NAMES.WEBSOCKET_OUT_MSGS);
      }
    });
  }
}
