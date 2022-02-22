'use strict'

const C = require('../../constants/constants.js');
const config = require('config');
const EventEmitter = require('events').EventEmitter;
const SIPMediaHandlerV2 = require('./sip-media-handler-v2');
const Logger = require('../../utils/logger');
const SIPJS = require('sip.js');
const convertRange = require('../../utils/util').convertRange;
const { v4: uuidv4 } = require('uuid');
const { handleError } = require('../../utils/util');
const LOG_PREFIX = "[mcs-freeswitch]";
const GLOBAL_EVENT_EMITTER = require('../../../../common/emitter.js');
const SDPMedia = require('../../model/sdp-media');
const EslWrapper = require('./esl-wrapper');

const DTMF_MODES = {
  CHANNEL: 'channel',
  INFO: 'info',
};
const DTMF_DEFAULT_MODE = DTMF_MODES.CHANNEL;
const DTMF_DEFAULT_DURATION = 2000;
const UA_STOP_TIMEOUT = 15000;

const {
  ip: FREESWITCH_CONNECTION_IP,
  sip_ip: FREESWITCH_SIP_IP,
  port: FREESWITCH_PORT,
} = config.get('freeswitch');
const IP_CLASS_MAPPINGS = config.has('freeswitch.ipClassMappings')
  ? config.get('freeswitch.ipClassMappings')
  : { public: FREESWITCH_CONNECTION_IP };
const SIP_USER_AGENT = config.has('freeswitch.sipUserAgent')
  ? config.get('freeswitch.sipUserAgent')
  : 'bbb-webrtc-sfu';


let instance = null;

