const EventEmitter = require('events');
const C = require('../../constants/constants.js');
const { Connection } = require('modesl');
const Logger = require('../../utils/logger');
const config = require('config');
const ESL_IP = config.get('freeswitch').esl_ip;
const ESL_PORT = config.get('freeswitch').esl_port;
const ESL_PASS = "ClueCon";
const LOG_PREFIX = "[mcs-freeswitch-esl-wrapper]";
const { handleError } = require('../../utils/util');

const ESL_MESSAGE = {
  AUTH: "auth",
  EVENT_LISTEN: "event plain",
  CONFERENCE: "conference",
  UUID_SEND_DTMF: "uuid_send_dtmf",
};

const CONFERENCE_COMMAND = {
  VOLUME_IN: "volume_in",
  MUTE: "mute",
  UNMUTE: "unmute"
};

const ESL_EVENTS = {
  ALL: "ALL",
  DTMF: "DTMF",
  CUSTOM: "CUSTOM",
  CHANNEL_ANSWER: "CHANNEL_ANSWER",
  CHANNEL_HANGUP_COMPLETE: "CHANNEL_HANGUP_COMPLETE",
  PRESENCE_IN: "PRESENCE_IN"
};

const ESL_EVENT = {
  CALLER_CALLER_ID_NAME: 'Caller-Caller-ID-Name',
  CALLER_CALLER_ID_NUMBER: 'Caller-Caller-ID-Number',
  CHANNEL_CALL_UUID: 'Channel-Call-UUID',
  VARIABLE_SIP_CALL_ID: 'variable_sip_call_id',
  VARIABLE_SIP_FROM_USER: 'variable_sip_from_user',
  VARIABLE_RTP_LOCAL_SDP_STR: 'variable_rtp_local_sdp_str',
  VARIABLE_SWITCH_R_SDP: 'variable_switch_r_sdp',
  EVENT_NAME: 'Event-Name',
  DTMF_DIGIT: 'DTMF-Digit',
  ACTION: 'Action',
  MEMBER_ID: 'Member-ID',
  SUBCLASS: 'Event-Subclass',
  TALKING: 'Talking',
  VOLUME_LEVEL: "Volume-Level",
  CONFERENCE_NAME: "Conference-Name",
  OLD_ID: "Old-ID",
  NEW_ID: "New-ID",
};

const ESL_SUBCLASSES = {
  MAINTENANCE: 'conference::maintenance'
}

const ESL_ACTIONS = {
  ADD_MEMBER: 'add-member',
  START_TALKING: 'start-talking',
  STOP_TALKING: 'stop-talking',
  VOLUME_IN_MEMBER: 'volume-in-member',
  MUTE_MEMBER: 'mute-member',
  UNMUTE_MEMBER: 'unmute-member',
  VIDEO_FLOOR_CHANGE: "video-floor-change"
}

const EVENTS = {
  CHANNEL_ANSWER: "channelAnswer",
  CHANNEL_HANGUP: "channelHangup",
  CONFERENCE_MEMBER: "conferenceMember",
  START_TALKING: "startTalking",
  STOP_TALKING: "stopTalking",
  VOLUME_CHANGED: "volumeChanged",
  MUTED: "muted",
  UNMUTED: "unmuted",
  FLOOR_CHANGED: "floorChanged"
};

const ESL_MESSAGE_SEPARATOR = " ";
/**
 * @classdesc
 * This class is a an Event Socket Listener for FreeSWITCH
 * @memberof mcs.adapters
 */
class EslWrapper extends EventEmitter {

  /**
   * Create a  new EslWrapper Instance
   * @param {Object} params Event Socket Listener params
   */
  constructor (params) {
    super();
    this.params = params;
    this.logger = params ? params.logger : null;
    this.connected = false;
    this.error = {};

    this._client = null;
    this._clientOptions = {
      host: (this.params && this.params.host) ?
        this.params.host : ESL_IP,
      port: (this.params && this.params.port) ?
        this.params.port : ESL_PORT,
      auth: (this.params && this.params.auth) ?
        this.params.auth : ESL_PASS,
    };
  }

  /**
   * ESL Parameters
   * @type {Object}
   */
  get params () {
    return this._params;
  }

  set params (params) {
    this._params = params;
  }

