'use strict'

const C = require('../../constants/constants.js');
const config = require('config');
const EventEmitter = require('events').EventEmitter;
const mediaHandler = require('./sip-media-handler');
const Logger = require('../../utils/logger');
const SIPJS = require('sip.js');
const Kurento = require('../kurento/kurento');
const isError = require('../../utils/util').isError;
const rid = require('readable-id');

const FREESWITCH_IP = config.get('freeswitch').ip;
const FREESWITCH_PORT = config.get('freeswitch').port;
const SDPMedia = require('../../model/sdp-media');


let instance = null;

module.exports = class Freeswitch extends EventEmitter {
  constructor(balancer) {
    if(!instance){
      super();
      this._userAgents = {};
      this._sessions = {};
      this._rtpConverters = {};
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
    const { voiceBridge } = userAgent;
    const source = this._sessions[voiceBridge];
    const rtpConverter = this._rtpConverters[sourceId].elementId;

    Logger.debug("[mcs-media-freeswitch] Connecting", rtpConverter, "to", sinkId);

    if (source) {
      return new Promise((resolve, reject) => {
        switch (type) {
          case 'ALL':

          case 'AUDIO':

          case 'VIDEO':
            this._Kurento.connect(rtpConverter, sinkId, type);
            return resolve();
            break;

          default: return reject("[mcs-media] Invalid connect type");
        }
      });
    }
    else {
      return Promise.reject("[mcs-media] Failed to connect " + type + ": " + sourceId + " to " + sinkId);
    }
  }

  stop (roomId, type = {}, elementId) {
    return new Promise(async (resolve, reject) => {
      try {
        Logger.info("[mcs-media-freeswitch] Releasing endpoint", elementId, "from room", roomId);

        await this._stopUserAgent(elementId);
        await this._stopRtpConverter(roomId, elementId);
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

  async processOffer (elementId, sdpOffer, params) {
    const userAgent = this._userAgents[elementId];
    const { voiceBridge } = userAgent;
    let mediaElement, host;

    return new Promise(async (resolve, reject) => {
      try {
        if (userAgent) {

          if (sdpOffer == null) {
            if (this._rtpConverters[elementId]) {
              mediaElement = this._rtpConverters[elementId].elementId;
            }
            else {
              ({ mediaElement, host }  = await this._Kurento.createMediaElement(voiceBridge, 'RtpEndpoint'));
              this._rtpConverters[elementId] = { elementId: mediaElement, host };
              this.balancer.incrementHostStreams(host.id, 'audio');
            }
            Logger.info("[mcs-media-freeswitch] RTP endpoint equivalent to SIP instance is", mediaElement, "indexed at", voiceBridge);
          }

          const session = this.sipCall(userAgent,
              params.name,
              userAgent.voiceBridge,
              FREESWITCH_IP,
              FREESWITCH_PORT,
              mediaElement,
              sdpOffer
              );

          session.on('accepted', (response, cause) => {
            this._sessions[voiceBridge] = session;
            return resolve(session.mediaHandler.remote_sdp);
          });

          session.on('rejected', (response, cause) => {
            Logger.info("session rejected", response, cause);
          });

          session.on('failed', (response, cause) => {
            Logger.info("session failed", response, cause);
          });

          session.on('progress', (response) => {
            Logger.info("session progress", response);
          });

          session.on('terminated', (response) => {
            Logger.info("Session", elementId, "terminated")
            this.emit(C.EVENT.MEDIA_DISCONNECTED+elementId);
          });


        } else {
          return reject("[mcs-media] There is no element " + elementId);
        }
      }
      catch (error) {
        this._handleError(error);
        reject(error);
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

  _handleError(error) {
    // Checking if the error needs to be wrapped into a JS Error instance
    if (!isError(error)) {
      error = new Error(error);
    }

    error.code = C.ERROR.MEDIA_SERVER_ERROR;
    Logger.error('[mcs-media] Media Server returned error', error);
  }

  sipjsLogConnector (level, category, label, content) {
    Logger.debug('[SIP.js]  ' + content);
  }
};
