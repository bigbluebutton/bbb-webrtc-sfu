const EventEmitter = require('events');
const C = require('../../constants/constants.js');
const { Connection } = require('modesl');
const Logger = require('../../utils/logger');
const config = require('config');
const ESL_IP = config.get('freeswitch.esl_ip');
const ESL_PORT = config.get('freeswitch.esl_port');
const ESL_PASS = config.has('freeswitch.esl_password')
  ? config.get('freeswitch.esl_password')
  : 'ClueCon';
const LOG_PREFIX = "[mcs-freeswitch-esl-wrapper]";
const { handleError } = require('../../utils/util');
const RECONNECTION_TIMER = 5000;

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
  PRESENCE_IN: "PRESENCE_IN",
  END: "esl::end",
  DISCONNECT_NOTICE: "esl::events::disconnect::notice",
};

const ESL_EVENT = {
  CALLER_CALLER_ID_NAME: 'Caller-Caller-ID-Name',
  CALLER_CALLER_ID_NUMBER: 'Caller-Caller-ID-Number',
  CHANNEL_CALL_UUID: 'Channel-Call-UUID',
  VARIABLE_SIP_CALL_ID: 'variable_sip_call_id',
  VARIABLE_SIP_FROM_USER: 'variable_sip_from_user',
  EVENT_NAME: 'Event-Name',
  DTMF_DIGIT: 'DTMF-Digit',
  ACTION: 'Action',
  MEMBER_ID: 'Member-ID',
  SUBCLASS: 'Event-Subclass',
  TALKING: 'Talking',
  VOLUME_LEVEL: "Volume-Level",
  CONFERENCE_NAME: "Conference-Name",
  OLD_ID: 'Old-ID',
  NEW_ID: 'New-ID',
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
  VIDEO_FLOOR_CHANGE: 'floor-change'
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

  _connect () {
    this._client = new Connection(
      this._clientOptions.host,
      this._clientOptions.port,
      this._clientOptions.auth,
      this._onConnected.bind(this)
    );

    this._client.auth((error) => {
      if (error) {
        Logger.error(`FSESL connection authentication error`);
        this.error = this._normalizeError(C.ERROR.MEDIA_ESL_AUTHENTICATION_ERROR, error.message)
      }
    });
  }

  _monitorESLClientConnectionErrors () {
    this._client.on('error', (error) => {
      if (error) {
        Logger.error(`FSESL connection received error ${error.code}`,
          { error });
        this.error = this._normalizeError(C.ERROR.MEDIA_ESL_CONNECTION_ERROR, error.message);
        this._onDisconnection();
      }
    });
  }

  /**
   * Start ESL, connecting to FreeSWITCH
   * @return {Promise} A Promise for the starting process
   */
  start () {
    try {
      this._connect();
      this._monitorESLClientConnectionErrors();
      } catch (error) {
        Logger.error(`Error when starting ESL interface`,
          { error });
      throw (this._normalizeError(error));
    }
  }

  /**
   * Stop ESL
   * @return {Promise} A Promise for the stopping process
   */
  async stop () {
    if (this._client && typeof(this._client.end) == 'function') {
      this._client.end();
      this._client = null;
    }
  }

  _onConnected () {
    Logger.info(`Connected to FreeSWITCH ESL`);

    if (this._reconnectionRoutine) {
      clearInterval(this._reconnectionRoutine);
      this._reconnectionRoutine = null;
    }

    this._client.subscribe([
      'all'
    ], this._onSubscribed.bind(this));
  }

  _onDisconnection () {
    if (this._reconnectionRoutine == null) {
      Logger.error(`FSESL connection dropped unexpectedly`);
      this._reconnectionRoutine = setInterval(async () => {
        try {
          this.stop();
          this._connect();
          this._monitorESLClientConnectionErrors();
        } catch (error) {
          Logger.warn(`Failed to reconnect to FSESL, try again in ${RECONNECTION_TIMER}`,
            { error });
          this.stop();
        }
      }, RECONNECTION_TIMER);
    }
  }

  _onSubscribed () {
    this._client.on('esl::event::'+ESL_EVENTS.CUSTOM+'::*', this._onCustomEvent.bind(this));
    this._client.on('esl::event::'+ESL_EVENTS.CHANNEL_ANSWER+'::*', this._onChannelAnswer.bind(this));
    this._client.on('esl::event::'+ESL_EVENTS.CHANNEL_HANGUP_COMPLETE+'::*', this._onChannelHangup.bind(this));
    this._client.on(ESL_EVENTS.DISCONNECT_NOTICE, this._onDisconnection.bind(this));
    this._client.on(ESL_EVENTS.END, this._onDisconnection.bind(this));

    this.connected = true;
  }

  _executeCommand (command) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        Logger.error(`FSESL wrapper is disconnected, unable to execute ${command}`);
        return reject(this.error);
      }
      Logger.debug(`FSESL sending command: ${command}`);
      this._client.api(command, (res) => {
        const body = res.getBody();
        Logger.debug(`FSESL Command response for "${command}" is: ${JSON.stringify(body)}`);
        if (this._hasError(body) && !body.includes('no reply')) {
          return reject(this._normalizeError(C.ERROR.MEDIA_ESL_COMMAND_ERROR, body));
        }
        return resolve();
      });
    });
  }

  /**
   * Set the input volume of the user represented by memberId in the respective
   * conference represented by the conferenceId
   * @ignore
   */
  setVolume (conferenceId, memberId, volume) {
    try {
      const conferenceCommand =
        `${ESL_MESSAGE.CONFERENCE}${ESL_MESSAGE_SEPARATOR}` +
        `${conferenceId}${ESL_MESSAGE_SEPARATOR}` +
        `${CONFERENCE_COMMAND.VOLUME_IN}`  +
        `${ESL_MESSAGE_SEPARATOR}${memberId}` +
        `${ESL_MESSAGE_SEPARATOR}${volume}`;
      return this._executeCommand(conferenceCommand);
    } catch (error) {
      Logger.error(`FSESL: error when executing setVolume command ${error.message}`,
        { conferenceId, memberId, volume, error });
      throw (this._normalizeError(error));
    }
  }

  /**
   * Mute the user represented by memberId in the respective conference
   * represented by the conferenceId
   * @ignore
   */
  mute (conferenceId, memberId) {
    try {
      const conferenceCommand =
        `${ESL_MESSAGE.CONFERENCE}${ESL_MESSAGE_SEPARATOR}` +
        `${conferenceId}${ESL_MESSAGE_SEPARATOR}` +
        `${CONFERENCE_COMMAND.MUTE}` +
        `${ESL_MESSAGE_SEPARATOR}${memberId}`;
      return this._executeCommand(conferenceCommand);
    } catch (error) {
      Logger.error(`FSESL: error when executing mute command ${error.message}`,
        { conferenceId, memberId, error });
      throw (this._normalizeError(error));
    }
  }

  /**
   * Mute the user represented by memberId in the respective conference
   * represented by the conferenceId
   * @ignore
   */
  unmute (conferenceId, memberId) {
    try {
      const conferenceCommand =
        `${ESL_MESSAGE.CONFERENCE}${ESL_MESSAGE_SEPARATOR}` +
        `${conferenceId}${ESL_MESSAGE_SEPARATOR}` +
        `${CONFERENCE_COMMAND.UNMUTE}` +
        `${ESL_MESSAGE_SEPARATOR}${memberId}`;
      return this._executeCommand(conferenceCommand);
    } catch (error) {
      Logger.error(`FSESL: error when executing unmute command ${error.message}`,
        { conferenceId, memberId, error });
      throw (this._normalizeError(error));
    }
  }

  dtmf (channelId, tone) {
    try {
      const conferenceCommand =
        `${ESL_MESSAGE.UUID_SEND_DTMF}${ESL_MESSAGE_SEPARATOR}` +
        `${channelId}${ESL_MESSAGE_SEPARATOR}${tone}`;
      return this._executeCommand(conferenceCommand);
    } catch (error) {
      Logger.error(`FSESL: error when executing dtmf command ${error.message}`,
        { channelId, tone, error });
      throw (this._normalizeError(error));
    }
  }

  _onChannelAnswer(event) {
    let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
    let sipCallId = event.getHeader(ESL_EVENT.VARIABLE_SIP_CALL_ID);

    if (channelId && sipCallId) {
      this.emit(EVENTS.CHANNEL_ANSWER, channelId, sipCallId);
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

  _normalizeError (error, details) {
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