  /**
   * Start ESL, connecting to FreeSWITCH
   * @return {Promise} A Promise for the starting process
   */
  start () {
    try {
      this._client = new Connection(
        this._clientOptions.host,
        this._clientOptions.port,
        this._clientOptions.auth,
        this._onConnected.bind(this)
      );

      this._client.auth((error) => {
        if (error) {
          this.error = this._handleError(C.ERROR.MEDIA_ESL_AUTHENTICATION_ERROR, error.message)
          throw (error);
        }
      });

      this._client.on('error', (error) => {
        if(error) {
          switch(error.code) {
            case 'ECONNREFUSED':
              Logger.error(LOG_PREFIX,'Could not connect to ' +
                'freeswitch host - connection refused.');
              this.error = this._handleError(C.ERROR.MEDIA_ESL_CONNECTION_ERROR, error.message);
              throw (error);
            case 'ECONNRESET':
              Logger.error(LOG_PREFIX,'Connection to host reseted.');
              this.error = this._handleError(C.ERROR.MEDIA_ESL_CONNECTION_ERROR, error.message);
              throw (error);
            case 'EHOSTUNREACH':
              Logger.error(LOG_PREFIX,'Could not connect to ' +
              ' freeswitch host - host unreach.');
              this.error = this._handleError(C.ERROR.MEDIA_ESL_CONNECTION_ERROR, error.message);
              throw (error);
            default:
              this.error = this._handleError(C.ERROR.MEDIA_ESL_CONNECTION_ERROR, error.message);
              throw (error);
          }
        }
      });
    } catch (error) {
      Logger.error(LOG_PREFIX,error);
      throw (this._handleError(error));
    }
  }

  /**
   * Stop ESL
   * @return {Promise} A Promise for the stopping process
   */
  async stop () {
    try {
      if (this._client && typeof(this._client.end) == 'function') {
        this._client.end();
        this._client = null;
      }
    } catch (error) {
      throw (error);
    }
  }

  _onConnected () {
    this._client.subscribe([
      'all'
    ], this._onSubscribed.bind(this));
  }

  _onSubscribed () {
    this._client.on('esl::event::'+ESL_EVENTS.CUSTOM+'::*', this._onCustomEvent.bind(this));
    this._client.on('esl::event::'+ESL_EVENTS.CHANNEL_ANSWER+'::*', this._onChannelAnswer.bind(this));
    this._client.on('esl::event::'+ESL_EVENTS.CHANNEL_HANGUP_COMPLETE+'::*', this._onChannelHangup.bind(this));
    this.connected = true;
  }

