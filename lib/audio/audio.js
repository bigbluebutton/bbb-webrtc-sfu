'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/BaseProvider');
const LOG_PREFIX = "[audio]";

const mediaFlowTimeoutDuration = config.get('mediaFlowTimeoutDuration');
const EventEmitter = require('events');

module.exports = class Audio extends BaseProvider {
  constructor(bbbGW, voiceBridge, mcs, meetingId) {
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
    this.meetingId = meetingId;
  }

  _getPartialLogMetadata () {
    return {
      roomId: this.voiceBridge,
      internalMeetingId: this.meetingId,
      status: this.sourceAudioStatus,
    };
  }

  _getFullLogMetadata (connectionId) {
    const { userId, userName } = this.getUser(connectionId, true) || {};
    const mediaId = this.audioEndpoints[connectionId]
    return {
      userId: userId,
      userName: userName,
      roomId: this.voiceBridge,
      internalMeetingId: this.meetingId,
      mediaId,
      status: this.sourceAudioStatus,
      connectionId,
    };
  }

  /* ======= ICE HANDLERS ======= */

  onIceCandidate (_candidate, connectionId) {
    if (this.audioEndpoints[connectionId]) {
      try {
        this._flushCandidatesQueue(connectionId);
        this.mcs.addIceCandidate(this.audioEndpoints[connectionId], _candidate);
      }
      catch (error)   {
        const userId = this.getUser(connectionId);
        Logger.error(LOG_PREFIX, "ICE candidate could not be added to media controller.",
          { ...this._getFullLogMetadata(connectionId), error });
        this._handleError(LOG_PREFIX, error, "recv", userId);
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
          Logger.warn(LOG_PREFIX, `ICE candidates could not be found for connectionId. ${connectionId}`,
            this._getFullLogMetadata(connectionId));
        }
      }
      catch (error) {
        const userId = this.getUser(connectionId);
        Logger.error(LOG_PREFIX, "ICE candidate could not be added to media controller.",
          { ...this._getFullLogMetadata(connectionId), error });
      }
    }
  }

  /* ======= USER STATE MANAGEMENT ======= */

  /**
   * Include user to a hash object indexed by it's connectionId
   * @param  {String} connectionId Current connection id at the media manager
   * @param  {Object} user {userId: String, userName: String}
   */
  addUser(connectionId, user) {
    if (this.connectedUsers.hasOwnProperty(connectionId)) {
      Logger.warn(LOG_PREFIX, `Updating user for connectionId ${connectionId}`,
        this._getFullLogMetadata(connectionId));
    }
    this.connectedUsers[connectionId] = user;
    Logger.debug(LOG_PREFIX, `Added user with connectionId ${connectionId}`,
      this._getFullLogMetadata(connectionId));
  };

/**
 * Exclude user from a hash object indexed by it's connectionId
 * @param  {String} connectionId Current connection id at the media manager
 */
  removeUser(connectionId) {
    Logger.debug(LOG_PREFIX, `Removing user with connectionId ${connectionId}`,
      this._getFullLogMetadata(connectionId));
    if (this.connectedUsers.hasOwnProperty(connectionId)) {
      delete this.connectedUsers[connectionId];
    } else {
      Logger.error(LOG_PREFIX, `User not found on remove for connectionId ${connectionId}`,
        this._getPartialLogMetadata());
    }
  };

