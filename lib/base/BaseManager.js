/*
 * Lucas Fialho Zawacki
 * Paulo Renato Lanzarin
 * (C) Copyright 2017 Bigbluebutton
 *
 */

"use strict";

const config = require('config');
const BigBlueButtonGW = require('../bbb/pubsub/bbb-gw');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const errors = require('./errors');
const MCSApi = require('./MCSAPIWrapper');
const MCS_ADDRESS = config.get("mcs-address");
const MCS_PORT = config.get("mcs-port");

module.exports = class BaseManager {
  constructor (connectionChannel, additionalChannels = [], logPrefix = C.BASE_MANAGER_PREFIX) {
    this._sessions = {};
    this._bbbGW = new BigBlueButtonGW();
    this._redisGateway;
    this._connectionChannel = connectionChannel;
    this._additionalChanels = additionalChannels;
    this._logPrefix = logPrefix;
    this._iceQueues = {};
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
    }
    catch (error) {
      Logger.error(this._logPrefix, 'Could not connect to Redis channel', error);
      await this.stopAll();
      throw new Error(error);
    }
  }

  async messageFactory (handler) {
    // Entrypoint for messages to the manager (from the connection-manager/ws module
    this._redisGateway = await this._bbbGW.addSubscribeChannel(this._connectionChannel);
    this._redisGateway.on(C.REDIS_MESSAGE, handler.bind(this));
  }

  _fetchSession (sessionId) {
    return this._sessions[sessionId];
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
      while(candidate = queue.pop()) {
        session.onIceCandidate(candidate);
      }
    }
  }

  _deleteIceQueue (sessionId) {
    if (this._iceQueues[sessionId]) {
      delete this._iceQueues[sessionId];
    }
  }

  _killConnectionSessions (connectionId) {
    const keys = Object.keys(this._sessions);
    keys.forEach((sessionId) => {
      let session = this._sessions[sessionId];
      if (session && session.connectionId === connectionId) {
        this._stopSession(sessionId);
      }
    });
  }

  _stopSession (sessionId) {
    return new Promise(async (resolve, reject) => {
      try {
        if (this._sessions == null || sessionId == null) {
          return resolve();
        }

        let session = this._sessions[sessionId];
        if (session) {
          Logger.info(this._logPrefix, `Stopping session ${sessionId}`);
          if (typeof session.stop === 'function') {
            await session.stop();
          }
          delete this._sessions[sessionId];
          this._logAvailableSessions();
          return resolve();
        }

        return resolve();
      }
      catch (err) {
        Logger.error(err);
        return resolve();
      }
    });
  }

  stopAll() {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info(this._logPrefix, 'Stopping everything! ');
        if (this._sessions == null) {
          return resolve;
        }

        let sessionIds = Object.keys(this._sessions);
        let stopProcedures = [];

        for (let i = 0; i < sessionIds.length; i++) {
          stopProcedures.push(this._stopSession(sessionIds[i]));
        }
        resolve(Promise.all(stopProcedures));
      }
      catch (err) {
        Logger.error(error);
        resolve();
      }
    });
  }

  _logAvailableSessions () {
    if(this._sessions) {
      let sessionMainKeys = Object.keys(this._sessions);
      let logInfo = this._logPrefix + 'There are ' + sessionMainKeys.length + ' sessions available =>\n';
      for (var k in this._sessions) {
        if(this._sessions[k]) {
          logInfo += '(Session[' +  k +']' + ' of type ' + this._sessions[k].constructor.name + ');\n';
        }
      }
      Logger.debug(logInfo);
    }
  }

  _handleError (logPrefix, connectionId, streamId, role, error) {
    Logger.trace(logPrefix, error);

    // Setting a default error in case it was unhandled
    if (error == null) {
      error = { code: 2200, reason: errors[2200] }
    }

    if (error && this._validateErrorMessage(error)) {
      return error;
    }

    const { code } = error;
    const reason = errors[code];

    if (reason == null) {
      return;
    }

    error.message = reason;

    Logger.debug(logPrefix, "Handling error", error.code, error.message);

    return this._assembleErrorMessage(error, role, streamId, connectionId);
  }

  _assembleErrorMessage (error, role, streamId, connectionId) {
    return {
      connectionId,
      type: this.sfuApp,
      id: 'error',
      role,
      streamId,
      code: error.code,
      reason: error.message,
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

};
