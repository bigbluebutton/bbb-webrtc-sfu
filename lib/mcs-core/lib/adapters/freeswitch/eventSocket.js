const EventEmitter = require('events');
const { Connection } = require('modesl');
const Logger = require('../../utils/logger');
var inspect = require('eyes').inspector({ maxLength: 10000 });
const config = require('config');
const ESL_IP = config.get('freeswitch').esl_ip;
const ESL_PORT = config.get('freeswitch').esl_port;
const ESL_PASS = "ClueCon";
const LOG_PREFIX = "[mcs-freeswitch-event-socket]";

const ESL_MESSAGE = {
  AUTH: "auth",
  EVENT_LISTEN: "event plain",
  CONFERENCE: "conference"
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
  PRESENCE_IN: "PRESENCE_IN"
};

const ESL_EVENT = {
  CALLER_CALLER_ID_NAME: 'Caller-Caller-ID-Name',
  CHANNEL_CALL_UUID: 'Channel-Call-UUID',
  VARIABLE_SIP_CALL_ID: 'variable_sip_call_id',
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

const ESL_MESSAGE_SEPARATOR = " ";
const ESL_MESSAGE_TERMINATOR = "\r\n\r\n";
/**
 * @classdesc
 * This class is a an Event Socket Listener for FreeSWITCH
 * @memberof mcs.adapters
 */
class EventSocket extends EventEmitter {

  /**
   * Create a  new EventSocket Instance
   * @param {Object} params Event Socket Listener params
   */
  constructor (params) {
    super();
    this.params = params;
    this.logger = params ? params.logger : null;
    this.started = false;

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
  async start () {
    try {
      this._client = new Connection(
        this._clientOptions.host,
        this._clientOptions.port, 
        this._clientOptions.auth, 
        this._onConnected.bind(this)
      );

      this._client.on('error', (error) => {
        if(error) {
          switch(error.code) {
            case 'ECONNREFUSED':
              Logger.error(LOG_PREFIX,'Could not connect to ' +
                'freeswitch host - connection refused.');
              break;
            case 'ECONNRESET':
              Logger.error(LOG_PREFIX,'Connection to host reseted.');
              break;
            case 'EHOSTUNREACH':
              Logger.error(LOG_PREFIX,'Could not connect to ' +
              ' freeswitch host - host unreach.');
              break;
            default:
              Logger.error(LOG_PREFIX,'Error:', error.code);
              break;
          }
        }
      });

      /*this._client.on('data', (data) => {
        this._handleFreeswitchEvent(data.toString());
      });

      this._client.on('end', () => {});

      this._doAuthentication();
      this._startListeningToEvents();*/
    } catch (error) {
      throw error;
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
    this.started = true;
  }

  /**
   * Set the input volume of the user represented by memberId in the respective
   * conference represented by the conferenceId
   * @ignore
   */
  async setVolume(conferenceId, memberId, volume) {
    try {
      //this._client.api("conference "+conferenceId+"volume_in "+)
      let conferenceCommand =  ESL_MESSAGE.CONFERENCE + ESL_MESSAGE_SEPARATOR + 
                                conferenceId + ESL_MESSAGE_SEPARATOR +
                                CONFERENCE_COMMAND.VOLUME_IN +
                                ESL_MESSAGE_SEPARATOR + memberId +
                                ESL_MESSAGE_SEPARATOR + volume;
      Logger.info("sending setvolume command",conferenceCommand);
      this._client.api(conferenceCommand, (res) => {
        Logger.info("setvolume response", res.getBody());
      });
    } catch (error) {
      reject(error);
    }
  }

  /**
   * Mute the user represented by memberId in the respective conference
   * represented by the conferenceId
   * @ignore
   */
  async mute(conferenceId, memberId) {
    try {
      let conferenceCommand = ESL_MESSAGE.CONFERENCE + ESL_MESSAGE_SEPARATOR + 
                                conferenceId + ESL_MESSAGE_SEPARATOR +
                                CONFERENCE_COMMAND.MUTE +
                                ESL_MESSAGE_SEPARATOR + memberId;
      this._client.api(conferenceCommand, (res) => {
        Logger.info("mute response", res.getBody());
      });
    } catch (error) {
      reject(error);
    }
  }

  /**
   * Mute the user represented by memberId in the respective conference
   * represented by the conferenceId
   * @ignore
   */
  async unmute(conferenceId, memberId) {
    try {
      let conferenceCommand = ESL_MESSAGE.CONFERENCE + ESL_MESSAGE_SEPARATOR + 
                                conferenceId + ESL_MESSAGE_SEPARATOR +
                                CONFERENCE_COMMAND.UNMUTE +
                                ESL_MESSAGE_SEPARATOR + memberId +
                                ESL_MESSAGE_TERMINATOR;
      this._client.api(conferenceCommand, (res) => {
        Logger.info("unmute response", res.getBody());
      });
    } catch (error) {
      reject(error);
    }
  }

  _onChannelAnswer(event) {
    let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
    let sipCallId = event.getHeader(ESL_EVENT.VARIABLE_SIP_CALL_ID);
    if (channelId && sipCallId) {
      this.emit('channelAnswer', channelId, sipCallId);
    }
  }

  _onCustomEvent(event) {
    let subclass = event.getHeader(ESL_EVENT.SUBCLASS);
    if (subclass === ESL_SUBCLASSES.MAINTENANCE) {
      let action = event.getHeader(ESL_EVENT.ACTION);
      if (action === ESL_ACTIONS.ADD_MEMBER) {
        //inspect(event, 'Event: ' + event.getHeader(ESL_EVENT.EVENT_NAME));
        let memberId = event.getHeader(ESL_EVENT.MEMBER_ID);
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        let isTalking = event.getHeader(ESL_EVENT.TALKING);
        if (memberId && channelId) {
          this.emit('conferenceMember', channelId, memberId, isTalking);
        }
      } else if (action === ESL_ACTIONS.START_TALKING) {
        //inspect(event, 'Event: ' + event.getHeader('Event-Name'));
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        if (channelId) {
          this.emit('startTalking', channelId);
        }
      } else if (action === ESL_ACTIONS.STOP_TALKING) {
        //inspect(event, 'Event: ' + event.getHeader('Event-Name'));
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        if (channelId) {
          this.emit('stopTalking', channelId);
        }
      } else if (action === ESL_ACTIONS.VOLUME_IN_MEMBER) {
        //inspect(event, 'Event: ' + event.getHeader('Event-Name'));
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        let volumeLevel = event.getHeader(ESL_EVENT.VOLUME_LEVEL);
        if (channelId && volumeLevel) {
          this.emit('volumeChanged', channelId, volumeLevel);
        } 
      } else if (action === ESL_ACTIONS.MUTE_MEMBER) {
        //inspect(event, 'Event: ' + event.getHeader('Event-Name'));
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        if (channelId) {
          this.emit('muted', channelId);
        } 
      } else if (action === ESL_ACTIONS.UNMUTE_MEMBER) {
        //inspect(event, 'Event: ' + event.getHeader('Event-Name'));
        let channelId = event.getHeader(ESL_EVENT.CHANNEL_CALL_UUID);
        if (channelId) {
          this.emit('unmuted', channelId);
        }
      } else if (action === ESL_ACTIONS.VIDEO_FLOOR_CHANGE) {
        //inspect(event, 'Event: ' + event.getHeader('Event-Name'));
        let conferenceName = event.getHeader(ESL_EVENT.CONFERENCE_NAME);
        let newFloorMemberId = event.getHeader(ESL_EVENT.NEW_ID);
        if (conferenceName && newFloorMemberId) {
          this.emit('floorChanged', conferenceName, newFloorMemberId);
        }
      } else {
        //inspect(event, 'Event: ' + event.getHeader(ESL_EVENT.EVENT_NAME));
      }
    }
  }
}

/**
 * @ignore
 */
EventSocket.ESL_EVENT = ESL_EVENT;

/**
 * @ignore
 */
EventSocket.ESL_EVENTS = ESL_EVENTS;

/**
 * @ignore
 */
EventSocket.ESL_ACTIONS = ESL_ACTIONS;

/**
 * @ignore
 */
EventSocket.ESL_SUBCLASSES = ESL_SUBCLASSES;
module.exports = EventSocket;
