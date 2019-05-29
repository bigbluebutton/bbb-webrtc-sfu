"use strict";

/**
 * @fileoverview SIPMediaHandlerV2
 */

const C = require('../../constants/constants.js');

const SIPMediaHandlerV2Factory = function (session, options) {
  return new SIPMediaHandlerV2(session, options);
}

const SIPMediaHandlerV2 = function (session, options) {
  this.session = session;
  this.options = options;
  this.reinvite = false;
}

SIPMediaHandlerV2.prototype = {

  isReady: function() { return true; },

  close: function() {
  },

  isSupported: function () {
    return true;
  },

  render: function() {},
  mute: function() {},
  unmute: function() {},

  hasDescription: function () {
    return !!this._sdpResponse;
  },

  getDescription: async function(onSuccess, onFailure) {
    try {
      if (this._sdpResponse == null) {
        this.answerDeferral = new Promise((resolve, reject) => {
          this.resolveAnswer = () => {
            return resolve(onSuccess(this._sdpResponse));
          }
        });

        this.session.once(C.EVENT.RESPONSE_SET, this.resolveAnswer.bind(this));
        return this.answerDeferral;
      } else {
        this.timeout = setTimeout(function () {
          delete this.timeout;
          onSuccess(this._sdpResponse);
        }.bind(this), 0);
      }
    } catch (error) {
      return onFailure(error);
    }
  },

  setDescription: async function (wrapper, onSuccess, onFailure) {
    let sdp;

    // Duck type because SIP.js folks were a bit ~savage with 0.7.8
    if (typeof wrapper === 'object') {
      sdp = wrapper.body;
    } else {
      sdp = wrapper;
    }

    try {
      if (this.reinvite === false) {
        this.reinvite = true;
      } else {
        this._sdpResponse = null;
        this.session.emit(C.EVENT.REINVITE, sdp);
      }

      this._endpointSdp = sdp;
      this.session.emit(C.EVENT.REMOTE_SDP_RECEIVED, sdp);

      this.timeout = setTimeout(function () {
        delete this.timeout;
        return onSuccess(sdp);
      }.bind(this), 0)
    } catch (error) {
      return onFailure(error);
    }
  },

  setRemoteOffer: function (sdp) {
    this._sdpResponse = sdp;
    this.session.emit(C.EVENT.RESPONSE_SET, sdp);
  },

  setReinviteAnswer:function (reinviteAnswer) {
    this.setRemoteOffer(reinviteAnswer);
  },

  getEndpointSdp: function () {
    return this._endpointSdp;
  },

  getReferMedia: function() {
  },
}

module.exports = SIPMediaHandlerV2Factory;
