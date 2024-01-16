const C = require('../../bbb/messages/Constants');
const { PrometheusAgent, SFUA_NAMES } = require('./audio-metrics.js');
const Logger = require('../../common/logger.js');

const HOLD_EVENT_EXPIRY = 10000;

module.exports = class AudioMetricsObserver {
  constructor(gateway) {
    this.gateway = gateway;
    this._holdUnholdTrackerMap = new Map();
    this.started = false;
  }

  start () {
    if (this.started) return;

    this.started = true;
    this._trackHoldUnholdEvents();
  }

  _clearMapEntry (map, id) {
    if (map.has(id)) {
      const initialEvent = map.get(id);
      map.delete(id);
      if (initialEvent.janitor) clearTimeout(initialEvent.janitor);
      return initialEvent;
    }

    return null;
  }

  _trackHoldUnholdEvents () {
    if (!SFUA_NAMES.TIME_TO_HOLD && !SFUA_NAMES.TIME_TO_UNHOLD) return;

    this.gateway.addSubscribeChannel(C.FROM_VOICE_CONF);
    this.gateway.addSubscribeChannel(C.TO_VOICE_CONF);
    // Track elapsed time between HoldChannelInVoiceConfSysMsg and
    // ChannelHoldChangedVoiceConfEvtMsg for the same uuid with the same hold attribute
    this.gateway.on(C.TOGGLE_LISTEN_ONLY_MODE_SYS_MSG, (payload) => {
      const { timestamp, userId, meetingId, voiceConf, enabled } = payload;

      if (this._holdUnholdTrackerMap.has(userId)) {
        const initialEvent = this._holdUnholdTrackerMap.get(userId);
        if (timestamp > initialEvent.timestamp) {
          this._clearMapEntry(this._holdUnholdTrackerMap, userId);
        } else {
          return;
        }
      }

      this._holdUnholdTrackerMap.set(userId, {
        hold: enabled,
        timestamp,
        janitor: setTimeout(() => {
          this._clearMapEntry(this._holdUnholdTrackerMap, userId);
          PrometheusAgent.increment(SFUA_NAMES.LISTEN_ONLY_TOGGLE_ERRORS, {
            errorCode: `${enabled ? 'hold' : 'unhold'}_timeout`,
          });
          Logger.warn('Audio: listen only toggle timeout', {
            roomId: voiceConf,
            meetingId,
            userId,
            enabled,
            reqTimestamp: timestamp,
          });
        }, HOLD_EVENT_EXPIRY),
      });
    });

    this.gateway.on(C.CHANNEL_HOLD_CHANGED_VOICE_CONF_EVT_MSG, ({ header, body }) => {
      const { timestamp } = header;
      const { intId, hold } = body;
      const initialEvent = this._clearMapEntry(this._holdUnholdTrackerMap, intId);

      if (!initialEvent) return;

      const { hold: prevHold, timestamp: prevTimestamp} = initialEvent;

      if (prevHold === hold) {
        const elapsed = timestamp - prevTimestamp;
        const eventName = hold ? SFUA_NAMES.TIME_TO_HOLD : SFUA_NAMES.TIME_TO_UNHOLD;
        if (eventName) PrometheusAgent.observe(eventName, elapsed/1000);
      }
    });

    this.gateway.on(C.USER_LEFT_MEETING_2x, ({ userId }) => {
      this._clearMapEntry(this._holdUnholdTrackerMap, userId);
    });

    this.gateway.on(C.USER_LEFT_VOICE_CONF_TO_CLIENT_EVT_MSG, ({ userId }) => {
      this._clearMapEntry(this._holdUnholdTrackerMap, userId);
    });
  }
};
