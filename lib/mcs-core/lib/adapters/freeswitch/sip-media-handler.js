'use strict';
const Logger = require('../../utils/logger');
const config = require('config');
const SdpWrapper = require('../../utils/sdp-wrapper');

var kmh = function(sdp) {
  this.endpointSdp = sdp;
};
/**
 * @classdesc
 * 	Custom sipjs's MediaHandler to manage media communication between
 * 	Kurento and Freeswitch
 * 	@constructor
 */
kmh.prototype.SIPMediaHandler = function (session, options ) {
  this.session = session;
  this.options = options;
  this.Kurento;
  this.sdp = null;
  this.endpointSdp = null;
  this.remote_sdp = null;
  this.version = '0.0.1';

  //Default video configuration
  this.video = {
      configuration: {
          codecId: '96',
          sendReceive: 'sendrecv',
          rtpProfile: 'RTP/AVP',
          codecName: 'H264' ,
          codecRate: '90000',
          frameRate: '30.000000'
      }
  };
};

/**
 * Factory method for SIPMediaHandler
 * @param  {Object} session Current session of this media handler
 * @param  {Object} options Options
 * @return {SIPMediaHandler} A SIPMediaHandler
 */
kmh.prototype.SIPMediaHandler.defaultFactory = function sipMediaDefaultFactory (session, options) {
  return new kmh.prototype.SIPMediaHandler(session, options);
};

/**
 * Setup method for this media handler. This method MUST be called before
 * the SIP session starts.
 * @param  {Object} configuration Configuration parameters for the session
 */
kmh.prototype.SIPMediaHandler.setup = function (sdp, rtp, kurento) {
    kmh.prototype.SIPMediaHandler.prototype.sendSdp = sdp;
    kmh.prototype.SIPMediaHandler.prototype.rtp = rtp;
    kmh.prototype.SIPMediaHandler.prototype.Kurento = kurento;

    Logger.trace('[mcs-sip-media-handler] Is there an SDP for this media handler?', sdp);
};

kmh.prototype.SIPMediaHandler.prototype = {

  isReady: function () { return true; },

  close: function () {
    if (this.timeout) {
      clearTimeout(this.timeout);
      delete this.timeout;
    }
    delete this.session;
  },

  render: function(){},
  mute: function(){},
  unmute: function(){},

  getDescription: async function (onSuccess, onFailure, mediaHint) {
    if(this.endpointSdp == null && this.sendSdp == null) {
      Logger.info("[mcs-sip-media-handler] Processing SDP for Kurento RTP endpoint", this.rtp);
      this.remote_sdp = SdpWrapper.getAudioSDP(this.remote_sdp);
      this.endpointSdp = await this.Kurento.processOffer(this.rtp, this.remote_sdp, { replaceIp: true });
    } else if (this.endpointSdp == null) {
      this.endpointSdp = this.sendSdp;
    }
    this.sdp = this.endpointSdp;
    this.timeout = setTimeout(function () {
      delete this.timeout;
      onSuccess(this.sdp);
  }.bind(this), 0);
  },

  setDescription: function (description, onSuccess, onFailure) {
    Logger.debug("[mcs-sip-media-handler] Remote SDP: ", description);
    this.remote_sdp = description;
    this.timeout = setTimeout(function () {
      delete this.timeout;
      onSuccess();
    }.bind(this), 0);
  }
};

module.exports = new kmh();