/**
 * Consult user from a hash object indexed by it's connectionId
 * @param  {String} connectionId Current connection id at the media manager
 * @return  {Object} user {userId: String, userName: String}
 */
  getUser (connectionId, suppressLog = false) {
    if (this.connectedUsers.hasOwnProperty(connectionId)) {
      return this.connectedUsers[connectionId];
    } else {
      if (!suppressLog) {
        Logger.error(LOG_PREFIX, `User not found on getUser for connectionId ${connectionId}`,
          this._getPartialLogMetadata());
      }

      return {};
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
     Logger.error(LOG_PREFIX, `User not found on getConnectionId for userId ${userId}`,
      this._getPartialLogMetadata());
   };

  /* ======= MEDIA STATE HANDLERS ======= */

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
        Logger.info(LOG_PREFIX, `RTP source relay session ${mediaId} received MediaFlowOut`,
          { ...this._getPartialLogMetadata(), userId: this.userId, mediaId, state });
        break;

      case "MediaFlowInStateChange":
        Logger.info(LOG_PREFIX, `RTP source relay session ${mediaId} received MediaFlowIn`,
          { ...this._getPartialLogMetadata(), userId: this.userId, mediaId, state });
        break;

      default: Logger.warn(LOG_PREFIX, "Unrecognized event", event);
    }
  }

  _onMCSIceCandidate (event, endpoint, connectionId) {
    const { mediaId, candidate } = event;

    if (mediaId !== endpoint) {
      return;
    }

    Logger.debug(LOG_PREFIX, `Received ICE candidate from mcs-core`,
      { ...this._getFullLogMetadata(connectionId), candidate });

    this.bbbGW.publish(JSON.stringify({
      connectionId,
      id : 'iceCandidate',
      type: 'audio',
      cameraId: this._id,
      candidate : candidate
    }), C.FROM_AUDIO);
  }

  _onListenOnlySubscriberMediaFlowing (connectionId) {
    Logger.info(LOG_PREFIX, `Listen only session WebRTC media is FLOWING`,
      this._getFullLogMetadata(connectionId));
    this.clearMediaFlowingTimeout(connectionId);
    this.sendUserConnectedToGlobalAudioMessage(connectionId);
    this.bbbGW.publish(JSON.stringify({
        connectionId: connectionId,
        id: "webRTCAudioSuccess",
        success: "MEDIA_FLOWING"
    }), C.FROM_AUDIO);
  };

  _onListenOnlySubscriberMediaNotFlowing (connectionId) {
    Logger.warn(LOG_PREFIX, `Listen only session WebRTC media is NOT_FLOWING`,
      this._getFullLogMetadata(connectionId));
    this.bbbGW.publish(JSON.stringify({
        connectionId: connectionId,
        id: "webRTCAudioError",
        error: C.MEDIA_ERROR
    }), C.FROM_AUDIO);
    this.removeUser(connectionId);
  };

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
        Logger.debug(LOG_PREFIX, `WebRTC listen only session ${mediaId} received MediaFlowOut`,
          { ...this._getFullLogMetadata(connectionId), state });
        break;

      case "MediaFlowInStateChange":
        Logger.debug(LOG_PREFIX, `WebRTC listen only session ${mediaId} received MediaFlowIn`,
          { ...this._getFullLogMetadata(connectionId), state });
        if (details === 'FLOWING') {
          this._onListenOnlySubscriberMediaFlowing(connectionId);
        } else {
          this.setMediaFlowingTimeout(connectionId);
        }
        break;

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error(LOG_PREFIX, `WebRTC listen only session ${mediaId} received MEDIA_SERVER_OFFLINE event`,
          { ...this._getFullLogMetadata(connectionId), event });
        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default: Logger.warn(LOG_PREFIX, `Unrecognized event`, { event });
    }
  }

  setMediaFlowingTimeout(connectionId) {
    if (!this._mediaFlowingTimeouts[connectionId]) {
      Logger.debug(LOG_PREFIX, `setMediaFlowingTimeout for listener ${connectionId}`,
        this._getFullLogMetadata(connectionId));
      this._mediaFlowingTimeouts[connectionId] = setTimeout(() => {
        this._onListenOnlySubscriberMediaFlowing(connectionId);
      }, mediaFlowTimeoutDuration);
    }
  }

  clearMediaFlowingTimeout(connectionId) {
    if (this._mediaFlowingTimeouts[connectionId]) {
      Logger.debug(LOG_PREFIX, `clearMediaFlowingTimeout for listener ${connectionId}`,
        this._getFullLogMetadata(connectionId));
      clearTimeout(this._mediaFlowingTimeouts[connectionId]);
      delete this._mediaFlowingTimeouts[connectionId]
    }
  }

  /* ======= START/CONNECTION METHODS ======= */

  upstartSourceAudio (descriptor, calleeName) {
    return new Promise(async (resolve, reject) => {
      Logger.info(LOG_PREFIX,  `Starting RTP source audio/GLOBAL_AUDIO for ${this.voiceBridge}`,
        this._getPartialLogMetadata());
      try {
        if (!this.sourceAudioStarted && this.sourceAudioStatus === C.MEDIA_STOPPED) {
          this.userId = await this.mcs.join(this.voiceBridge, 'SFU', { name: calleeName });
          Logger.info(LOG_PREFIX, `MCS join for PROXY_${calleeName} returned ${this.userId}`,
            { ...this._getPartialLogMetadata(), userId: this.userId });
          const globalAudioOptions = {
            adapter: 'Freeswitch',
            name: calleeName,
            ignoreThresholds: true,
          }

          // Publish with server acting as offeree. Answer is here is actually the
          // offeree descriptor which will be processed by a relay RTP endpoint
          const { mediaId, answer } = await this.mcs.publish(
            this.userId,
            this.voiceBridge,
            C.RTP,
            globalAudioOptions
          );

          // Subscribe to the GLOBAL_AUDIO endpoint created above. This will
          // act as the RTP relay which will generate the answer descripto for
          // the endpoint published above
          const proxyOptions = {
            adapter: 'Kurento',
            descriptor: answer,
            name: `PROXY_${calleeName}|subscribe`,
            ignoreThresholds: true,
          }

          const { mediaId: proxyId, answer: proxyAnswer } = await this.mcs.subscribe(
            this.userId,
            mediaId,
            C.RTP,
            proxyOptions
          );

          this.mcs.onEvent(C.MEDIA_STATE, proxyId, (event) => {
            this._mediaStateRTP(event, proxyId);
          });

          // Renegotiate the source endpoint passing the answer generated by the
          // relay RTP
          await this.mcs.publish(
            this.userId,
            this.voiceBridge,
            C.RTP,
            { ...globalAudioOptions, mediaId, descriptor: proxyAnswer }
          );

          this.sourceAudio = proxyId;
          this.sourceAudioStarted = true;
          this.sourceAudioStatus = C.MEDIA_STARTED;
          this.emit(C.MEDIA_STARTED);

          Logger.info(LOG_PREFIX, `Listen only source RTP relay sucessfully created`,
            { ...this._getPartialLogMetadata(), mediaId: this.sourceAudio, userId: this.userId });
          return resolve();
        }
      } catch (error) {
        Logger.error(LOG_PREFIX, `Error on starting listen only source RTP relay`,
          { ...this._getPartialLogMetadata(), error });
        reject(error);
      }
    });
  }

  async start (sessionId, connectionId, sdpOffer, calleeName, userId, userName, callback) {
    try {
      const mcsUserId = await this.mcs.join(this.voiceBridge, 'SFU', { userId, name: userName });
      // Storing the user data to be used by the pub calls
      const user = { userId, userName, mcsUserId };
      this.addUser(connectionId, user);
      Logger.info(LOG_PREFIX, `Starting new listen only session`,
        this._getFullLogMetadata(connectionId));
      const sdpAnswer = await this._subscribeToGlobalAudio(sdpOffer, connectionId);
      return callback(null, sdpAnswer);
    }
    catch (error) {
      Logger.error(LOG_PREFIX, `Error on starting new listen only session, rejecting it...`,
        { ...this._getPartialLogMetadata(), error });
      return callback(this._handleError(LOG_PREFIX, error, "recv", userId));
    }
  };

  _subscribeToGlobalAudio (sdpOffer, connectionId) {
    return new Promise(async (resolve, reject) => {
      try {
        const subscribe = async  () => {
          const { userId, mcsUserId } = this.getUser(connectionId);
          const options = {
            descriptor: sdpOffer,
            adapter: 'Kurento',
            name: this._assembleStreamName('subscribe', userId, this.meetingId),
            ignoreThresholds: true,
          }

          const { mediaId, answer } = await this.mcs.subscribe(mcsUserId,
            this.sourceAudio, C.WEBRTC, options);

          this.mcs.onEvent(C.MEDIA_STATE, mediaId, (event) => {
            this._mediaStateWebRTC(event, mediaId, connectionId);
          });

          this.mcs.onEvent(C.MEDIA_STATE_ICE, mediaId, (event) => {
            this._onMCSIceCandidate(event, mediaId, connectionId);
          });

          this.audioEndpoints[connectionId] = mediaId;
          this._flushCandidatesQueue(connectionId);
          Logger.info(LOG_PREFIX, `Listen only session sucessfully subscribed to global audio with MCS user ${mcsUserId}`,
            this._getFullLogMetadata(connectionId));
          resolve(answer);
        }

        if (this.sourceAudioStatus === C.MEDIA_STARTING || this.sourceAudioStatus === C.MEDIA_STOPPED) {
          this.once(C.MEDIA_STARTED, subscribe);
        } else if (this.sourceAudioStatus === C.MEDIA_STARTED) {
          // Call the global audio subscription routine in case the source was already started
          subscribe();
        }
      } catch (error) {
        Logger.error(LOG_PREFIX, `New listen only session failed to subscribe to GLOBAL_AUDIO`,
          { ...this._getPartialLogMetadata(), error });
        reject(this._handleError(LOG_PREFIX, error, "recv", connectionId));
      }
    });
  }

  /* ======= STOP METHODS ======= */

  async stopListener(connectionId) {
    const listener = this.audioEndpoints[connectionId];
    const  { userId, mcsUserId }  = this.getUser(connectionId);
    Logger.info(LOG_PREFIX, `Stopping listen only session of ${userId}`,
      this._getFullLogMetadata(connectionId));

    this.sendUserDisconnectedFromGlobalAudioMessage(connectionId);

    if (listener) {
      try {
        await this.mcs.unsubscribe(mcsUserId, listener);
      } catch (error) {
        Logger.warn(LOG_PREFIX, `Error on unsubscribing listener media ${listener}`,
          { ...this._getFullLogMetadata(connection), error});
      }
    }

    if (mcsUserId) {
      try {
        await this.mcs.leave(this.voiceBridge, mcsUserId);
      } catch (error) {
        Logger.warn(LOG_PREFIX, `Error on leave for listen only session ${listener}}`,
          { ...this._getFullLogMetadata(connectionId), error});
      }
    }

    if (this.audioEndpoints && Object.keys(this.audioEndpoints).length === 1) {
      this._stopSourceAudio();
    }

    delete this.candidatesQueue[connectionId];
    delete this.audioEndpoints[connectionId];
  }

  async stop () {
    Logger.info(LOG_PREFIX, `Listen only session-wide stop for room ${this.voiceBridge}, releasing everything`,
      this._getPartialLogMetadata());
    try {
      const nofConnectedUsers = Object.keys(this.connectedUsers).length;
      if (nofConnectedUsers <= 0) {
        return this._stopSourceAudio();
      }

      for (var connectionId in this.connectedUsers) {
        try {
          await this.stopListener(connectionId);
        } catch (error) {
          Logger.error(LOG_PREFIX, `Listen only session stop failed`,
            { ...this._getFullLogMetadata(connectionId), error });
        }
      }
      return Promise.resolve();
    }
    catch (error) {
      Logger.error(LOG_PREFIX, `Error on session-wide stop for room ${this.voiceBridge}}`,
        { ...this._getPartialLogMetadata(), error });
      return Promise.reject(this._handleError(LOG_PREFIX, error, "recv", this.userId));
    }
  };

  async _stopSourceAudio () {
    try {
      await this.mcs.leave(this.voiceBridge, this.userId);
    } catch (error) {
      Logger.warn(LOG_PREFIX, `Error on stopping source audio ${this.voiceBridge} with MCS user ${this.userId}`, { ...this._getPartialLogMetadata(), error });
    }

    this.sourceAudioStarted = false;
    this.sourceAudioStatus = C.MEDIA_STOPPED;
    this.emit(C.MEDIA_STOPPED, this.voiceBridge);
  }

  sendUserDisconnectedFromGlobalAudioMessage(connectionId) {
    const user = this.getUser(connectionId);
    if (user) {
      const { userId, userName } = user;
      const msg = Messaging.generateUserDisconnectedFromGlobalAudioMessage(this.voiceBridge, userId, userName);
      Logger.info(LOG_PREFIX, `Sending global audio disconnection for user ${userId}`,
        this._getFullLogMetadata(connectionId));

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
      const { userId, userName } = user;
      const msg = Messaging.generateUserConnectedToGlobalAudioMessage(this.voiceBridge, userId, userName);
      Logger.info(LOG_PREFIX, `Sending global audio connection for user ${userId}`,
        this._getFullLogMetadata(connectionId));
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
};
