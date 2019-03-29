"use strict";

/**
 * @fileoverview MediaHandler
 */

const RESPONSE_SET_EVENT = 'RESPONSE_SET';
const REINVITE_EVENT = "REINVITE";
const REMOTE_SDP_RECEIVED_EVENT = "REMOTE_SDP_RECEIVED";

var SIPMediaHandlerV2Factory = function (session, options) {
  return new SIPMediaHandlerV2(session, options);
}


var SIPMediaHandlerV2 = function (session, options) {
  this.session = session;
  this.options = options;
  this.reinvite = false;
}

SIPMediaHandlerV2.prototype = {

  isReady: function() { return true; },

  close: function() {
  },

  isSupported: function () {
    return true
  },

  render: function() {},
  mute: function() {},
  unmute: function() {},

  getDescription: async function(onSuccess, onFailure) {
    try {
      if (this._sdpResponse == null) {
        this.answerDeferral = new Promise((resolve, reject) => {
          this.resolveAnswer = () => {
            return resolve(onSuccess(this._sdpResponse));
          }
        });

        this.session.on(RESPONSE_SET_EVENT, this.resolveAnswer.bind(this));
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

  setDescription: async function (sdp, onSuccess, onFailure) {
    try {
      if (this.reinvite === false) {
        this.reinvite = true;
      } else {
        this._sdpResponse = null;
        this.session.emit(REINVITE_EVENT, sdp);
      }

      this._endpointSdp = sdp;
      this.session.emit(REMOTE_SDP_RECEIVED_EVENT, sdp);

      this.timeout = setTimeout(function () {
        delete this.timeout;
        return onSuccess(sdp);
      }.bind(this), 0)
    } catch (error) {
      return onFailure(error);
    }
  },

  setRemoteOffer: function (sdp) {
    this._sdpResponse= sdp;
    this.session.emit(RESPONSE_SET_EVENT, sdp);
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
