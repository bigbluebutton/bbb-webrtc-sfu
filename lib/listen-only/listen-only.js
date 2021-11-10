'use strict';

const config = require('config');
const C = require('../bbb/messages/Constants');
const Logger = require('../utils/Logger');
const Messaging = require('../bbb/messages/Messaging');
const BaseProvider = require('../base/BaseProvider');
const errors = require('../base/errors.js');

const LOG_PREFIX = C.LISTENONLY_PROVIDER_PREFIX;
const GLOBAL_AUDIO_PREFIX = "GLOBAL_AUDIO_";

const GLOBAL_AUDIO_CONNECTION_TIMEOUT = config.get('mediaFlowTimeoutDuration');
const MEDIA_FLOW_TIMEOUT_DURATION = config.get('mediaFlowTimeoutDuration');
const MEDIA_STATE_TIMEOUT_DURATION = config.get('mediaStateTimeoutDuration');
const PERMISSION_PROBES = config.get('permissionProbes');
const BRIDGE_MODE = config.has('listenOnlyGlobalAudioMode')
  ? config.get('listenOnlyGlobalAudioMode')
  : 'RTP';
const IGNORE_THRESHOLDS = config.has('listenOnlyIgnoreMediaThresholds')
  ? config.get('listenOnlyIgnoreMediaThresholds')
  : true;

