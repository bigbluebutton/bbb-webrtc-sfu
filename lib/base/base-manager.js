/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

"use strict";

const QueueD = require('queue');
const config = require('config');
const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const C = require('../bbb/messages/Constants');
const Logger = require('../common/logger.js');
const errors = require('./errors');
const MCSApi = require('./MCSAPIWrapper');
const MCS_ADDRESS = config.get("mcs-address");
const MCS_PORT = config.get("mcs-port");
const REQUEST_QUEUE_TIMEOUT = config.has('requestQueueTimeout')
  ? config.get('requestQueueTimeout')
  : 15000;

module.exports = class BaseManager {
  constructor (connectionChannel, additionalChannels = [], logPrefix = C.BASE_MANAGER_PREFIX) {
    this._sessions = {};
    this._bbbGW = new BigBlueButtonGW();
    this._mainInboundGateway;
    this._connectionChannel = connectionChannel;
    this._additionalChanels = additionalChannels;
    this._logPrefix = logPrefix;
    this._iceQueues = {};
    this._lifecycleQueues = {};
    this.mcs = new MCSApi();
    this.mcsStarted = false;
  }

  async start() {
    try {
      // Additional channels that this manager is going to use
      this._additionalChanels.forEach((channel) => {
        this._bbbGW.addSubscribeChannel(channel);
      });

      if (!this.mcsStarted) {
        await this.mcs.start(MCS_ADDRESS, MCS_PORT);
        this.mcsStarted = true;
      }
    } catch (error) {
      Logger.error('Manager: cannot connect to Redis channel', {
        errorMessage: error.message,
      });
      await this.stop();
      throw new Error(error);
    }
  }

  async messageFactory (handler) {
    // Entrypoint for messages to the manager (from the connection-manager/ws module)
    switch (process.env.SFU_IPC_MODE) {
      case 'native':
        process.on('message', handler);
        break;
      case 'redis':
        this._mainInboundGateway = await this._bbbGW.addSubscribeChannel(this._connectionChannel);
        this._mainInboundGateway.on(C.REDIS_MESSAGE, handler);
        break;
      case 'none':
        global.CM_ROUTER.on(process.env.SFU_MODULE_NAME, handler);
        break;
      default:
        return;
    }
  }

  // Target (channel) is optional
  // TODO tentatively de-duplicate it from base-provider
  sendToClient (message, target) {
    switch (process.env.SFU_IPC_MODE) {
      case 'native':
        process.send(message);
        break;
      case 'redis':
        this._bbbGW.publish(JSON.stringify(message), target);
        break;
      case 'none':
        if (global.CM_ROUTER && typeof global.CM_ROUTER.emit === 'function') {
          global.CM_ROUTER.emit(C.REDIS_MESSAGE, message);
        } else {
          Logger.error("Manager: can't send outbound request, router not found",
            { request: message, ipc: process.env.SFU_IPC_MODE, target });
        }
        break;
      default:
        Logger.error("Manager: can't send outbound request, invalid IPC mode",
          { request: message, ipc: process.env.SFU_IPC_MODE, target });
        return;
    }
  }

  explodeUserInfoHeader (message) {
    if (typeof message === 'object' &&  typeof message.sfuUserHeader === 'object') {
      if (typeof message.sfuUserHeader.userId === 'string'
        && typeof message.sfuUserHeader.voiceBridge === 'string'
        && typeof message.sfuUserHeader.meetingId === 'string'
      ) {
        message.userId = message.sfuUserHeader.userId;
        message.voiceBridge = message.sfuUserHeader.voiceBridge;
        message.meetingId = message.sfuUserHeader.meetingId;

        return message;
      }
    }

    throw errors.SFU_INVALID_REQUEST;
  }

  _fetchSession (sessionId) {
    return this._sessions[sessionId];
  }

  _fetchLifecycleQueue (id, concurrency = 1) {
    if (this._lifecycleQueues[id] == null) {
      const newQueue = QueueD({
        concurrency,
        timeout: REQUEST_QUEUE_TIMEOUT,
        autostart: true
      });

      this._lifecycleQueues[id] = newQueue;
      this._lifecycleQueues[id].on('end', () => {
        if (this._lifecycleQueues[id].length <= 0) {
          this._deleteLifecycleQueue(id);
        }
      });
    }

    return this._lifecycleQueues[id];
  }

  _deleteLifecycleQueue (id) {
    if (!!this._lifecycleQueues[id] && this._lifecycleQueues[id].length <= 0) {
        this._lifecycleQueues[id].removeAllListeners('end');
        delete this._lifecycleQueues[id];
    }
  }

  _fetchIceQueue (sessionId) {
    if (this._iceQueues[sessionId] == null) {
      this._iceQueues[sessionId] = [];
    }

    return this._iceQueues[sessionId] ;
  }

  _flushIceQueue (session, queue) {
    if (queue) {
      let candidate;
      while((candidate = queue.pop())) {
        session.onIceCandidate(candidate);
      }
    }
  }

  _deleteIceQueue (sessionId) {
    if (this._iceQueues[sessionId]) {
      delete this._iceQueues[sessionId];
    }
  }

  _stopSession (sessionId) {
    try {
      if (this._sessions == null || sessionId == null) {
        return Promise.resolve();
      }

      const session = this._sessions[sessionId];
      if (session) {
        Logger.debug(`Manager: stopping session ${sessionId}`);
        delete this._sessions[sessionId];

        if (typeof session.stop === 'function') {
          return session.stop().catch((error) => {
            Logger.error('CRITICAL: stop session failure', {
              errorMessage: error.message, error,
            });
          });
        }
      }

      return Promise.resolve();
    } catch (error) {
      Logger.error('CRITICAL: stop session failure', {
        errorMessage: error.message, error,
      });
    }
  }

  stop () {
    try {
      Logger.info('Stopping everything!');

      const sessionIds = Object.keys(this._sessions);
      const stopProcedures = [];

      for (let i = 0; i < sessionIds.length; i++) {
        stopProcedures.push(this._stopSession(sessionIds[i]));
      }

      return Promise.all(stopProcedures);
    } catch (error) {
      Logger.error('CRITICAL: stop all sessions failure', {
        errorMessage: error.message, error,
      });
      throw error;
    }
  }

  _handleError (logPrefix, connectionId, streamId, role, error) {
    // Setting a default error in case it was unhandled
    if (error == null) {
      error = { code: 2200, reason: errors[2200] }
    }

    if (error && this._validateErrorMessage(error)) {
      return error;
    }

    if (error.code == null) {
      error.code = 2200;
    }

    const { code } = error;
    const reason = errors[code];

    error.rawMessage = error.message;
    error.message = reason || error.message;

    const { stack } = error;
    if (stack && !error.stackWasLogged)  {
      Logger.error(`Stack trace for error ${error.code} | ${error.message} ->`,
        { errorStack: error.stack.toString() });
      error.stackWasLogged = true;
    }

    return this._assembleErrorMessage(error, role, streamId, connectionId);
  }

  _assembleErrorMessage (error, role, streamId, connectionId) {
    return {
      connectionId,
      type: this.sfuApp,
      id: 'error',
      role,
      streamId: streamId || undefined,
      code: error.code,
      message: error.message,
      reason: error.message,
      rawMessage: error.rawMessage || undefined,
    };
  }

  _validateErrorMessage (error) {
    const {
      connectionId = null,
      type = null,
      id = null,
      role = null,
      streamId = null,
      code = null,
      reason = null,
    } = error;
    return connectionId && type && id && role && streamId && code && reason;
  }
}