  /**
   * Set the input volume of the user represented by memberId in the respective
   * conference represented by the conferenceId
   * @ignore
   */
  async setVolume(conferenceId, memberId, volume) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this.connected) {
          reject(this.error);
        }
        const conferenceCommand =
        (`${ESL_MESSAGE.CONFERENCE}${ESL_MESSAGE_SEPARATOR}\
          ${conferenceId}${ESL_MESSAGE_SEPARATOR}\
          ${CONFERENCE_COMMAND.VOLUME_IN}\
          ${ESL_MESSAGE_SEPARATOR}${memberId}\
          ${ESL_MESSAGE_SEPARATOR}${volume}`);

        Logger.debug(LOG_PREFIX,"sending setvolume command",conferenceCommand);
        this._client.api(conferenceCommand, (res) => {
          const body = res.getBody();
          Logger.debug(LOG_PREFIX,"setvolume response", body);
          if (this._hasError(body)) {
            reject(this._handleError(C.ERROR.MEDIA_ESL_COMMAND_ERROR,body));
          }
          else {
            resolve();
          }
        });
      } catch (error) {
        reject(this._handleError(error));
      }
    });
  }

  /**
   * Mute the user represented by memberId in the respective conference
   * represented by the conferenceId
   * @ignore
   */
  async mute(conferenceId, memberId) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this.connected) {
          reject(this.error);
        }
        const conferenceCommand =
        (`${ESL_MESSAGE.CONFERENCE}${ESL_MESSAGE_SEPARATOR}\
          ${conferenceId}${ESL_MESSAGE_SEPARATOR}\
          ${CONFERENCE_COMMAND.MUTE}\
          ${ESL_MESSAGE_SEPARATOR}${memberId}`);

        Logger.debug(LOG_PREFIX,"sending mute command",conferenceCommand);
        this._client.api(conferenceCommand, (res) => {
          const body = res.getBody();
          Logger.debug(LOG_PREFIX,"mute response", body);
          if (this._hasError(body)) {
            reject(this._handleError(C.ERROR.MEDIA_ESL_COMMAND_ERROR,body));
          }
          else {
            resolve();
          }
        });
      } catch (error) {
        reject(this._handleError(error));
      }
    });
  }

  /**
   * Mute the user represented by memberId in the respective conference
   * represented by the conferenceId
   * @ignore
   */
  async unmute(conferenceId, memberId) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this.connected) {
          reject(this.error);
        }
        const conferenceCommand =
        (`${ESL_MESSAGE.CONFERENCE}${ESL_MESSAGE_SEPARATOR}\
          ${conferenceId}${ESL_MESSAGE_SEPARATOR}\
          ${CONFERENCE_COMMAND.UNMUTE}\
          ${ESL_MESSAGE_SEPARATOR}${memberId}`);
        Logger.debug(LOG_PREFIX,"sending unmute command",conferenceCommand);
        this._client.api(conferenceCommand, (res) => {
          const body = res.getBody();
          Logger.info(LOG_PREFIX,"unmute response", body);
          if (this._hasError(body)) {
            reject(this._handleError(C.ERROR.MEDIA_ESL_COMMAND_ERROR,body));
          }
          else {
            resolve();
          }
        });
      } catch (error) {
        reject(this._handleError(error));
      }
    });
  }

  async dtmf (channelId, tone) {
    return new Promise((resolve, reject) => {
      try {
        if (!this.connected) {
          // This thing, this.error, sucks. FIXME all throughout this wrapper
          return reject(this.error);
        }
        const cmd = (`${ESL_MESSAGE.UUID_SEND_DTMF}${ESL_MESSAGE_SEPARATOR}\
          ${channelId}${ESL_MESSAGE_SEPARATOR}${tone}`);
        Logger.debug(LOG_PREFIX, `Sending DTMF ${tone} to ${channelId} with command ${cmd}`);
        this._client.api(cmd, (res) => {
          const body = res.getBody();
          if (this._hasError(body) && !body.includes("no reply")) {
            return reject(this._handleError(C.ERROR.MEDIA_ESL_COMMAND_ERROR, body));
          }
          else {
            return resolve();
          }
        });
      } catch (error) {
        reject(this._handleError(error));
      }
    });
  }

  _onChannelAnswer(event) {
    let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
    let sipCallId = event.getHeader(ESL_EVENT.VARIABLE_SIP_CALL_ID);
    let sdpAnswer = event.getHeader(ESL_EVENT.VARIABLE_RTP_LOCAL_SDP_STR);
    let sdpOffer = event.getHeader(ESL_EVENT.VARIABLE_SWITCH_R_SDP);

    if (channelId && sipCallId && sdpAnswer && sdpOffer) {
      this.emit(EVENTS.CHANNEL_ANSWER, channelId, sipCallId, sdpOffer, sdpAnswer);
    }
  }

  _onChannelHangup(event) {
    let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
    let sipCallId = event.getHeader(ESL_EVENT.VARIABLE_SIP_CALL_ID);
    if (channelId && sipCallId) {
      this.emit(EVENTS.CHANNEL_HANGUP, channelId, sipCallId);
    }
  }

  _onCustomEvent(event) {
    const subclass = event.getHeader(ESL_EVENT.SUBCLASS);
    if (subclass === ESL_SUBCLASSES.MAINTENANCE) {
      const action = event.getHeader(ESL_EVENT.ACTION);
      if (action === ESL_ACTIONS.ADD_MEMBER) {
        const memberId = event.getHeader(ESL_EVENT.MEMBER_ID);
        const channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        const callerIdNumber = event.getHeader(ESL_EVENT.CALLER_CALLER_ID_NUMBER);
        const conferenceName = event.getHeader(ESL_EVENT.CONFERENCE_NAME);
        if (memberId && channelId && callerIdNumber && conferenceName) {
          this.emit(EVENTS.CONFERENCE_MEMBER, channelId, memberId, callerIdNumber, conferenceName);
        }
      } else if (action === ESL_ACTIONS.START_TALKING) {
        const channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        if (channelId) {
          this.emit(EVENTS.START_TALKING, channelId);
        }
      } else if (action === ESL_ACTIONS.STOP_TALKING) {
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        if (channelId) {
          this.emit(EVENTS.STOP_TALKING, channelId);
        }
      } else if (action === ESL_ACTIONS.VOLUME_IN_MEMBER) {
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        let volumeLevel = event.getHeader(ESL_EVENT.VOLUME_LEVEL);
        if (channelId && volumeLevel) {
          this.emit(EVENTS.VOLUME_CHANGED, channelId, volumeLevel);
        }
      } else if (action === ESL_ACTIONS.MUTE_MEMBER) {
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        if (channelId) {
          this.emit(EVENTS.MUTED, channelId);
        }
      } else if (action === ESL_ACTIONS.UNMUTE_MEMBER) {
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        if (channelId) {
          this.emit(EVENTS.UNMUTED, channelId);
        }
      } else if (action === ESL_ACTIONS.VIDEO_FLOOR_CHANGE) {
        let conferenceName = event.getHeader(ESL_EVENT.CONFERENCE_NAME);
        let newFloorMemberId = event.getHeader(ESL_EVENT.NEW_ID);
        if (conferenceName && newFloorMemberId) {
          this.emit(EVENTS.FLOOR_CHANGED, conferenceName, newFloorMemberId);
        }
      }
    }
  }

  //check if body has error message
  _hasError(body) {
    return body.startsWith("-ERR");
  }

  _handleError (error,details) {
    if (details) {
      error.details = details;
    }
    return handleError(LOG_PREFIX, error);
  }
}

/**
 * @ignore
 */
EslWrapper.ESL_EVENT = ESL_EVENT;

/**
 * @ignore
 */
EslWrapper.ESL_EVENTS = ESL_EVENTS;

/**
 * @ignore
 */
EslWrapper.ESL_ACTIONS = ESL_ACTIONS;

/**
 * @ignore
 */
EslWrapper.EVENTS = EVENTS;

/**
 * @ignore
 */
EslWrapper.ESL_SUBCLASSES = ESL_SUBCLASSES;
module.exports = EslWrapper;