module.exports = class ListenOnly extends BaseProvider {
  constructor(bbbGW, voiceBridge, mcs, meetingId, mediaServer) {
    super(bbbGW);
    this.sfuApp = C.LISTEN_ONLY_APP;
    this.mcs = mcs;
    this.voiceBridge = voiceBridge;
    this.globalAudioBridge = `${GLOBAL_AUDIO_PREFIX}${this.voiceBridge}`;
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
    this.mediaServer = mediaServer;
  }

  set sourceAudioStatus (status) {
    this._sourceAudioStatus = status;
    this.emit(this._sourceAudioStatus);
  }

  get sourceAudioStatus () {
    return this._sourceAudioStatus;
  }

  _getPartialLogMetadata () {
    return {
      roomId: this.voiceBridge,
      internalMeetingId: this.meetingId,
      status: this.sourceAudioStatus,
      sourceAudioId: this.sourceAudio,
      globalAudioId: this.globalAudioId,
    };
  }

  _getFullLogMetadata (connectionId) {
    const { userId } = this.getUser(connectionId, true) || {};
    const { mcsUserId, mediaId } = this.audioEndpoints[connectionId] || {};
    return {
      roomId: this.voiceBridge,
      internalMeetingId: this.meetingId,
      mcsUserId,
      userId,
      mediaId,
      status: this.sourceAudioStatus,
      connectionId,
      sourceAudioId: this.sourceAudio,
      globalAudioId: this.globalAudioId,
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
  }

  async _flushCandidatesQueue (connectionId) {
    const endpoint = this.audioEndpoints[connectionId];

    if (endpoint && endpoint.mediaId) {
      try {
        if (this.candidatesQueue[connectionId]) {
          this.flushCandidatesQueue(this.mcs, [...this.candidatesQueue[connectionId]], endpoint.mediaId);
          this.candidatesQueue[connectionId] = [];
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
    if (Object.prototype.hasOwnProperty.call(this.connectedUsers, connectionId)) {
      Logger.debug(LOG_PREFIX, `Updating user for connectionId ${connectionId}`,
        this._getFullLogMetadata(connectionId));
    }
    this.connectedUsers[connectionId] = user;
    Logger.debug(LOG_PREFIX, `Added user with connectionId ${connectionId}`,
      this._getFullLogMetadata(connectionId));
  }

  static isValidUser (user) {
    return user && user.userId && user.userName;
  }

  /**
   * Exclude user from a hash object indexed by it's connectionId
   * @param  {String} connectionId Current connection id at the media manager
   */
  removeUser(connectionId) {
    if (Object.prototype.hasOwnProperty.call(this.connectedUsers, connectionId)) {
      Logger.info(LOG_PREFIX, `Removing user with connectionId ${connectionId}`,
        this._getFullLogMetadata(connectionId));
      delete this.connectedUsers[connectionId];
    } else {
      Logger.debug(LOG_PREFIX, `User not found on remove for connectionId ${connectionId}`,
        this._getPartialLogMetadata());
    }
  }

/**
 * Consult user from a hash object indexed by it's connectionId
 * @param  {String} connectionId Current connection id at the media manager
 * @return  {Object} user {userId: String, userName: String}
 */
  getUser (connectionId, suppressLog = false) {
    if (Object.prototype.hasOwnProperty.call(this.connectedUsers, connectionId)) {
      return this.connectedUsers[connectionId];
    } else {
      if (!suppressLog) {
        Logger.error(LOG_PREFIX, `User not found on getUser for connectionId ${connectionId}`,
          this._getPartialLogMetadata());
      }

      return {};
    }
  }

  /**
  * Consult connectionId from a hash object composed by users {userId: String, userName: String}
  * @param  {String} userId user id of a specific user at the media manager
  * @return  {String} connectionId
  */
  getConnectionIdsFromUser(userId) {
    return Object.keys(this.connectedUsers).filter(connectionId => {
      const user = this.connectedUsers[connectionId];
      return (user && user.userId === userId);
    });
  }

  getGlobalAudioPermission (meetingId, voiceBridge, userId, sfuSessionId) {
    if (!PERMISSION_PROBES) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onResp = (payload) => {
        if (meetingId === payload.meetingId
          && voiceBridge === payload.voiceConf
          && userId === payload.userId
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
    Logger.debug(LOG_PREFIX, `Listen only WebRTC media is FLOWING`,
      this._getFullLogMetadata(connectionId));
    this.clearMediaFlowingTimeout(connectionId);
    this.sendUserConnectedToGlobalAudioMessage(connectionId);
    this.sendToClient({
      type: 'audio',
      connectionId: connectionId,
      id: "webRTCAudioSuccess",
      success: "MEDIA_FLOWING"
    }, C.FROM_LISTEN_ONLY);
  }

  _onSubscriberMediaNotFlowing (connectionId) {
    Logger.debug(LOG_PREFIX, `Listen only WebRTC media is NOT_FLOWING`,
      this._getFullLogMetadata(connectionId));
    this.setMediaFlowingTimeout(connectionId);
  }

  _onSubscriberMediaNotFlowingTimeout (connectionId) {
    Logger.error(LOG_PREFIX, `Listen only WebRTC media NOT_FLOWING timeout reached`,
      this._getFullLogMetadata(connectionId));
    this.sendToClient({
      type: 'audio',
      connectionId: connectionId,
      id: "webRTCAudioError",
      error: { code: 2211 , reason: errors[2211] },
    }, C.FROM_LISTEN_ONLY);
  }

  setMediaFlowingTimeout (connectionId) {
    if (!this._mediaFlowingTimeouts[connectionId]) {
      Logger.debug(LOG_PREFIX, `Listen only NOT_FLOWING timeout set`,
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
  }

  _onSubscriberMediaDisconnected (connectionId) {
    Logger.warn(LOG_PREFIX, `Listen only WebRTC media is DISCONNECTED`,
      this._getFullLogMetadata(connectionId));
    this.setMediaStateTimeout(connectionId);
  }

  _onSubscriberMediaDisconnectedTimeout (connectionId) {
    Logger.error(LOG_PREFIX, `Listen only WebRTC media DISCONNECTED timeout reached`,
      this._getFullLogMetadata(connectionId));

    this.sendToClient({
      type: 'audio',
      connectionId: connectionId,
      id: "webRTCAudioError",
      error: { code: 2211 , reason: errors[2211] },
    }, C.FROM_LISTEN_ONLY);
  }

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

  _onBridgeMediaStateChange (event, endpoint) {
    const { mediaId, state } = event;
    const { name } = state;

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

    this.sendToClient({
      type: 'audio',
      connectionId,
      id : 'iceCandidate',
      candidate : candidate
    }, C.FROM_LISTEN_ONLY);
  }

  _handleIceComponentStateChange (state, logMetadata) {
    const { rawEvent } = state;
    const {
      componentId: iceComponentId,
      source: elementId,
      state: iceComponentState
    } = rawEvent;

    Logger.debug(LOG_PREFIX, `ListenOnly ICE component state changed`, {
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
    Logger.info(LOG_PREFIX, `ListenOnly new candidate pair selected`, {
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
    Logger.debug(LOG_PREFIX, "ListenOnly ICE gathering done", {
      ...logMetadata,
      elementId,
    });
  }

  _handleMediaStateChanged (state, connectionId, logMetadata) {
    const { rawEvent, details } = state;
    const { source: elementId } = rawEvent;
    Logger.debug(LOG_PREFIX, "ListenOnly media state changed", {
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

  _waitForGlobalAudio () {
    const waitForConnection = () => {
      return new Promise((resolve, reject) => {
        const onMediaStarted = () =>  {
          this.removeListener(C.MEDIA_NEGOTIATION_FAILED, onMediaFailed);
          this.removeListener(C.MEDIA_STOPPED, onMediaFailed);
          resolve(true)
        };
        const onMediaFailed = () =>  {
          this.removeListener(C.MEDIA_NEGOTIATION_FAILED, onMediaFailed);
          this.removeListener(C.MEDIA_STOPPED, onMediaFailed);
          this.removeListener(C.MEDIA_STARTED, onMediaStarted);
          reject(false)
        };

        this.once(C.MEDIA_STARTED, onMediaStarted);
        this.once(C.MEDIA_NEGOTIATION_FAILED, onMediaFailed);
        this.once(C.MEDIA_STOPPED, onMediaFailed);
      });
    };

    const connectionProbe = () => {
        switch (this.sourceAudioStatus) {
          case C.MEDIA_STARTED:
            return Promise.resolve(true);
          case C.MEDIA_STOPPED:
            return this.startGlobalAudioBridge();
          default:
            return waitForConnection();
        }
    };

    const failOver = () => {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          return reject(errors.MEDIA_SERVER_REQUEST_TIMEOUT);
        }, GLOBAL_AUDIO_CONNECTION_TIMEOUT);
      });
    };

    return Promise.race([connectionProbe(), failOver()]);
  }

  async _startGABridge (transportType) {
    Logger.info(LOG_PREFIX,  'Starting WebRTC GLOBAL_AUDIO',
      this._getPartialLogMetadata());

    try {
      // 1 - Generate a publisher/producer media session @client-facing adapterOptions
      //     (this one will relay audio from FS to browser clients)
      // 2 - Generate a publisher/producer media session in FS's adapter with
      //     the offer generated in #1 (this one will extract audio from FS's
      //     voice conf)
      // 3 - Send back the answer from #2 (FS) to the publisher created in #1
      //     (client proxy/relay)

      if (!this.sourceAudioStarted && this.sourceAudioStatus === C.MEDIA_STOPPED) {
        this.sourceAudioStatus = C.MEDIA_STARTING;

        const isConnected = await this.mcs.waitForConnection();

        if (!isConnected) {
          throw (errors.MEDIA_SERVER_OFFLINE);
        }

        this.userId = await this.mcs.join(this.voiceBridge, 'SFU', {
          name: this.globalAudioBridge
        });

        // Step 1:
        // Add a publisher/proxy in the client-facing media server adapter that
        // will receive media from the GLOBAL_AUDIO endpoint in FS's adapter.
        // That publisher will act as the WebRTC relay/proxy for listen only
        // subscribers
        const proxyOptions = {
          adapter: this.mediaServer,
          name: `PROXY_${this.globalAudioBridge}|subscribe`,
          ignoreThresholds: true,
          hackForceActiveDirection: true,
          trickle: false,
          profiles: {
            // sendrecv => in from FS, out to subscribers. Odd, isn't it? :)
            audio: 'sendrecv',
          },
          mediaProfile: 'audio',
          adapterOptions: {
            msHackRTPAVPtoRTPAVPF: true,
          },
        }

        const { mediaId: proxyId, answer: proxyOffer } = await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          transportType,
          proxyOptions,
        );

        this.mcs.onEvent(C.MEDIA_STATE, proxyId, (event) => {
          this._onBridgeMediaStateChange(event, proxyId);
        });

        // Step 2
        // Generate a publisher/producer media session in FS's adapter with
        // the offer generated in #1 (this one will extract audio from FS's
        // voice conf)
        const globalAudioOptions = {
          adapter: 'Freeswitch',
          name: this.globalAudioBridge,
          ignoreThresholds: true,
          descriptor: proxyOffer,
          profiles: {
            audio: 'sendonly',
          },
          mediaProfile: 'audio',
        }

        const { mediaId: gaMediaId, answer: globalAudioAnswer } = await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          transportType,
          globalAudioOptions
        );

        // Step 3
        // Send back the answer from #2 (FS) to the publisher created in #1
        // (client proxy/relay)
        await this.mcs.publish(
          this.userId,
          this.voiceBridge,
          transportType,
          { ...proxyOptions, mediaId: proxyId, descriptor: globalAudioAnswer }
        );

        this.sourceAudio = proxyId;
        this.globalAudioId = gaMediaId;
        this.sourceAudioStarted = true;
        this.sourceAudioStatus = C.MEDIA_STARTED;
        this.emit(C.MEDIA_STARTED);

        Logger.info(LOG_PREFIX, 'Listen only source WebRTC relay created',
          { ...this._getPartialLogMetadata(), mediaId: this.sourceAudio, userId: this.userId });
      }
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Error starting listen only source WebRTC relay',
        { ...this._getPartialLogMetadata(), error });
      this.sourceAudioStatus = C.MEDIA_NEGOTIATION_FAILED;
      // Rollback
      this._stopSourceAudio();
      throw (error);
    }
  }

  startGlobalAudioBridge () {
    switch (BRIDGE_MODE) {
      case 'WebRTC':
        return this._startGABridge(C.WEBRTC);
      case 'RTP':
      default:
        return this._startGABridge(C.RTP);
    }
  }

  async start (sessionId, connectionId, sdpOffer, userId, userName) {
    let mcsUserId;
    const isConnected = await this.mcs.waitForConnection();

    if (!isConnected) {
      throw this._handleError(LOG_PREFIX, errors.MEDIA_SERVER_OFFLINE, "recv", userId);
    }

    try {
      await this.getGlobalAudioPermission(this.meetingId, this.voiceBridge, userId, connectionId);
    } catch (error) {
      const normalizedError = this._handleError(LOG_PREFIX, error, "recv", userId);
      Logger.error(LOG_PREFIX, 'New listen only session failed: unauthorized',
        { ...this._getPartialLogMetadata(), error: normalizedError });
      throw normalizedError;
    }

    try {
      await this._waitForGlobalAudio();
    } catch (error) {
      const normalizedError = this._handleError(LOG_PREFIX, error, "recv", userId);
      Logger.error(LOG_PREFIX, `New listen only session failed: GLOBAL_AUDIO unavailable`,
        { ...this._getPartialLogMetadata(), error: normalizedError });
      throw errors.SFU_GLOBAL_AUDIO_FAILED;
    }

    try {
      mcsUserId = await this.mcs.join(
        this.voiceBridge,
        'SFU',
        { externalUserId: userId, autoLeave: true }
      );
    } catch (error) {
      const normalizedError = this._handleError(LOG_PREFIX, error, "recv", userId);
      Logger.error(LOG_PREFIX, `mcs-core join failure for new listen only session`, {
        ...this._getPartialLogMetadata(),
        connectionId,
        userId,
        error: normalizedError
      });
      throw normalizedError;
    }

    // Storing the user data to be used by the pub calls
    const user = { userId, userName, mcsUserId, connected: false };
    this.addUser(connectionId, user);
    Logger.info(LOG_PREFIX, `Starting new listen only session`,
      this._getFullLogMetadata(connectionId));

    try {
      const sdpAnswer = await this._subscribeToGlobalAudio(sdpOffer, connectionId);
      return sdpAnswer;
    } catch (error) {
      const normalizedError = this._handleError(LOG_PREFIX, error, "recv", userId);
      Logger.error(LOG_PREFIX, `GLOBAL_AUDIO subscribe failed`, {
        ...this._getPartialLogMetadata(),
        connectionId,
        userId,
        error: normalizedError
      });

      // Rollback
      this.sendUserDisconnectedFromGlobalAudioMessage(connectionId);
      throw normalizedError;
    }
  }

  async _subscribeToGlobalAudio (sdpOffer, connectionId) {
    const { userId, mcsUserId } = this.getUser(connectionId);
    const options = {
      descriptor: sdpOffer,
      adapter: this.mediaServer,
      name: this._assembleStreamName('subscribe', userId, this.meetingId),
      ignoreThresholds: IGNORE_THRESHOLDS,
      profiles: {
        audio: 'recvonly',
      },
      mediaProfile: 'audio',
    }

    let mediaId, answer;

    try {
      ({ mediaId, answer } = await this.mcs.subscribe(mcsUserId,
        this.sourceAudio, C.WEBRTC, options));
    } catch (subscribeError) {
      Logger.error(LOG_PREFIX, `New listen only session failed to subscribe to GLOBAL_AUDIO`,
        { ...this._getPartialLogMetadata(), subscribeError});
      throw (this._handleError(LOG_PREFIX, subscribeError, "recv", connectionId));
    }

    this.mcs.onEvent(C.MEDIA_STATE, mediaId, (event) => {
      this._mediaStateWebRTC(event, mediaId, connectionId);
    });

    this.mcs.onEvent(C.MEDIA_STATE_ICE, mediaId, (event) => {
      this._onMCSIceCandidate(event, mediaId, connectionId);
    });

    this.audioEndpoints[connectionId] = { mcsUserId, mediaId };
    this._flushCandidatesQueue(connectionId);
    Logger.info(LOG_PREFIX, 'Listen only session subscribed to global audio',
      this._getFullLogMetadata(connectionId));
    return answer;
  }

  processAnswer (answer, connectionId) {
    const endpoint = this.audioEndpoints[connectionId];

    Logger.debug(LOG_PREFIX, 'Processing listen only answer',
      this._getFullLogMetadata(connectionId));

    if (endpoint && endpoint.mediaId) {
      const options = {
        mediaId: endpoint.mediaId,
        descriptor: answer,
        adapter: this.mediaServer,
        name: this._assembleStreamName('subscribe', endpoint.mcsUserId, this.meetingId),
        ignoreThresholds: IGNORE_THRESHOLDS,
        profiles: {
          audio: 'recvonly',
        },
      }

      return this.mcs.subscribe(endpoint.mcsUserId, this.sourceAudio, C.WEBRTC, options);
    }
  }

  /* ======= STOP METHODS ======= */

  async stopListener(connectionId) {
    const listener = this.audioEndpoints[connectionId];

    if (listener && listener.mediaId && listener.mcsUserId) {
      try {
        await this.mcs.unsubscribe(listener.mcsUserId, listener.mediaId);
        Logger.info(LOG_PREFIX, 'Listen only session stopped',
          this._getFullLogMetadata(connectionId));
      } catch (error) {
        Logger.warn(LOG_PREFIX, `Error on unsubscribing listener media ${listener.mediaId}`,
          { ...this._getFullLogMetadata(connectionId), error});
      }

      this.sendUserDisconnectedFromGlobalAudioMessage(connectionId);
      if (this.audioEndpoints && Object.keys(this.audioEndpoints).length === 1) {
        this._stopSourceAudio();
      }

      delete this.audioEndpoints[connectionId];
    }

    if (this.candidatesQueue[connectionId]) {
      delete this.candidatesQueue[connectionId];
    }

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
  }

  async _stopSourceAudio () {
    if (this.userId) {
      try {
        await this.mcs.leave(this.voiceBridge, this.userId);
        this.userId = null;
      } catch (error) {
        Logger.warn(LOG_PREFIX, `Error on stopping source audio ${this.voiceBridge} with MCS user ${this.userId}`, { ...this._getPartialLogMetadata(), error });
      }
    }

    this.sourceAudioStarted = false;
    this.sourceAudioStatus = C.MEDIA_STOPPED;
  }

  sendUserDisconnectedFromGlobalAudioMessage(connectionId) {
    const user = this.getUser(connectionId);
    if (user) {
      if (user.connected) {
        const { userId, userName } = user;
        const msg = Messaging.generateUserDisconnectedFromGlobalAudioMessage(this.voiceBridge, userId, userName);
        this.bbbGW.publish(msg, C.TO_AKKA_APPS);
      }

      this.removeUser(connectionId);
    }
  }

  sendUserConnectedToGlobalAudioMessage(connectionId) {
    const user = this.getUser(connectionId);
    if (user) {
      const { userId, userName } = user;
      const msg = Messaging.generateUserConnectedToGlobalAudioMessage(this.voiceBridge, userId, userName);
      this.bbbGW.publish(msg, C.TO_AKKA_APPS);
      user.connected = true;
    }
  }
};
