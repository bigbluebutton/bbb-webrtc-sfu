/**
 * @classdesc
 * BigBlueButton redis gateway for bbb-screenshare node app
 */

'use strict';

/* Modules */

const C = require('../messages/Constants.js');
const RedisWrapper = require('./RedisWrapper.js');
const config = require('config');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../../common/logger.js');

const LOG_PREFIX = "[bbb-gw]";
let instance = null;

module.exports = class BigBlueButtonGW extends EventEmitter {
  constructor() {
    if(!instance){
      super();
      this.subscribers = {};
      this.publisher = null;
      instance = this;
    }

    return instance;
  }

  checkPublisher() {
    if (!this.publisher) {
      this.publisher = new RedisWrapper();
      this.publisher.startPublisher();
    }
  }

  addSubscribeChannel (channel) {
    if (this.subscribers[channel]) {
      return this.subscribers[channel];
    }

    let wrobj = new RedisWrapper(channel);
    this.subscribers[channel] = {};
    this.subscribers[channel] = wrobj;
    try {
      wrobj.startSubscriber();
      wrobj.on(C.REDIS_MESSAGE, this.incomingMessage.bind(this));
      return Promise.resolve(wrobj);
    } catch (error) {
      Logger.error(LOG_PREFIX, "Redis channel subscribe failed", { channel, errorMessage: error.message });
      return Promise.reject(error);
    }
  }

  deserialize (message) {
    if (typeof message === 'object') return message;

    try {
      const dmsg = JSON.parse(message);
      return dmsg;
    } catch (error) {
      Logger.error(LOG_PREFIX, "Failed to deserialize message, use it raw", { errorMessage: error.message });
      return message;
    }
  }

  /**
   * Capture messages from subscribed channels and emit an event with it's
   * identifier and payload. Check Constants.js for the identifiers.
   *
   * @param {Object} message  Redis message
   */
  incomingMessage (message) {
    let meetingId;
    let header;
    let payload;

    const msg = this.deserialize(message);
    // Trying to parse both message types, 1x and 2x
    if (msg.header) {
      header = msg.header;
      payload = msg.payload;
    } else if (msg.core) {
      header = msg.core.header;
      payload = msg.core.body;
    }

    if (header) {
      switch (header.name) {
        // interoperability with 1.1
        case C.DISCONNECT_ALL_USERS:
          this.emit(C.DISCONNECT_ALL_USERS, payload);
          break;
        case C.DISCONNECT_USER:
          this.emit(C.DISCONNECT_USER, payload);
          break;
          // 2x messages
        case C.USER_CAM_BROADCAST_STARTED_2x:
          this.emit(C.USER_CAM_BROADCAST_STARTED_2x, payload);
          break;
        case C.RECORDING_STATUS_REPLY_MESSAGE_2x:
          meetingId = header[C.MEETING_ID_2x];
          this.emit(C.RECORDING_STATUS_REPLY_MESSAGE_2x+meetingId, payload);
          break;
        case C.DISCONNECT_ALL_USERS_2x:
          meetingId = header[C.MEETING_ID_2x];
          payload[C.MEETING_ID_2x] = meetingId;
          this.emit(C.DISCONNECT_ALL_USERS_2x, payload);
          this.emit(C.DISCONNECT_ALL_USERS_2x+meetingId, payload);
          break;
        case C.PRESENTER_ASSIGNED_2x:
          meetingId = header[C.MEETING_ID_2x];
          payload[C.MEETING_ID_2x] = meetingId;
          this.emit(C.PRESENTER_ASSIGNED_2x+meetingId, payload);
          this.emit(C.PRESENTER_ASSIGNED_2x, payload);
          break;
        case C.USER_JOINED_VOICE_CONF_MESSAGE_2x:
          payload.meetingId = header.meetingId;
          payload.userId = header.userId;
          this.emit(C.USER_JOINED_VOICE_CONF_MESSAGE_2x, payload);
          break;
        case C.USER_LEFT_MEETING_2x:
          payload.meetingId = header.meetingId;
          payload.userId = header.userId;
          this.emit(C.USER_LEFT_MEETING_2x, payload);
          this.emit(C.USER_LEFT_MEETING_2x+header.userId, payload);
          break;
        case C.GET_GLOBAL_AUDIO_PERM_RESP_MSG:
          this.emit(C.GET_GLOBAL_AUDIO_PERM_RESP_MSG+payload.sfuSessionId, payload);
          break;
        case C.GET_SCREEN_BROADCAST_PERM_RESP_MSG:
          this.emit(C.GET_SCREEN_BROADCAST_PERM_RESP_MSG+payload.sfuSessionId, payload);
          break;
        case C.GET_SCREEN_SUBSCRIBE_PERM_RESP_MSG: {
          const suffix = `${payload.sfuSessionId}/${payload.streamId}`;
          const enrichedEventId = `${C.GET_SCREEN_SUBSCRIBE_PERM_RESP_MSG}/${suffix}`
          this.emit(enrichedEventId, payload);
          this.emit(C.GET_SCREEN_SUBSCRIBE_PERM_RESP_MSG, payload);
          break;
        }
        case C.GET_CAM_BROADCAST_PERM_RESP_MSG:
          this.emit(C.GET_CAM_BROADCAST_PERM_RESP_MSG+payload.sfuSessionId, payload);
          break;
        case C.GET_CAM_SUBSCRIBE_PERM_RESP_MSG: {
          const suffix = `${payload.sfuSessionId}/${payload.streamId}`;
          const enrichedEventId= `${C.GET_CAM_SUBSCRIBE_PERM_RESP_MSG}/${suffix}`
          this.emit(enrichedEventId, payload);
          this.emit(C.GET_CAM_SUBSCRIBE_PERM_RESP_MSG, payload);
          break;
        }
        case C.CAM_STREAM_UNSUBSCRIBE_SYS_MSG: {
          const eventName = `${C.CAM_STREAM_UNSUBSCRIBE_SYS_MSG}-${payload.userId}-${payload.streamId}`;
          this.emit(eventName, payload);
          break;
        }
        case C.CAM_BROADCAST_STOP_SYS_MSG: {
          const eventName = `${C.CAM_BROADCAST_STOP_SYS_MSG}-${payload.userId}-${payload.streamId}`;
          this.emit(eventName, payload);
          break;
        }
        case C.SCREEN_BROADCAST_STOP_SYS_MSG: {
          meetingId = payload[C.MEETING_ID_2x];
          this.emit(C.SCREEN_BROADCAST_STOP_SYS_MSG+meetingId, payload);
          this.emit(C.SCREEN_BROADCAST_STOP_SYS_MSG, payload);
          break;
        }

        default:
          this.emit(header.name, { header, body: payload, });
      }
    } else {
      this.emit(C.GATEWAY_MESSAGE, msg);
    }
  }

  publish (message, channel) {
    this.checkPublisher();

    if (typeof this.publisher.publishToChannel === 'function') {
      this.publisher.publishToChannel(message, channel);
    }
  }

  setKey(key, message, callback) {
    this.checkPublisher();
    this.publisher.setKey(key, message, callback);
  }

  getKey(key, callback) {
    this.checkPublisher();
    this.publisher.getKey(key, callback);
  }

  writeMeetingKey(meetingId, message) {
    const EXPIRE_TIME = config.get('redisExpireTime');
    this.checkPublisher();

    let recKey = 'recording:' + meetingId;

    this.publisher.setKeyWithIncrement(recKey, message, (err, msgId) => {
      this.publisher.pushToList('meeting:' + meetingId + ':recordings', msgId);
      this.publisher.expireKey(recKey + ':' + msgId, EXPIRE_TIME, (error) => {
        if (error) {
          return Logger.error(LOG_PREFIX, 'Recording key Redis write failed', {
            errorMessage: error.message,
            meetingId,
          });
        }

        Logger.debug(LOG_PREFIX, 'Recording key written in redis', {
          messageId: msgId,
          key: recKey,
          expireTime: EXPIRE_TIME,
        });
      });
    });
  }

  async isChannelAvailable (channel) {
    const channels = await this.publisher.getChannels();
    return channels.includes(channel);
  }

  getChannels () {
    return this.publisher.getChannels();
  }

  setEventEmitter (emitter) {
    this.emitter = emitter;
  }
}
