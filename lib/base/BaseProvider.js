"use strict";

const C = require('../bbb/messages/Constants');
const Messaging = require('../bbb/messages/Messaging');
const Logger = require('../utils/Logger');
const EventEmitter = require('events').EventEmitter;
const errors = require('../base/errors');
const config = require('config');

module.exports = class BaseProvider extends EventEmitter {
  constructor (bbbGW) {
    super();
    this.sfuApp = "base";
    this.bbbGW = bbbGW;
  }

  _handleError (logPrefix, error, role, streamId) {
    // Setting a default error in case it was unhandled
    if (error == null) {
      error = { code: 2200, reason: errors[2200] }
    }

    if (this._validateErrorMessage(error)) {
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
      Logger.error(logPrefix, `Stack trace for error ${error.code} | ${error.message} ->`,
        { errorStack: error.stack.toString() });
      error.stackWasLogged = true;
    }

    return this._assembleErrorMessage(error, role, streamId);
  }

  _assembleErrorMessage (error, role, streamId) {
    return {
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
      type = null,
      id = null,
      role = null,
      streamId = null,
      code = null,
      reason = null,
    } = error;
    return type && id && role && streamId && code && reason;
  }

  _assembleStreamName (direction, bbbUserId, bbbMeetingId) {
    return `bigbluebutton|${direction}|${this.sfuApp}|${bbbUserId}|${bbbMeetingId}`;
  }

  sendGetRecordingStatusRequestMessage(meetingId, userId) {
    let req = Messaging.generateRecordingStatusRequestMessage(meetingId, userId);

    this.bbbGW.publish(req, C.TO_AKKA_APPS);
  }

  // Target (channel) is optional
  // TODO tentatively de-duplicate it from base-manager
  sendToClient (message, target) {
    switch (process.env.SFU_IPC_MODE) {
      case 'native':
        process.send(message);
        break;
      case 'redis':
        this.bbbGW.publish(JSON.stringify(message), target);
        break;
      case 'none':
        if (global.CM_ROUTER && typeof global.CM_ROUTER.emit === 'function') {
          global.CM_ROUTER.emit(C.REDIS_MESSAGE, message);
        } else {
          Logger.error(this._logPrefix, "Can't send outbound request, router not found",
            { request: message, ipc: process.env.SFU_IPC_MODE, target });
        }
        break;
      default:
        Logger.error(this._logPrefix, "Can't send outbound request, invalid IPC mode",
          { request: message, ipc: process.env.SFU_IPC_MODE, target });
        return;
    }
  }

  probeForRecordingStatus (meetingId, userId) {
    return new Promise((resolve, reject) => {
      const onRecordingStatusReply = (payload) => {
        if (payload.requestedBy === userId) {
          Logger.info("RecordingStatusReply for userId", payload.requestedBy, "is", payload.recorded);
          this.bbbGW.removeListener(C.RECORDING_STATUS_REPLY_MESSAGE_2x+meetingId, onRecordingStatusReply)
          return resolve(payload.recorded);
        }
      };

      this.bbbGW.on(C.RECORDING_STATUS_REPLY_MESSAGE_2x+meetingId, onRecordingStatusReply)

      this.sendGetRecordingStatusRequestMessage(meetingId, userId);
    });
  }

  flushCandidatesQueue (broker, queue, mediaId = null) {
    if (mediaId) {
      Logger.trace("Flushing", queue.length, "candidates queue for", mediaId);
      queue.forEach(async (candidate) => {
        try {
          await broker.addIceCandidate(mediaId, candidate);
        } catch (e) {
          Logger.error("ICE candidate for media", mediaId, "could not be added to media controller.", e);
        }
      });
    }
  }


  getRecordingPath (room, subPath, recordingName, format) {
    const basePath = config.get('recordingBasePath');
    const timestamp = (new Date()).getTime();

    return `${basePath}/${subPath}/${room}/${recordingName}-${timestamp}.${format}`
  }

  handleMCSCoreDisconnection (error) {
    Logger.error(`[${this.sfuApp}] Provider received a MCS core disconnection event, fire a MEDIA_SERVER_OFFLINE`);
    this.emit(C.MEDIA_SERVER_OFFLINE);
  }
};