module.exports = class Freeswitch extends EventEmitter {
  constructor(name, balancer) {
    if(!instance){
      super();
      this.name = name;
      this.balancer = balancer;
      this._userAgents = {};
      this._rtpProxies = {};
      this._channelIds = {};
      this._channelIdInfos = {};
      this._memberIdsToUa = {};
      this._eslWrapper = new EslWrapper();
      this._eslWrapper.start();
      this._trackESLEvents();

      instance = this;
    }

    return instance;
  }

  _trackESLEvents() {
      this._eslWrapper.on(EslWrapper.EVENTS.CHANNEL_ANSWER, this._handleChannelAnswer.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.CHANNEL_HANGUP, this._handleChannelHangup.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.START_TALKING, this._handleStartTalking.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.STOP_TALKING, this._handleStopTalking.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.CONFERENCE_MEMBER, this._handleConferenceMember.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.VOLUME_CHANGED, this._handleVolumeChanged.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.MUTED, this._handleMuted.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.UNMUTED, this._handleUnmuted.bind(this));
      this._eslWrapper.on(EslWrapper.EVENTS.FLOOR_CHANGED, this._handleFloorChanged.bind(this));
  }

  _handleChannelAnswer (channelId, callId) {
    Logger.debug(LOG_PREFIX, 'Associating channel', { channelId, callId });
    this._channelIds[callId] = channelId;

    let channelInfo = this._channelIdInfos[channelId];
    if (!channelInfo) {
      channelInfo = {};
      this._channelIdInfos[channelId] = channelInfo;
    }

    channelInfo.callId = callId;

    for (var ua in this._userAgents) {
      let userAgent = this._userAgents[ua];
      if (userAgent.callId === callId) {
        userAgent.channelId = channelId;
        channelInfo.ua = ua;
      }
    }
  }

  _handleChannelHangup (channelId, callId) {
    const channelInfo = this._channelIdInfos[channelId];
    if (channelInfo) {
      const elementId = channelInfo.ua;
      const userAgent = this._userAgents[elementId];
      if (userAgent) {
        const { session } = userAgent;
        if (!session || session.isOfferer) {
          // user joined externally or we are the offerer (FS enable-3ppc=proxy bug)
          // need to cleanup here instead of anchoring on sip.js;
          Logger.debug(LOG_PREFIX, 'Received CHANNEL_HANGUP', { elementId, channelId, callId });
          // This event should be intercepted by media.js at the trackMedia method
          // with stop as the callback
          this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
          this._deleteChannelMappings(elementId);
        }
      }
    }
  }

  _handleStartTalking (channelId) {
    const elementId = this._channelIdInfos[channelId].ua;
    this.emit(C.EVENT.MEDIA_START_TALKING+elementId);
  }

  _handleStopTalking (channelId) {
    const elementId = this._channelIdInfos[channelId].ua;
    this.emit(C.EVENT.MEDIA_STOP_TALKING+elementId);
  }

  _handleConferenceMember (channelId, memberId, callerIdNumber, roomId) {
    Logger.debug(LOG_PREFIX, "New conference member, associating UUID to mID",
      { roomId, channelId, memberId, callerIdNumber });
    const channelInfo = this._channelIdInfos[channelId];
    channelInfo.memberId = memberId;
    const elementId = channelInfo.ua;
    this._memberIdsToUa[memberId] = elementId;
  }

  _handleVolumeChanged (channelId, volume) {
    const elementId = this._channelIdInfos[channelId].ua;
    const convertedVolume = convertRange({floor: -4, ceiling: 4},
      {floor: 0, ceiling: 100}, volume);
    this.emit(C.EVENT.MEDIA_VOLUME_CHANGED+elementId, convertedVolume);
  }

  _handleMuted (channelId) {
    const elementId = this._channelIdInfos[channelId].ua;
    this.emit(C.EVENT.MEDIA_MUTED+elementId);
  }

  _handleUnmuted (channelId) {
    const elementId = this._channelIdInfos[channelId].ua;
    this.emit(C.EVENT.MEDIA_UNMUTED+elementId);
  }

  _handleFloorChanged (roomId, newFloorMemberId) {
    // Floor was released
    if (newFloorMemberId === 'none') {
      const event = {
        roomId,
      }
      Logger.debug(LOG_PREFIX, 'Video floor released', { event });
      return GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_NEW_VIDEO_FLOOR, event);
    }

    const newFloorElementId = this._memberIdsToUa[newFloorMemberId];
    Logger.debug(LOG_PREFIX, 'Video floor changed',
      { adapterElementId: newFloorElementId, roomId });
    this.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED+newFloorElementId, { roomId: roomId, newFloor: newFloorElementId });
  }

  negotiate (roomId, userId, mediaSessionId, descriptor, type, options = {}) {
    try {
      switch (type) {
        case C.MEDIA_TYPE.RTP:
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
        default:
          throw(new TypeError('Unknown media type'));
      }
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async _negotiateSDPEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    let mediaElement, host;
    try {
      ({ mediaElement, host } = await this.createMediaElement(roomId, type, options));
      const answer = await this.processOffer(mediaElement, descriptor, options);
      const media = new SDPMedia(roomId, userId, mediaSessionId, descriptor, answer, type, this, mediaElement, host, options);
      media.trackMedia();
      return [media];
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async createMediaElement (roomId, type, params) {
    try {
      const userAgentId = uuidv4();
      const userAgent = await this._createUserAgent(type, params.name, roomId);
      userAgent.userAgentId = userAgentId;
      userAgent.voiceBridge = roomId;
      userAgent.extension = params.adapterOptions
        ? params.adapterOptions.extension
        : undefined;
      this._userAgents[userAgentId] = userAgent;
      // TODO integrate FS adapter with Balancer
      return Promise.resolve({
        mediaElement: userAgentId,
        host: {
          ip: FREESWITCH_CONNECTION_IP,
          sip_ip: FREESWITCH_SIP_IP,
          port: FREESWITCH_PORT,
          ipClassMappings: IP_CLASS_MAPPINGS,
        }
      });
    }
    catch (err) {
      return Promise.reject(err);
    }
  }

  async connect (sourceId, sinkId, type) {
    const userAgent = this._userAgents[sourceId];
    const { session } = userAgent;

    if (session) {
        switch (type) {
          case C.CONNECTION_TYPE.ALL:
          case C.CONNECTION_TYPE.AUDIO:
          case C.CONNECTION_TYPE.VIDEO:
          default:
            throw (C.ERROR.MEDIA_INVALID_OPERATION);
        }
    } else {
      throw (this._handleError(C.ERROR.MEDIA_NOT_FOUND));
    }
  }

  async stop (roomId, type = {}, elementId) {
    this._removeElementEventListeners(elementId);

    try {
      await this._stopUserAgent(elementId);
    } catch (error) {
      Logger.error(LOG_PREFIX, `Error when stopping userAgent for ${elementId} at room ${roomId}`,
        { type, error: this._handleError(error) });
    }

    Logger.info(LOG_PREFIX, "Endpoint released", { elementId, roomId });
  }

  _deleteChannelMappings(elementId) {
    if (elementId in this._channelIds) {
      let channelId = this._channelIds[elementId];
      delete this._channelIds[elementId];
      let memberId = this._channelIdInfos[channelId].memberId;
      delete this._memberIdsToUa[memberId];
      delete this._channelIdInfos[channelId];
    }
  }

  _stopUserAgent (elementId) {
    const userAgent = this._userAgents[elementId];

    if (userAgent) {
      let stopped = false;

      const uaWaitForDisconnection = () => {
        userAgent.once('disconnected', () => {
          stopped = true;
          Logger.warn(LOG_PREFIX, "_stopUserAgent: SIP.js UA disconnected", { elementId });
          delete this._userAgents[elementId];
          this._deleteChannelMappings(elementId);
          return Promise.resolve();
        });
      };

      const uaStopFailover = () => {
        setTimeout(() => {
          if (!stopped) {
            Logger.warn(LOG_PREFIX, "UA hit failover timeout, socket leak?", { elementId });
          }
          delete this._userAgents[elementId];
          this._deleteChannelMappings(elementId);
          return Promise.resolve();
        }, UA_STOP_TIMEOUT);
      }

      userAgent.stop();

      return Promise.race([uaWaitForDisconnection(), uaStopFailover()]);
    }
    else {
      return Promise.resolve();
    }
  }

  processAnswer (elementId, descriptor) {
    const { session } = this._userAgents[elementId];

    if (session == null) {
      throw (C.ERROR.MEDIA_NOT_FOUND);
    }

    return session.mediaHandler.setRemoteOffer(descriptor);
  }

  async processOffer (elementId, sdpOffer, params) {
    const userAgent = this._userAgents[elementId];
    const { voiceBridge } = userAgent;
    const { name } = params
    let isNegotiated = false;

    return new Promise((resolve, reject) => {
      try {
        if (userAgent) {
          const session = this.sipCall(
            userAgent,
            name,
            userAgent.voiceBridge,
            FREESWITCH_SIP_IP,
            FREESWITCH_PORT,
            sdpOffer,
            userAgent.extension,
          );

          session.sessionId = userAgent.userAgentId;
          session.isOfferer = !sdpOffer;
          userAgent.session = session;

          const handleOffer = async (offer) => {
            return resolve(offer);
          }

          const handleReinvite = (reinviteSDP) => {
            Logger.debug(LOG_PREFIX, "re-INVITE received", { elementId, reinviteSDP });
            session.mediaHandler.setReinviteAnswer(session.localSDP);
          };

          session.once(C.EVENT.REMOTE_SDP_RECEIVED, handleOffer.bind(this));
          session.on(C.EVENT.REINVITE, handleReinvite.bind(this));

          const handleNegotiationError = () => {
            if (!isNegotiated) {
              isNegotiated = true;
              reject(this._handleError(C.ERROR.MEDIA_PROCESS_OFFER_FAILED));
            }

            return this.stop(voiceBridge, C.MEDIA_TYPE.RTP, elementId);
          }

          session.on('accepted', (response) => {
            if (response) {
              session.callId = response.call_id;
            }

            const answer = session.mediaHandler._sdpResponse;
            session.localSDP = answer;
            isNegotiated = true;

            return resolve(answer);
          });

          session.on('progress', (response) => {
            if (response) {
              userAgent.callId = response.call_id;
              let channelId = this._channelIds[response.call_id];
              if (channelId) {
                userAgent.channelId = channelId;
                let channelInfo = this._channelIdInfos[channelId];
                if (!channelInfo) {
                  channelInfo = {};
                  this._channelIdInfos[channelId] = channelInfo;
                }
                channelInfo.ua = elementId;
                let memberId = channelInfo.memberId;
                if (memberId) {
                  this._memberIdsToUa[memberId] = elementId;
                }
              }
            }
          });

          session.once('rejected', (response, cause) => {
            Logger.error(LOG_PREFIX, "SIP dialog rejected", { elementId, cause });
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError(cause);
          });

          session.once('failed', (response, cause) => {
            Logger.error(LOG_PREFIX, "SIP dialog failure", { elementId, cause });
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError(cause);
          });

          session.once('terminated', () => {
            Logger.debug(LOG_PREFIX, "SIP dialog terminated", { elementId });
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError();
          });
        } else {
          return reject(C.ERROR.MEDIA_NOT_FOUND);
        }
      }
      catch (error) {
        this._handleError(error);
        reject(error);
      }
    });
  }

  setVolume (mediaElementId, volume) {
    const userAgent = this._userAgents[mediaElementId];
    const { voiceBridge, callId } = userAgent;

    if (callId == null) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_NOT_FOUND,
        details: `setVolume. adapterElementId: ${mediaElementId}`,
      }));
    }

    try {
      const channelId = userAgent.channelId;
      const memberId = this._channelIdInfos[channelId].memberId;
      Logger.debug(LOG_PREFIX, "Set volume",
        { adapterElementId: mediaElementId, channelId, memberId, volume });

      if (volume != 0) {
        // Normalizes volume from a 0/100 range to FS's -4/4 range
        const convertedVolume = convertRange(
          {floor: 0, ceiling: 100},
          {floor: -4, ceiling: 4},
          volume
        );

        if (userAgent.muted) {
          // It's a request for a non null volume and the agent is muted;
          // return a chain of unmute + setVolume
          return this._eslWrapper.unmute(voiceBridge, memberId)
            .then(() => {
              userAgent.muted = false;
              return  this._eslWrapper.setVolume(voiceBridge, memberId, convertedVolume);
            })
            .then(() => {
              userAgent.volume = convertedVolume;
            });
        } else {
          // Isn't muted, just return a setVolume request from the wrapper
          return  this._eslWrapper.setVolume(voiceBridge, memberId, convertedVolume)
            .then(() => {
              userAgent.volume = convertedVolume;
            });
        }
      } else if (volume == 0 && !userAgent.muted) {
        // This is a request to mute through setVolume, return the mute promise
        return this._eslWrapper.mute(voiceBridge, memberId)
          .then(() => {
            userAgent.muted = true;
          });
      }
    } catch (error) {
      Logger.error(LOG_PREFIX, `setVolume failed due to ${error.message}`,
        { adapterElementId: mediaElementId, volume, error });
      throw (this._handleError(error));
    }
  }

  mute (mediaElementId) {
    const userAgent = this._userAgents[mediaElementId];
    const { voiceBridge, callId } = userAgent;
    if (callId == null) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_NOT_FOUND,
        details: `mute. adapterElementId: ${mediaElementId}`,
      }));
    }

    try {
      const channelId = userAgent.channelId;
      const memberId = this._channelIdInfos[channelId].memberId;
      return this._eslWrapper.mute(voiceBridge, memberId).then(() => {
        Logger.debug(LOG_PREFIX, "Audio muted",
          { adapterElementId: mediaElementId, channelId, memberId });
        userAgent.muted = true;
      });
    } catch (error) {
      Logger.error(LOG_PREFIX, `Mute failed due to ${error.message}`,
        { adapterElementId: mediaElementId, error });
      throw (this._handleError(error));
    }
  }

  unmute (mediaElementId) {
    const userAgent = this._userAgents[mediaElementId];
    const { voiceBridge, callId } = userAgent;
    if (callId == null) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_NOT_FOUND,
        details: `unmute. adapterElementId: ${mediaElementId}`,
      }));
    }

    try {
      const channelId = userAgent.channelId;
      const memberId = this._channelIdInfos[channelId].memberId;

      return this._eslWrapper.unmute(voiceBridge, memberId).then(() => {
        userAgent.muted = false;
        Logger.debug(LOG_PREFIX, "Audio unmuted",
          { adapterElementId: mediaElementId, channelId, memberId });

        if (userAgent.volume) {
          this._handleVolumeChanged(channelId, userAgent.volume);
        } else {
          this._handleVolumeChanged(channelId, 0);
        }
      });
    } catch (error) {
      Logger.error(LOG_PREFIX, `unmute failed due to ${error.message}`,
        { adapterElementId: mediaElementId, error });
      throw (this._handleError(error));
    }
  }

  trackMediaState (elementId) {
    let userAgent = this._userAgents[elementId];
    if (userAgent) {
      userAgent.on('invite', function() {
        Logger.trace(LOG_PREFIX,"On UserAgentInvite");
      });

      userAgent.on('message', function(message) {
        Logger.trace(LOG_PREFIX,"On UserAgentMessage", message);
      });

      userAgent.on('connected', function() {
        Logger.trace(LOG_PREFIX,"On UserAgentConnected");
      });

      userAgent.on('disconnected', function (){
        Logger.debug(LOG_PREFIX,"UserAgent disconnected");
      });

      return;
    }
  }

  _destroyElements() {
    for (var ua in this._userAgents) {
      if (Object.prototype.hasOwnProperty.call(this._userAgents, ua)) {
        delete this._mediaElements[ua];
      }
    }
  }

  _createUserAgent (type, displayName, roomId) {
    const uriUser = displayName ? displayName : roomId;
    const newUA = new SIPJS.UA({
      uri: `sip:${encodeURIComponent(uriUser)}@${FREESWITCH_SIP_IP}`,
      wsServers: `ws://${FREESWITCH_SIP_IP}:${FREESWITCH_PORT}`,
      displayName: displayName,
      register: false,
      mediaHandlerFactory: (session, options) => {
        return new SIPMediaHandlerV2(session, options);
      },
      userAgentString: SIP_USER_AGENT,
      log: {
        builtinEnabled: false,
        level: 3,
        connector: this.sipjsLogConnector
      },
      traceSip: true,
      hackIpInContact: FREESWITCH_SIP_IP
    });

    return newUA;
  }

  /**
   * Makes a sip call to a Freeswitch instance
   * @param {UA} caller's SIP.js User Agent
   * @param {String} username The user identifier
   * @param {String} voiceBridge The voiceBridge we are going to call to
   * @param {String} host Freeswitch host address
   * @param {String} port Freeswitch port
   */
  sipCall (userAgent, username, voiceBridge, host, port, descriptor, extension) {
    const inviteWithoutSdp = !descriptor;
    const targetExtension = (extension &&
      (typeof extension === 'string' || typeof extension == 'number'))
      ? extension
      : voiceBridge;

    // Call options
    const options = {
      media: {
        constraints: {
          audio: true,
          video: false
        },
      },
      inviteWithoutSdp,
      params: {
        from_displayName : username
      }
    };

    const sipUri = new SIPJS.URI('sip', targetExtension, host, port);
    const session = userAgent.invite(sipUri, options);

    // Avoid leaking DTMF transactions. We will ignore inbound INFO DTMF
    // for now because they are useless, but if the transaction is pending
    // that's problematic for UA stop. FIXME emit DTMF event to interested clients
    session.on('dtmf', (request) => {
      if (request && typeof request.reply === 'function') {
        request.reply(200);
      }
    });

    // We have a descriptor, set the offer and trigger the INVITE
    if (!inviteWithoutSdp) {
      session.mediaHandler.setRemoteOffer(descriptor);
    }

    return session;
  }

  dtmf (elementId, tones, options) {
    const userAgent = this._userAgents[elementId];
    const { callId } = userAgent;
    if (userAgent == null || userAgent.session == null || callId == null) {
      throw (this._handleError({
        ...C.ERROR.MEDIA_NOT_FOUND,
        details: `dtmf. adapterElementId: ${elementId}`,
      }));
    }

    const {
      mode = DTMF_DEFAULT_MODE,
      duration = DTMF_DEFAULT_DURATION,
      intertoneGap,
    } = options;

    try {
      const { session } = userAgent;

      if (mode === DTMF_MODES.INFO) {
        session.dtmf(tones, {
          duration,
          intertoneGap,
        });
        return Promise.resolve();
      } else {
        const channelId = userAgent.channelId;
        return this._eslWrapper.dtmf(channelId, tones);
      }
    } catch (error) {
      Logger.error(LOG_PREFIX, `dtmf failed due to ${error.message}`,
        { adapterElementId: elementId, mode, duration, tones, error });
      throw (this._handleError(error));
    }
  }

  requestKeyframe () {
    throw this._handleError({
      ...C.ERROR.MEDIA_INVALID_OPERATION,
      details: "FREESWITCH_REQUEST_KEYFRAME_NOT_IMPLEMENTED"
    });
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }

  _removeElementEventListeners (elementId) {
    const eventsToRemove = C.EVENT.ADAPTER_EVENTS.map(p => `${p}${elementId}`);
    Logger.trace(LOG_PREFIX, "Removing all event listeners for", elementId);
    eventsToRemove.forEach(e => {
      this.removeAllListeners(e);
    });
  }

  sipjsLogConnector (level, category, label, content) {
    Logger.debug('[SIP.js]  ' + content);
  }
};
