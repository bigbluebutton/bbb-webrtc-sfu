const C = require('../../bbb/messages/Constants');
const { PrometheusAgent, SFUA_NAMES } = require('./audio-metrics.js');

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

  _trackHoldUnholdEvents () {
    if (!SFUA_NAMES.TIME_TO_HOLD && !SFUA_NAMES.TIME_TO_UNHOLD) return;

    this.gateway.addSubscribeChannel(C.FROM_VOICE_CONF);
    this.gateway.addSubscribeChannel(C.TO_VOICE_CONF);
    // Track elapsed time between HoldChannelInVoiceConfSysMsg and
    // ChannelHoldChangedVoiceConfEvtMsg for the same uuid with the same hold attribute
    this.gateway.on(C.TOGGLE_LISTEN_ONLY_MODE_SYS_MSG, (payload) => {
      const { timestamp, userId, enabled } = payload;

      if (this._holdUnholdTrackerMap.has(userId)) {
        const initialEvent = this._holdUnholdTrackerMap.get(userId);
        if (timestamp > initialEvent.timestamp) {
          clearTimeout(initialEvent.janitor);
          this._holdUnholdTrackerMap.delete(userId);
        } else {
          return;
        }
      }

      this._holdUnholdTrackerMap.set(userId, {
        hold: enabled,
        timestamp,
        janitor: setTimeout(() => {
          this._holdUnholdTrackerMap.delete(userId);
        }, HOLD_EVENT_EXPIRY),
      });
    });

    this.gateway.on(C.CHANNEL_HOLD_CHANGED_VOICE_CONF_EVT_MSG, ({ header, body }) => {
      const { timestamp } = header;
      const { intId, hold } = body;
      const initialEvent = this._holdUnholdTrackerMap.get(intId);
      if (!initialEvent) return;
      clearTimeout(initialEvent.janitor);
      const { hold: prevHold, timestamp: prevTimestamp} = initialEvent;

      if (prevHold === hold) {
        const elapsed = timestamp - prevTimestamp;
        const eventName = hold ? SFUA_NAMES.TIME_TO_HOLD : SFUA_NAMES.TIME_TO_UNHOLD;
        if (eventName) PrometheusAgent.observe(eventName, elapsed/1000);
      }

      this._holdUnholdTrackerMap.delete(intId);
    });
  }

 };
