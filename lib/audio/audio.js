'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/BaseProvider');
const LOG_PREFIX = "[audio]";

module.exports = class Audio extends BaseProvider {
  constructor(_bbbGW, connectionId, meetingId, voiceBridge, mcs) {
    super();
    this.sfuApp = C.AUDIO_APP;
    this.mcs = mcs;
    this.bbbGW = _bbbGW;
    this.connectionId = connectionId;
    this.meetingId = meetingId;
    this.voiceBridge = voiceBridge;
    this.sourceAudio;
    this.sourceAudioStarted = false;
    this.audioEndpoints = {};
    this.role;
    this.webRtcEndpoint = null;
    this.userId;

    this.connectedUsers = {};
    this.candidatesQueue = {}
  }

  onIceCandidate (_candidate, connectionId) {
    if (this.audioEndpoints[connectionId]) {
      try {
        this.flushCandidatesQueue(connectionId);
        this.mcs.addIceCandidate(this.audioEndpoints[connectionId], _candidate);
      }
      catch (err)   {
        const userId = this.getUser(connectionId);
        this._handleError(LOG_PREFIX, err, "recv", userId);
      }
    }
    else {
      if(!this.candidatesQueue[connectionId]) {
        this.candidatesQueue[connectionId] = [];
      }
      this.candidatesQueue[connectionId].push(_candidate);
    }
  };

  flushCandidatesQueue (connectionId) {
    if (this.audioEndpoints[connectionId]) {
      try {
        if (this.candidatesQueue[connectionId]) {
          while(this.candidatesQueue[connectionId].length) {
            const candidate = this.candidatesQueue[connectionId].shift();
            this.mcs.addIceCandidate(this.audioEndpoints[connectionId], candidate);
          }
        }
      }
      catch (err) {
        const userId = this.getUser(connectionId);
        this._handleError(LOG_PREFIX, err, "recv", userId);
        Logger.error(LOG_PREFIX, "ICE candidate could not be added to media controller.", err);
      }
    }
  }

/**
 * Include user to a hash object indexed by it's connectionId
 * @param  {String} connectionId Current connection id at the media manager
 * @param  {Object} user {userId: String, userName: String}
 */
  addUser(connectionId, user) {
    if (this.connectedUsers.hasOwnProperty(connectionId)) {
      Logger.warn(LOG_PREFIX, "Updating user for connectionId", connectionId)
    }
    this.connectedUsers[connectionId] = user;
  };

/**
 * Exclude user from a hash object indexed by it's connectionId
 * @param  {String} connectionId Current connection id at the media manager
 */
  removeUser(connectionId) {
    if (this.connectedUsers.hasOwnProperty(connectionId)) {
      delete this.connectedUsers[connectionId];
    } else {
      Logger.error(LOG_PREFIX, "Missing connectionId", connectionId);
    }
  };

/**
 * Consult user from a hash object indexed by it's connectionId
 * @param  {String} connectionId Current connection id at the media manager
 * @return  {Object} user {userId: String, userName: String}
 */
  getUser(connectionId) {
    if (this.connectedUsers.hasOwnProperty(connectionId)) {
      return this.connectedUsers[connectionId];
    } else {
      Logger.error(LOG_PREFIX, "Missing connectionId", connectionId);
    }
  };

  /**
  * Consult connectionId from a hash object composed by users {userId: String, userName: String}
  * @param  {String} userId user id of a specific user at the media manager
  * @return  {String} connectionId
  */
   getConnectionId(userId) {
     for (var key in this.connectedUsers) {
       if (this.connectedUsers.hasOwnProperty(key)) {
         let user = this.connectedUsers[key]
         if (user.hasOwnProperty('userId') && user['userId'] === userId) {
           return key;
         }
       }
     }
     Logger.error("[audio] Missing connection for userId", userId);
   };

  _mediaStateRTP (event, endpoint) {
    const { mediaId, state } = event;
    const { name, details = null } = state;

    if (mediaId !== endpoint) {
      return;
    }

    switch (name) {
      case "MediaStateChanged":
        break;

      case "MediaFlowOutStateChange":
        Logger.info(LOG_PREFIX, "Session with media", mediaId, "received state", state);
        break;

      case "MediaFlowInStateChange":
        Logger.info(LOG_PREFIX, "Session with media", mediaId, "received state", state);
        break;

      default: Logger.warn(LOG_PREFIX, "Unrecognized event", event);
    }
  }

  _onMCSIceCandidate (event, endpoint, connectionId) {
    const { mediaId, candidate } = event;

    if (mediaId !== endpoint) {
      return;
    }

    Logger.debug(LOG_PREFIX, 'Received ICE candidate from mcs-core for media session', mediaId, '=>', candidate, "for connection", connectionId);

    this.bbbGW.publish(JSON.stringify({
      connectionId,
      id : 'iceCandidate',
      type: 'audio',
      cameraId: this._id,
      candidate : candidate
    }), C.FROM_AUDIO);
  }

  _mediaStateWebRTC (event, endpoint, connectionId) {
    const { mediaId , state } = event;
    const { name, details } = state;

    if (mediaId !== endpoint) {
      return;
    }

    switch (name) {
      case "MediaStateChanged":
        break;

      case "MediaFlowOutStateChange":
        Logger.info(LOG_PREFIX, "Session with media", mediaId, "received state", state);
        break;

      case "MediaFlowInStateChange":
        Logger.info(LOG_PREFIX, "Session with media", mediaId, "received state", state);
        if (details === 'FLOWING') {
          this._onRtpMediaFlowing(connectionId);
        } else {
          this._onRtpMediaNotFlowing(connectionId);
        }
        break;

      default: Logger.warn(LOG_PREFIX, "Unrecognized event", event);
    }
  }

  async start (sessionId, connectionId, sdpOffer, caleeName, userId, userName, callback) {
    Logger.info(LOG_PREFIX, "Starting audio instance for", this.connectionId);
    // Storing the user data to be used by the pub calls
    const user = { userId, userName};
    this.addUser(connectionId, user);

    try {
      if (!this.sourceAudioStarted) {
        await this._upstartGlobalAudio(sdpOffer, caleeName);
      }

      const sdpAnswer = await this._subscribeToGlobalAudio(sdpOffer, connectionId);

      return callback(null, sdpAnswer);
    }
    catch (err) {
      return callback(this._handleError(LOG_PREFIX, err, "recv", userId));
    }
  };

  _upstartGlobalAudio (sdpOffer, caleeName) {
    return new Promise(async (resolve, reject) => {
      try {
        this.userId = await this.mcs.join(this.voiceBridge, 'SFU', {});
        Logger.info(LOG_PREFIX, "MCS join for", this.connectionId, "returned", this.userId);
        const options = {
          adapter: 'Freeswitch',
          name: caleeName,
        }

        const { mediaId, answer } = await this.mcs.publish(this.userId, this.voiceBridge, C.RTP, options);

        this.mcs.onEvent(C.MEDIA_STATE, mediaId, (event) => {
          this._mediaStateRTP(event, mediaId);
        });

        this.sourceAudio = mediaId;
        this.sourceAudioStarted = true;
        Logger.info(LOG_PREFIX, "MCS publish for user", this.userId, "returned", this.sourceAudio);
        resolve(answer);
      } catch (err) {
        reject(this._handleError(LOG_PREFIX, err, "recv", this.userId));
      }
    });
  }

  _subscribeToGlobalAudio (sdpOffer, connectionId) {
    return new Promise(async (resolve, reject) => {
      try {
        const { userId } = this.getUser(connectionId);
        const options = {
          descriptor: sdpOffer,
          adapter: 'Kurento',
          name: this._assembleStreamName('subscribe', userId, this.meetingId),
        }

        const { mediaId, answer } = await this.mcs.subscribe(this.userId,
          this.sourceAudio, C.WEBRTC, options);

        this.mcs.onEvent(C.MEDIA_STATE, mediaId, (event) => {
          this._mediaStateWebRTC(event, mediaId, connectionId);
        });

        this.mcs.onEvent(C.MEDIA_STATE_ICE, mediaId, (event) => {
          this._onMCSIceCandidate(event, mediaId, connectionId);
        });

        this.audioEndpoints[connectionId] = mediaId;
        this.flushCandidatesQueue(connectionId);
        Logger.info(LOG_PREFIX, "MCS subscribe for user", this.userId, "returned", mediaId);

        resolve(answer);
      } catch (err) {
        reject(this._handleError(LOG_PREFIX, err, "recv", this.userId));
      }
    });
  }

  async stopListener(id) {
    const listener = this.audioEndpoints[id];
    const userId = this.getUser(id);
    Logger.info(LOG_PREFIX, 'Releasing endpoints for', listener);

    this.sendUserDisconnectedFromGlobalAudioMessage(id);

    if (listener) {
      try {
        if (this.audioEndpoints && Object.keys(this.audioEndpoints).length === 1) {
          await this.mcs.leave(this.voiceBridge, this.userId);
          this.sourceAudioStarted = false;
        }
        else {
          await this.mcs.unsubscribe(this.userId, listener);
        }

        delete this.candidatesQueue[id];
        delete this.audioEndpoints[id];

        return;
      }
      catch (err) {
        this._handleError(LOG_PREFIX, err, "recv", userId);
        return;
      }
    }
  }

  async stop () {
    Logger.info(LOG_PREFIX, 'Releasing endpoints for user', this.userId, 'at room', this.voiceBridge);

    try {
      await this.mcs.leave(this.voiceBridge, this.userId);

      for (var listener in this.audioEndpoints) {
        delete this.audioEndpoints[listener];
      }

      for (var queue in this.candidatesQueue) {
        delete this.candidatesQueue[queue];
      }

      for (var connection in this.connectedUsers) {
        this.sendUserDisconnectedFromGlobalAudioMessage(connection);
      }

      this.sourceAudioStarted = false;

      return Promise.resolve();
    }
    catch (err) {
      return Promise.reject(this._handleError(LOG_PREFIX, err, "recv", this.userId));
    }
  };

  sendUserDisconnectedFromGlobalAudioMessage(connectionId) {
    let user = this.getUser(connectionId);
    let msg = Messaging.generateUserDisconnectedFromGlobalAudioMessage(this.voiceBridge, user.userId, user.userName);
    Logger.info(LOG_PREFIX, 'Sending global audio disconnection for user', user);

    // Interoperability between transcoder messages
    switch (C.COMMON_MESSAGE_VERSION) {
      case "1.x":
        this.bbbGW.publish(msg, C.TO_BBB_MEETING_CHAN, function(error) {});
        break;
      default:
        this.bbbGW.publish(msg, C.TO_AKKA_APPS_CHAN_2x, function(error) {});
    }

    this.removeUser(connectionId);
  };

  sendUserConnectedToGlobalAudioMessage(connectionId) {
    let user = this.getUser(connectionId);
    let msg = Messaging.generateUserConnectedToGlobalAudioMessage(this.voiceBridge, user.userId, user.userName);
    Logger.info(LOG_PREFIX, 'Sending global audio connection for user', user);

    // Interoperability between transcoder messages
    switch (C.COMMON_MESSAGE_VERSION) {
      case "1.x":
        this.bbbGW.publish(msg, C.TO_BBB_MEETING_CHAN, function(error) {});
        break;
      default:
        this.bbbGW.publish(msg, C.TO_AKKA_APPS_CHAN_2x, function(error) {});
    }
  };

  _onRtpMediaFlowing(connectionId) {
    Logger.info(LOG_PREFIX, "RTP Media FLOWING for voice bridge", this.voiceBridge);
    this.sendUserConnectedToGlobalAudioMessage(connectionId);
    this.bbbGW.publish(JSON.stringify({
        connectionId: connectionId,
        id: "webRTCAudioSuccess",
        success: "MEDIA_FLOWING"
    }), C.FROM_AUDIO);
  };

  _onRtpMediaNotFlowing(connectionId) {
    Logger.warn(LOG_PREFIX, "RTP Media NOT FLOWING for voice bridge" + this.voiceBridge);
    this.bbbGW.publish(JSON.stringify({
        connectionId: connectionId,
        id: "webRTCAudioError",
        error: C.MEDIA_ERROR
    }), C.FROM_AUDIO);
    this.removeUser(connectionId);
  };
};
