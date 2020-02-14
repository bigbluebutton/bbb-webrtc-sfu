'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/BaseProvider');
const errors = require('../base/errors');

const LOG_PREFIX = "[audio]";

const mediaFlowTimeoutDuration = config.get('mediaFlowTimeoutDuration');
const EventEmitter = require('events');

module.exports = class Audio extends BaseProvider {
  constructor(bbbGW, voiceBridge, mcs) {
    super(bbbGW);
    this.sfuApp = C.AUDIO_APP;
    this.mcs = mcs;
    this.voiceBridge = voiceBridge;
    this.sourceAudio;
    this.sourceAudioStarted = false;
    this.sourceAudioStatus = C.MEDIA_STOPPED;
    this.audioEndpoints = {};
    this.role;
    this.webRtcEndpoint = null;
    this.userId;
    this._mediaFlowingTimeouts = {};
    this.connectedUsers = {};
    this.candidatesQueue = {}
    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
  }

  onIceCandidate (_candidate, connectionId) {
    if (this.audioEndpoints[connectionId]) {
      try {
        this._flushCandidatesQueue(connectionId);
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

  async _flushCandidatesQueue (connectionId) {
    if (this.audioEndpoints[connectionId]) {
      try {
        if (this.candidatesQueue[connectionId]) {
          this.flushCandidatesQueue(this.mcs, [...this.candidatesQueue[connectionId]], this.audioEndpoints[connectionId]);
          this.candidatesQueue[connectionId] = [];
        } else {
          Logger.warn("[audio] ICE candidates could not be found for connectionId", connectionId);
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
      Logger.warn("[audio] Updating user for connectionId", connectionId, user)
    }
    Logger.debug("[audio] Added user", user, "with connectionId", connectionId);
    this.connectedUsers[connectionId] = user;
  };

/**
 * Exclude user from a hash object indexed by it's connectionId
 * @param  {String} connectionId Current connection id at the media manager
 */
  removeUser(connectionId) {
    Logger.debug("[audio] Removing user with connectionId", connectionId);
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
          this.setMediaFlowingTimeout(connectionId);
        }
        break;

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error(LOG_PREFIX, "Audio provider received MEDIA_SERVER_OFFLINE event", event);
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default: Logger.warn("[audio] Unrecognized event", event);
    }
  }

  setMediaFlowingTimeout(connectionId) {
    if (!this._mediaFlowingTimeouts[connectionId]) {
      Logger.debug("[screenshare] setMediaFlowingTimeout for listener", connectionId);
      this._mediaFlowingTimeouts[connectionId] = setTimeout(() => {
        this._onRtpMediaNotFlowing(connectionId);
      },
      mediaFlowTimeoutDuration
      );
    }
  }

  clearMediaFlowingTimeout(connectionId) {
    if (this._mediaFlowingTimeouts[connectionId]) {
      Logger.debug("[screenshare] clearMediaFlowingTimeout for listener", connectionId);
      clearTimeout(this._mediaFlowingTimeouts[connectionId]);
      delete this._mediaFlowingTimeouts[connectionId]
    }
  }

  upstartSourceAudio (descriptor, calleeName) {
    return new Promise(async (resolve, reject) => {
      Logger.info("[audio] Upstarting source audio for", this.voiceBridge);
      try {
        if (!this.sourceAudioStarted && this.sourceAudioStatus === C.MEDIA_STOPPED) {
          const isConnected = await this.mcs.waitForConnection();

          if (!isConnected) {
            return reject(errors.MEDIA_SERVER_OFFLINE);
          }

          this.userId = await this.mcs.join(this.voiceBridge, 'SFU', {});
          Logger.info(LOG_PREFIX, "MCS join for", this.connectionId, "returned", this.userId);
          const options = {
            adapter: 'Freeswitch',
            name: calleeName,
          }

          const { mediaId, answer } = await this.mcs.publish(this.userId, this.voiceBridge, C.RTP, options);

          this.mcs.onEvent(C.MEDIA_STATE, mediaId, (event) => {
            this._mediaStateRTP(event, mediaId);
          });

          this.sourceAudio = mediaId;
          this.sourceAudioStarted = true;
          this.sourceAudioStatus = C.MEDIA_STARTED;
          this.emit(C.MEDIA_STARTED);

          Logger.info("[audio] MCS publish for user", this.userId, "returned", this.sourceAudio);
          return resolve();
        }
      } catch (err) {
        Logger.error("[audio] Error on upstarting source audio", err);
        reject(err);
      }
    });
  }

  async start (sessionId, connectionId, sdpOffer, calleeName, userId, userName, callback) {
    try {
      Logger.info(LOG_PREFIX, "Starting audio instance for", { connectionId, userId, userName }, "at", sessionId, this.sourceAudioStatus, this.sourceAudioStarted);
      const isConnected = await this.mcs.waitForConnection();

      if (!isConnected) {
        throw errors.MEDIA_SERVER_OFFLINE;
      }

      // Storing the user data to be used by the pub calls
      const user = { userId, userName};
      this.addUser(connectionId, user);

      const sdpAnswer = await this._subscribeToGlobalAudio(sdpOffer, connectionId);

      return callback(null, sdpAnswer);
    }
    catch (err) {
      return callback(this._handleError(LOG_PREFIX, err, "recv", userId));
    }
  };

  _subscribeToGlobalAudio (sdpOffer, connectionId) {
    return new Promise(async (resolve, reject) => {
      try {
        const subscribe = async  () => {
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
          this._flushCandidatesQueue(connectionId);
          Logger.info(LOG_PREFIX, "MCS subscribe for user", this.userId, "returned", mediaId);
          resolve(answer);
        }

        if (this.sourceAudioStatus === C.MEDIA_STARTING || this.sourceAudioStatus === C.MEDIA_STOPPED) {
          this.once(C.MEDIA_STARTED, subscribe);
        } else if (this.sourceAudioStatus === C.MEDIA_STARTED) {
          // Call the global audio subscription routine in case the source was already started
          subscribe();
        }
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
      if (this.audioEndpoints && Object.keys(this.audioEndpoints).length === 1) {
        try {
          await this.mcs.leave(this.voiceBridge, this.userId);
        } catch (error) {
          Logger.warn(LOG_PREFIX, `Error on leave procedure for ${this.voiceBridge}, probably a glare NOT_FOUND`,
            { error, voiceBridge: this.voiceBridge });
        }

        this.sourceAudioStarted = false;
        this.sourceAudioStatus = C.MEDIA_STOPPED;
        this.emit(C.MEDIA_STOPPED, this.voiceBridge);
      } else {
        try {
          await this.mcs.unsubscribe(this.userId, listener);
        } catch (error) {
          Logger.warn(LOG_PREFIX, `Error on unsubscribe procedure for ${listener}, probably a glare NOT_FOUND`,
            { error, listener});
        }
      }

      delete this.candidatesQueue[id];
      delete this.audioEndpoints[id];

      return;
    }
  }

  async stop () {
    Logger.info(LOG_PREFIX, 'Releasing endpoints for user', this.userId, 'at room', this.voiceBridge);
    this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);

    try {
      await this.mcs.leave(this.voiceBridge, this.userId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Error on leave procedure for ${this.voiceBridge}, probably a glare NOT_FOUND`,
        { error, voiceBridge: this.voiceBridge });
    }

    try {
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
      this.sourceAudioStatus = C.MEDIA_STOPPED;

      return Promise.resolve();
    }
    catch (err) {
      return Promise.reject(this._handleError(LOG_PREFIX, err, "recv", this.userId));
    }
  };

  sendUserDisconnectedFromGlobalAudioMessage(connectionId) {
    const user = this.getUser(connectionId);
    if (user) {
      const msg = Messaging.generateUserDisconnectedFromGlobalAudioMessage(this.voiceBridge, user.userId, user.userName);
      Logger.info('[audio] Sending global audio disconnection for user', user, "with connectionId", connectionId);

      // Interoperability between transcoder messages
      switch (C.COMMON_MESSAGE_VERSION) {
        case "1.x":
          this.bbbGW.publish(msg, C.TO_BBB_MEETING_CHAN, function(error) {});
          break;
        default:
          this.bbbGW.publish(msg, C.TO_AKKA_APPS_CHAN_2x, function(error) {});
      }

      this.removeUser(connectionId);
    }
  };

  sendUserConnectedToGlobalAudioMessage(connectionId) {
    const user = this.getUser(connectionId);
    if (user) {
      const msg = Messaging.generateUserConnectedToGlobalAudioMessage(this.voiceBridge, user.userId, user.userName);
      Logger.info('[audio] Sending global audio connection for user', user, "with connectionId", connectionId);
      // Interoperability between GlobalAudio 1.x/2.x messages
      switch (C.COMMON_MESSAGE_VERSION) {
        case "1.x":
          this.bbbGW.publish(msg, C.TO_BBB_MEETING_CHAN, function(error) {});
          break;
        default:
          this.bbbGW.publish(msg, C.TO_AKKA_APPS_CHAN_2x, function(error) {});
      }
    }
  };

  _onRtpMediaFlowing(connectionId) {
    Logger.info(LOG_PREFIX, "RTP Media FLOWING for voice bridge", this.voiceBridge);
    this.clearMediaFlowingTimeout(connectionId);
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
