'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/BaseProvider');
const errors = require('../base/errors.js');

const LOG_PREFIX = "[audio]";

const MEDIA_FLOW_TIMEOUT_DURATION = config.get('mediaFlowTimeoutDuration');
const MEDIA_STATE_TIMEOUT_DURATION = config.get('mediaStateTimeoutDuration');
const PERMISSION_PROBES = config.get('permissionProbes');

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
    this.userId;
    this._mediaFlowingTimeouts = {};
    this._mediaStateTimeouts = {};
    this.connectedUsers = {};
    this.candidatesQueue = {}
    this.meetingId = meetingId;
    this.handleMCSCoreDisconnection = this.handleMCSCoreDisconnection.bind(this);
    this.mcs.on(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
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
    const { mcsUserId, mediaId } = this.audioEndpoints[connectionId] || {};
    return {
      roomId: this.voiceBridge,
      internalMeetingId: this.meetingId,
      mcsUserId,
      userId,
      userName,
      mediaId,
      status: this.sourceAudioStatus,
      connectionId,
    };
  }

  /* ======= ICE HANDLERS ======= */

  onIceCandidate (_candidate, connectionId) {
    const endpoint = this.audioEndpoints[connectionId];

    if (endpoint && endpoint.mediaId) {
      try {
        this._flushCandidatesQueue(connectionId);
        this.mcs.addIceCandidate(endpoint.mediaId, _candidate);
      }
      catch (error)   {
        Logger.error(LOG_PREFIX, "ICE candidate could not be added to media controller.",
          { ...this._getFullLogMetadata(connectionId), error });
      }
    } else {
      if(!this.candidatesQueue[connectionId]) {
        this.candidatesQueue[connectionId] = [];
      }
      this.candidatesQueue[connectionId].push(_candidate);
    }
  };

  async _flushCandidatesQueue (connectionId) {
    const endpoint = this.audioEndpoints[connectionId];

    if (endpoint && endpoint.mediaId) {
      try {
        if (this.candidatesQueue[connectionId]) {
          this.flushCandidatesQueue(this.mcs, [...this.candidatesQueue[connectionId]], endpoint.mediaId);
          this.candidatesQueue[connectionId] = [];
        } else {
          Logger.warn(LOG_PREFIX, `ICE candidates could not be found for connectionId. ${connectionId}`,
            this._getFullLogMetadata(connectionId));
        }
      }
      catch (error) {
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
  addUser (connectionId, user) {
    if (this.connectedUsers.hasOwnProperty(connectionId)) {
      Logger.warn(LOG_PREFIX, `Updating user for connectionId ${connectionId}`,
        this._getFullLogMetadata(connectionId));
    }
    this.connectedUsers[connectionId] = user;
    Logger.debug(LOG_PREFIX, `Added user with connectionId ${connectionId}`,
      this._getFullLogMetadata(connectionId));
  };

  static isValidUser (user) {
    return (typeof user === 'object') && (typeof user.userId === 'string') && (typeof user.userName === 'string');
  }

  /**
   * Exclude user from a hash object indexed by it's connectionId
   * @param  {String} connectionId Current connection id at the media manager
   */
  removeUser(connectionId) {
    if (this.connectedUsers.hasOwnProperty(connectionId)) {
      Logger.info(LOG_PREFIX, `Removing user with connectionId ${connectionId}`,
        this._getFullLogMetadata(connectionId));
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

  getGlobalAudioPermission (meetingId, voiceBridge, userId, sfuSessionId) {
    if (!PERMISSION_PROBES) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onResp = (payload) => {
        const { meetingId, voiceBridge, userId, allowed } = payload;
        if (meetingId === payload.meetingId
          && payload.voiceBridge === voiceBridge
          && payload.userId === userId
          && payload.allowed) {
          return resolve();
        }

        return reject(errors.SFU_UNAUTHORIZED);
      }

      const msg = Messaging.generateGetGlobalAudioPermissionReqMsg(meetingId, voiceBridge, userId, sfuSessionId);
      this.bbbGW.once(C.GET_GLOBAL_AUDIO_PERM_RESP_MSG+sfuSessionId, onResp);
      this.bbbGW.publish(msg, C.TO_AKKA_APPS_CHAN_2x);
    });
  }

  /* ======= MEDIA TIMEOUT HANDLERS ===== */

  _onSubscriberMediaFlowing (connectionId) {
    Logger.info(LOG_PREFIX, `Listen only WebRTC media is FLOWING`,
      this._getFullLogMetadata(connectionId));
    this.clearMediaFlowingTimeout(connectionId);
    this.sendUserConnectedToGlobalAudioMessage(connectionId);
    this.bbbGW.publish(JSON.stringify({
        connectionId: connectionId,
        id: "webRTCAudioSuccess",
        success: "MEDIA_FLOWING"
    }), C.FROM_AUDIO);
  };

  _onSubscriberMediaNotFlowing (connectionId) {
    Logger.warn(LOG_PREFIX, `Listen only WebRTC media is NOT_FLOWING`,
      this._getFullLogMetadata(connectionId));
    this.setMediaFlowingTimeout(connectionId);
  }

  _onSubscriberMediaNotFlowingTimeout (connectionId) {
    Logger.error(LOG_PREFIX, `Listen only WebRTC media NOT_FLOWING timeout reached`,
      this._getFullLogMetadata(connectionId));
    this.bbbGW.publish(JSON.stringify({
      connectionId: connectionId,
      id: "webRTCAudioError",
      error: { code: 2211 , reason: errors[2211] },
    }), C.FROM_AUDIO);
  };

  setMediaFlowingTimeout (connectionId) {
    if (!this._mediaFlowingTimeouts[connectionId]) {
      Logger.warn(LOG_PREFIX, `Listen only NOT_FLOWING timeout set`,
        { ...this._getFullLogMetadata(connectionId), MEDIA_FLOW_TIMEOUT_DURATION });
      this._mediaFlowingTimeouts[connectionId] = setTimeout(() => {
        this._onSubscriberMediaNotFlowingTimeout(connectionId);
      }, MEDIA_FLOW_TIMEOUT_DURATION);
    }
  }

  clearMediaFlowingTimeout (connectionId) {
    if (this._mediaFlowingTimeouts[connectionId]) {
      Logger.debug(LOG_PREFIX, `clearMediaFlowingTimeout for listener ${connectionId}`,
        this._getFullLogMetadata(connectionId));
      clearTimeout(this._mediaFlowingTimeouts[connectionId]);
      delete this._mediaFlowingTimeouts[connectionId]
    }
  }

  _onSubscriberMediaConnected (connectionId) {
    Logger.info(LOG_PREFIX, `Listen only WebRTC media is CONNECTED`,
      this._getFullLogMetadata(connectionId));
    this.clearMediaStateTimeout(connectionId);
  };

  _onSubscriberMediaDisconnected (connectionId) {
    Logger.warn(LOG_PREFIX, `Listen only WebRTC media is DISCONNECTED`,
      this._getFullLogMetadata(connectionId));
    this.setMediaStateTimeout(connectionId);
  }

  _onSubscriberMediaDisconnectedTimeout (connectionId) {
    Logger.error(LOG_PREFIX, `Listen only WebRTC media DISCONNECTED timeout reached`,
      this._getFullLogMetadata(connectionId));

    this.bbbGW.publish(JSON.stringify({
      connectionId: connectionId,
      id: "webRTCAudioError",
      error: { code: 2211 , reason: errors[2211] },
    }), C.FROM_AUDIO);
  };

  setMediaStateTimeout (connectionId) {
    if (!this._mediaStateTimeouts[connectionId]) {
      Logger.warn(LOG_PREFIX, `Listen only DISCONNECTED media state timeout set`,
        { ...this._getFullLogMetadata(connectionId), MEDIA_STATE_TIMEOUT_DURATION });
      this._mediaStateTimeouts[connectionId] = setTimeout(() => {
        this._onSubscriberMediaDisconnectedTimeout(connectionId);
      }, MEDIA_STATE_TIMEOUT_DURATION);
    }
  }

  clearMediaStateTimeout (connectionId) {
    if (this._mediaStateTimeouts[connectionId]) {
      Logger.debug(LOG_PREFIX, `clearMediaStateTimeout for listener ${connectionId}`,
        this._getFullLogMetadata(connectionId));
      clearTimeout(this._mediaStateTimeouts[connectionId]);
      delete this._mediaStateTimeouts[connectionId]
    }
  }

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
      candidate : candidate
    }), C.FROM_AUDIO);
  }

  _handleIceComponentStateChange (state, logMetadata) {
    const { rawEvent } = state;
    const {
      componentId: iceComponentId,
      source: elementId,
      state: iceComponentState
    } = rawEvent;

    Logger.info(LOG_PREFIX, `Audio ICE component state changed`, {
      ...logMetadata,
      elementId,
      iceComponentId,
      iceComponentState
    });
  }

  _handleCandidatePairSelected (state, logMetadata) {
    const { rawEvent } = state;
    const { candidatePair, source: elementId } = rawEvent;
    const { localCandidate, remoteCandidate, componentID: iceComponentId } = candidatePair;
    Logger.info(LOG_PREFIX, `Audio new candidate pair selected`, {
      ...logMetadata,
      elementId,
      iceComponentId,
      localCandidate,
      remoteCandidate,
    });
  }

  _handleIceGatheringDone (state, logMetadata) {
    const { rawEvent } = state;
    const { source: elementId } = rawEvent;
    Logger.info(LOG_PREFIX, `Audio ICE gathering done`, {
      ...logMetadata,
      elementId,
    });
  }

  _handleMediaStateChanged (state, connectionId, logMetadata) {
    const { rawEvent, details } = state;
    const { source: elementId } = rawEvent;
    Logger.info(LOG_PREFIX, `Audio media state changed`, {
      ...logMetadata,
      elementId,
      mediaState: details,
    });

    if (details === 'CONNECTED') {
      this._onSubscriberMediaConnected(connectionId);
    } else if (details === 'DISCONNECTED') {
      this._onSubscriberMediaDisconnected(connectionId);
    }
  }

  _mediaStateWebRTC (event, endpoint, connectionId) {
    const { mediaId , state } = event;
    const { name, details } = state;
    const logMetadata = this._getFullLogMetadata(connectionId);

    if (mediaId !== endpoint) {
      return;
    }

    switch (name) {
      case "IceComponentStateChange":
        this._handleIceComponentStateChange(state, logMetadata);
        break;
      case "NewCandidatePairSelected":
        this._handleCandidatePairSelected(state, logMetadata);
        break;
      case "IceGatheringDone":
        this._handleIceGatheringDone(state, logMetadata);
        break;
      case "MediaStateChanged":
        this._handleMediaStateChanged(state, connectionId, logMetadata);
        break;

      case "MediaFlowOutStateChange":
      case "MediaFlowInStateChange":
        Logger.debug(LOG_PREFIX, `Listen only WebRTC media received MediaFlow state`,
          { ...logMetadata, state });

        if (details === 'FLOWING') {
          this._onSubscriberMediaFlowing(connectionId);
        } else {
          this._onSubscriberMediaNotFlowing(connectionId);
        }

        break;

      case C.MEDIA_SERVER_OFFLINE:
        Logger.error(LOG_PREFIX, `WebRTC listen only session ${mediaId} received MEDIA_SERVER_OFFLINE event`,
          { ...logMetadata, event });

        this.emit(C.MEDIA_SERVER_OFFLINE, event);
        break;

      default: Logger.warn(LOG_PREFIX, `Unrecognized event`, { event });
    }
  }

  /* ======= START/CONNECTION METHODS ======= */

  upstartSourceAudio (descriptor, calleeName) {
    return new Promise(async (resolve, reject) => {
      Logger.info(LOG_PREFIX,  `Starting RTP source audio/GLOBAL_AUDIO for ${this.voiceBridge}`,
        this._getPartialLogMetadata());
      try {
        if (!this.sourceAudioStarted && this.sourceAudioStatus === C.MEDIA_STOPPED) {
          const isConnected = await this.mcs.waitForConnection();

          if (!isConnected) {
            return reject(errors.MEDIA_SERVER_OFFLINE);
          }

          const userId = await this.mcs.join(
            this.voiceBridge,
            'SFU',
            { name: calleeName },
          );
          this.userId = userId;
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
            hackForceActiveDirection: true,
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

          Logger.info(LOG_PREFIX, `Listen only source RTP relay successfully created`,
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

  async start (sessionId, connectionId, sdpOffer, calleeName, userId, userName, permissionProbeDone, callback) {
    try {
      if (!permissionProbeDone) {
        await this.getGlobalAudioPermission(this.meetingId, this.voiceBridge, userId, connectionId);
      }

      const isConnected = await this.mcs.waitForConnection();

      if (!isConnected) {
        throw errors.MEDIA_SERVER_OFFLINE;
      }

      const mcsUserId = await this.mcs.join(
        this.voiceBridge,
        'SFU',
        { externalUserId: userId, name: userName , autoLeave: true }
      );

      // Storing the user data to be used by the pub calls
      const user = { userId, userName, mcsUserId };
      this.addUser(connectionId, user);
      Logger.info(LOG_PREFIX, `Starting new listen only session`,
        this._getFullLogMetadata(connectionId));
      const sdpAnswer = await this._subscribeToGlobalAudio(sdpOffer, connectionId);
      // Check for stop while starting glare. If the user doesn't exist anymore,
      // that's the case. Clean mcs-core's stuff up.
      const maybeError = await this._checkForStopGlare(connectionId);
      return callback(maybeError, sdpAnswer);
    }
    catch (error) {
      Logger.error(LOG_PREFIX, `Error on starting new listen only session, rejecting it...`,
        { ...this._getPartialLogMetadata(), error });
      return callback(this._handleError(LOG_PREFIX, error, "recv", userId));
    }
  };

  async _checkForStopGlare (connectionId) {
    const user = this.getUser(connectionId);
    if (!Audio.isValidUser(user)) {
      Logger.warn(LOG_PREFIX, `GLARE: session was stopped while starting, clean things up`,
        this._getFullLogMetadata(connectionId));

      try {
        await this.stopListener(connectionId);
      } catch (error) {
        Logger.warn(LOG_PREFIX, `Error while rolling back at _checkForStopGlare`,
          { ...this._getFullLogMetadata(connectionId), error });
      }

      // Glare detected. The session has been properly cleaned. Return a standardized
      // MEDIA_NOT_FOUND
      const error = { code: 2201, reason: errors[2201] };
      return this._handleError(LOG_PREFIX, error, "recv", connectionId);
    } else {
      // There's no glare. Return null (means no error)
      return null;
    }
  }

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

          let mediaId, answer;
          try {
            ({ mediaId, answer } = await this.mcs.subscribe(mcsUserId,
              this.sourceAudio, C.WEBRTC, options));
          } catch (subscribeError) {
            Logger.error(LOG_PREFIX, `New listen only session failed to subscribe to GLOBAL_AUDIO`,
              { ...this._getPartialLogMetadata(), subscribeError});
            return reject(this._handleError(LOG_PREFIX, subscribeError, "recv", connectionId));
          }

          this.mcs.onEvent(C.MEDIA_STATE, mediaId, (event) => {
            this._mediaStateWebRTC(event, mediaId, connectionId);
          });

          this.mcs.onEvent(C.MEDIA_STATE_ICE, mediaId, (event) => {
            this._onMCSIceCandidate(event, mediaId, connectionId);
          });

          this.audioEndpoints[connectionId] = { mcsUserId, mediaId };
          this._flushCandidatesQueue(connectionId);
          Logger.info(LOG_PREFIX, `Listen only session successfully subscribed to global audio with MCS user ${mcsUserId}`,
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

    this.sendUserDisconnectedFromGlobalAudioMessage(connectionId);

    if (listener && listener.mediaId && listener.mcsUserId) {
      try {
        Logger.info(LOG_PREFIX, `Stopping listen only session of ${connectionId}`,
          this._getFullLogMetadata(connectionId));
        await this.mcs.unsubscribe(listener.mcsUserId, listener.mediaId);
      } catch (error) {
        Logger.warn(LOG_PREFIX, `Error on unsubscribing listener media ${listener.mediaId}`,
          { ...this._getFullLogMetadata(connectionId), error});
      }
    }

    if (this.audioEndpoints
      && Object.keys(this.audioEndpoints).length === 1
      && this.audioEndpoints[connectionId]) {
      this._stopSourceAudio();
    }

    delete this.candidatesQueue[connectionId];
    delete this.audioEndpoints[connectionId];
    this.clearMediaFlowingTimeout(connectionId);
    this.clearMediaStateTimeout(connectionId);
  }

  async stop () {
    Logger.info(LOG_PREFIX, `Listen only session-wide stop for room ${this.voiceBridge}, releasing everything`,
      this._getPartialLogMetadata());
    this.mcs.removeListener(C.MCS_DISCONNECTED, this.handleMCSCoreDisconnection);
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
    Logger.info(LOG_PREFIX, 'Stopping source audio', this._getPartialLogMetadata());
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
          this.bbbGW.publish(msg, C.TO_BBB_MEETING_CHAN);
          break;
        default:
          this.bbbGW.publish(msg, C.TO_AKKA_APPS);
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
          this.bbbGW.publish(msg, C.TO_BBB_MEETING_CHAN);
          break;
        default:
          this.bbbGW.publish(msg, C.TO_AKKA_APPS);
      }
    }
  };
};
