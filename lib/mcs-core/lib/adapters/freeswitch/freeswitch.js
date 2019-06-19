'use strict'

const C = require('../../constants/constants.js');
const config = require('config');
const EventEmitter = require('events').EventEmitter;
const mediaHandler = require('./sip-media-handler');
const Logger = require('../../utils/logger');
const SIPJS = require('sip.js');
const Kurento = require('../kurento/kurento');
const isError = require('../../utils/util').isError;
const convertRange = require('../../utils/util').convertRange;
const rid = require('readable-id');
const { handleError } = require('../../utils/util');

const FREESWITCH_IP = config.get('freeswitch').ip;
const FREESWITCH_PORT = config.get('freeswitch').port;
const SDPMedia = require('../../model/sdp-media');
const sendEslCommand = require('./esl.js');


let instance = null;

module.exports = class Freeswitch extends EventEmitter {
  constructor(balancer) {
    if(!instance){
      super();
      this._userAgents = {};
      this._rtpConverters = {};
      this._rtpProxies = {};
      this.balancer = balancer;
      this._Kurento = new Kurento(balancer);
      instance = this;
    }

    return instance;
  }
  negotiate (roomId, userId, mediaSessionId, descriptor, type, options) {
    let media;
    try {
      switch (type) {
        case C.MEDIA_TYPE.RTP:
        case C.MEDIA_TYPE.WEBRTC:
          return this._negotiateSDPEndpoint(roomId, userId, mediaSessionId, descriptor, type, options);
          break;
        default:
          throw(this._handleError(ERRORS[40107]));
      }
    } catch (err) {
      throw(this._handleError(err));
    }
  }

  async _negotiateSDPEndpoint (roomId, userId, mediaSessionId, descriptor, type, options) {
    let mediaElement, host;

    Logger.debug("[mcs-kurento-adapter] Negotiating SDP endpoint for", userId, "at", roomId);
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
      const userAgentId = rid();
      let userAgent = await this._createUserAgent(type, params.name, roomId);
      userAgent.voiceBridge = roomId;
      this._userAgents[userAgentId] = userAgent;
      // TODO integrate FS adapter with Balancer
      return Promise.resolve({ mediaElement: userAgentId, host: {ip: FREESWITCH_IP, port: FREESWITCH_PORT} });
    }
    catch (err) {
      return Promise.reject(err);
    }
  }

  async connect (sourceId, sinkId, type) {
    const userAgent = this._userAgents[sourceId];
    const { voiceBridge, session } = userAgent;
    const rtpConverter = this._rtpConverters[sourceId];

    Logger.debug("[mcs-media-freeswitch] Connecting", sourceId, "to", sinkId);

    if (session) {
      return new Promise(async (resolve, reject) => {
        if (rtpConverter == null) {
          return reject(C.ERROR.MEDIA_NOT_FOUND);
        }

        switch (type) {
          case C.CONNECTION_TYPE.ALL:

          case C.CONNECTION_TYPE.AUDIO:

          case C.CONNECTION_TYPE.VIDEO:
            try {
              await this._Kurento.connect(rtpConverter.elementId, sinkId, type);
              return resolve();
            } catch (e) {
              return reject(e);
            }
            break;
          default:
            return reject(C.ERROR.MEDIA_INVALID_OPERATION);
        }
      });
    }
    else {
      return Promise.reject(C.ERROR.MEDIA_NOT_FOUND);
    }
  }

  stop (roomId, type = {}, elementId) {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info("[mcs-media-freeswitch] Releasing endpoint", elementId, "from room", roomId);

        await this._stopUserAgent(elementId);
        await this._stopRtpConverter(roomId, elementId);
        await this._stopRtpProxy(roomId, elementId);
        return resolve();
      }
      catch (error) {
        error = this._handleError(error);
        return reject(error);
      }
    });
  }

  async _stopUserAgent (elementId) {
    return new Promise(async (resolve, reject) => {
      Logger.debug("[mcs-media-freeswitch] Releasing userAgent", elementId);
      let userAgent = this._userAgents[elementId];

      if (userAgent) {
        Logger.debug("[mcs-media-freeswitch] Stopping user agent", elementId);
        await userAgent.stop();
        delete this._userAgents[elementId];
        return resolve();
      }
      else {
        return resolve();
      }
    });
  }

  async _stopRtpConverter (voiceBridge, elementId) {
    return new Promise(async (resolve, reject) => {
      let rtpConverter = this._rtpConverters[elementId];
      if (rtpConverter) {
        Logger.debug("[mcs-media-freeswitch] Stopping converter", rtpConverter.elementId);
        await this._Kurento.stop(voiceBridge, C.MEDIA_TYPE.RTP, rtpConverter.elementId);
        this.balancer.decrementHostStreams(rtpConverter.host.id, 'audio');
        delete this._rtpConverters[elementId];
        return resolve();
      }
      else {
        return resolve();
      }
    });
  }

  async _stopRtpProxy (voiceBridge, elementId) {
    return new Promise(async (resolve, reject) => {
      let rtpProxy = this._rtpProxies[elementId];
      if (rtpProxy) {
        Logger.debug("[mcs-media-freeswitch] Stopping proxy", rtpProxy.elementId);
        await this._Kurento.stop(voiceBridge, C.MEDIA_TYPE.RTP, rtpProxy.elementId);
        this.balancer.decrementHostStreams(rtpProxy.host.id, 'audio');
        delete this._rtpProxies[elementId];
        return resolve();
      }
      else {
        return resolve();
      }
    });
  }

  _processProxyElement (voiceBridge, elementId, offer) {
    return new Promise(async (resolve, reject) => {
      try {
        let mediaElement, host;

        ({ mediaElement, host }  = await this._Kurento.createMediaElement(voiceBridge, C.MEDIA_TYPE.RTP));
        this._rtpProxies[elementId] = { elementId: mediaElement, host };
        const answer = await this._Kurento.processOffer(mediaElement, offer, { replaceIp: true });
        this.balancer.incrementHostStreams(host.id, 'audio');
        return resolve(answer);
      } catch (e) {
        return reject(this._handleError(e));
      }
    });
  }

  async processOffer (elementId, sdpOffer, params) {
    const userAgent = this._userAgents[elementId];
    const { voiceBridge } = userAgent;
    const { name, hackProxyViaKurento } = params
    let mediaElement, host, proxyAnswer, isNegotiated = false;

    return new Promise(async (resolve, reject) => {
      try {
        if (userAgent) {
          if (sdpOffer == null || hackProxyViaKurento) {
            if (this._rtpConverters[elementId]) {
              mediaElement = this._rtpConverters[elementId].elementId;
            }
            else {
              ({ mediaElement, host }  = await this._Kurento.createMediaElement(voiceBridge, C.MEDIA_TYPE.RTP));
              this._rtpConverters[elementId] = { elementId: mediaElement, host };
              this.balancer.incrementHostStreams(host.id, 'audio');
            }

            if (hackProxyViaKurento) {
              Logger.info("[mcs-media-freeswitch] Proxying audio to FS via Kurento for", elementId, "at", voiceBridge);
              proxyAnswer = await this._processProxyElement(voiceBridge, elementId, sdpOffer);
              this._Kurento.connect(this._rtpProxies[elementId].elementId, this._rtpConverters[elementId].elementId, C.CONNECTION_TYPE.AUDIO);
              this._Kurento.connect(this._rtpConverters[elementId].elementId, this._rtpProxies[elementId].elementId, C.CONNECTION_TYPE.AUDIO);

              sdpOffer = null;
            }

            Logger.info("[mcs-media-freeswitch] RTP endpoint equivalent to SIP instance is", mediaElement, "indexed at", voiceBridge);
          }

          const session = this.sipCall(userAgent,
            name,
            userAgent.voiceBridge,
            FREESWITCH_IP,
            FREESWITCH_PORT,
            this._rtpConverters[elementId]? this._rtpConverters[elementId].elementId : null,
            sdpOffer,
          );

          userAgent.session = session;

          const handleNegotiationError = (c) => {
            if (!isNegotiated) {
              isNegotiated = true;
              return reject(this._handleError(C.ERROR.MEDIA_PROCESS_OFFER_FAILED));
            }
          }

          session.on('accepted', (response, cause) => {
            if (response) {
              session.callId = response.call_id;
            }

            const answer = hackProxyViaKurento ? proxyAnswer : session.mediaHandler.remote_sdp;
            isNegotiated = true;

            return resolve(answer);
          });

          session.on('rejected', (response, cause) => {
            Logger.info("[mcs-media-freeswitch] Session", elementId, "rejected", { cause })
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError(cause);
          });

          session.on('failed', (response, cause) => {
            Logger.info("[mcs-media-freeswitch] Session", elementId, "failed", { cause })
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
            handleNegotiationError(cause);
          });

          session.on('terminated', (response) => {
            Logger.info("[mcs-media-freeswitch] Session", elementId, "terminated")
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

  async setVolume (mediaElementId, volume) {
    return new Promise(async (resolve, reject) => {
      try {
        const userAgent = this._userAgents[mediaElementId];
        const { voiceBridge, session } = userAgent;

        if (session) {
          // Mute/unmute directly via DTMF/INFO using the conference dialplan config
          if (volume == 0 && !session.isMuted) {
            session.dtmf(0);
            session.isMuted = true;
            return resolve();
          }

          if (session.isMuted) {
            session.dtmf(0);
            session.isMuted = false;
          }
          const callId = session.callId;
          const convertedVolume = convertRange({floor: 0, ceiling: 100},
            {floor: -4, ceiling: 4}, volume);
          Logger.info("[mcs-media-freeswitch] Setting new volume", convertedVolume, "to media", mediaElementId, "with call ID", callId);
          await sendEslCommand("uuid_audio " + callId + " start read level " + convertedVolume);
          return resolve();
        } else {
          return reject("[mcs-media-freeswitch] There is no session for element " + mediaElementId);
        }
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  trackMediaState (elementId, type) {
    let userAgent = this._userAgents[elementId];
    if (userAgent) {
      userAgent.on('invite', function(session) {
        Logger.info("[mcs-media-freeswitch] On UserAgentInvite");
      });

      userAgent.on('message', function(message) {
        Logger.info("[mcs-media-freeswitch] On UserAgentMessage", message);
      });

      userAgent.on('connected', function() {
        Logger.info("[mcs-media-freeswitch] On UserAgentConnected");
      });

      userAgent.on('disconnected', function (){
        Logger.warn("[mcs-media-freeswitch] UserAgent disconnected");
      });

      return;
    }
  }

  _destroyElements() {
    for (var ua in this._userAgents) {
      if (this._userAgents.hasOwnProperty(ua)) {
        delete this._mediaElements[ua];
      }
    }
  }

  _createUserAgent (type, displayName, roomId) {
    var mediaFactory = mediaHandler.SIPMediaHandler.defaultFactory;
    const uriUser = displayName ? displayName : roomId;
    var newUA = new SIPJS.UA({
      uri: 'sip:' + uriUser + '@' + FREESWITCH_IP,
      wsServers: 'ws://' + FREESWITCH_IP + ':' + FREESWITCH_PORT,
      displayName: displayName,
      register: false,
      mediaHandlerFactory: mediaFactory,
      userAgentString: C.STRING.SIP_USER_AGENT,
      log: {
        builtinEnabled: false,
        level: 3,
        connector: this.sipjsLogConnector
      },
      traceSip: true,
      hackIpInContact: FREESWITCH_IP
    });

    Logger.info("[mcs-freeswitch-adapter] Created new user agent for endpoint " + displayName);

    return newUA;
  }

  /**
   * Makes a sip call to a Freeswitch instance
   * @param {UA} caller's SIP.js User Agent
   * @param {String} username The user identifier (Kurento Endpoint ID)
   * @param {String} voiceBridge The voiceBridge we are going to call to
   * @param {String} host Freeswitch host address
   * @param {String} port Freeswitch port
   */
  sipCall (userAgent, username, voiceBridge, host, port, rtp, sdpOffer) {
    const inviteWithoutSdp = sdpOffer ? false : true;
    //call options
    var options = {
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

    mediaHandler.SIPMediaHandler.setup(sdpOffer, rtp, this._Kurento);

    var sipUri = new SIPJS.URI('sip', voiceBridge, host, port);

    Logger.info('[mcs-media-freeswitch] Making SIP call to: ' + sipUri + ' from: ' + username);

    return userAgent.invite(sipUri, options);
  }

  dtmf (elementId, tone) {
    return new Promise(async (resolve, reject) => {
      try {
        const userAgent = this._userAgents[elementId];
        const { voiceBridge, session } = userAgent;

        if (session) {
          session.dtmf(tone);
          Logger.info(`[mcs-media-freeswitch] Sending DTMF tone`, { elementId, tone });
          return resolve();
        }

        return reject(this._handleError({
          ...C.ERROR.MEDIA_NOT_FOUND,
          details: `adapterElementId: ${elementId}`,
        }));
      } catch (error) {
        return reject(this._handleError(error));
      }
    });
  }

  _handleError (error) {
    return handleError('[mcs-media-freeswitch]', error);
  }
  sipjsLogConnector (level, category, label, content) {
    Logger.debug('[SIP.js]  ' + content);
  }
};
