const C = require('../../bbb/messages/Constants');
const { PrometheusAgent, SFUA_NAMES } = require('./audio-metrics.js');
const Logger = require('../../common/logger.js');

const HOLD_EVENT_EXPIRY = 10000;

module.exports = class AudioMetricsObserver {
  constructor(gateway, {
    sessions,
  }) {
    this.gateway = gateway;
    this.sessions = sessions;
    this._sessionMap = new Map();
    this._holdUnholdTrackerMap = new Map();
    this._muteUnmuteTrackerMap = new Map();
    this.started = false;
    this._eventQueue = [];
  }

  start () {
    if (this.started) return;

    this.started = true;
    this._trackEvents();
  }

  onSessionStart (userId, sessionId) {
    this._sessionMap.set(userId, sessionId);
  }

  onSessionEnd (userId) {
    this._sessionMap.delete(userId);
    this._clearEventTracker(this._holdUnholdTrackerMap, userId);
    this._clearEventTracker(this._muteUnmuteTrackerMap, userId);
  }

  isSessionValid (userId) {
    const sessionId = this._sessionMap.get(userId);
    if (sessionId == null) return false;

    return this.sessions.has(sessionId);
  }

  isSessionTLOCapable (userId) {
    const sessionId = this._sessionMap.get(userId);
    if (sessionId == null) return false;
    const session = this.sessions.get(sessionId);

    return session && session.isTransparentListenOnlyCapable();
  }

  _clearEventTracker (map, id) {
    if (map.has(id)) {
      const initialEvent = map.get(id);
      map.delete(id);
      if (initialEvent.janitor) clearTimeout(initialEvent.janitor);
      return initialEvent;
    }

    return null;
  }

  _pushEventHandler (eventHandler) {
    this._eventQueue.push(eventHandler);
    // Execute head of queue
    const head = this._eventQueue.shift();
    head();
  }

  _trackEvents () {
    if (!SFUA_NAMES.TIME_TO_HOLD && !SFUA_NAMES.TIME_TO_UNHOLD) return;

    this.gateway.addSubscribeChannel(C.FROM_VOICE_CONF);
    this.gateway.addSubscribeChannel(C.TO_VOICE_CONF);
    this.gateway.addSubscribeChannel(C.TO_AKKA_APPS);
    this.gateway.addSubscribeChannel(C.FROM_AKKA_APPS);
    // Track elapsed time between HoldChannelInVoiceConfSysMsg and
    // ChannelHoldChangedVoiceConfEvtMsg for the same uuid with the same hold attribute
    this.gateway.on(C.TOGGLE_LISTEN_ONLY_MODE_SYS_MSG, (payload) => {
      if (!this.isSessionTLOCapable(payload.userId)) return;

      const handler = () => {
        const { timestamp, userId, meetingId, voiceConf, enabled } = payload;

        if (this._holdUnholdTrackerMap.has(userId)) {
          const initialEvent = this._holdUnholdTrackerMap.get(userId);
          if (timestamp > initialEvent.timestamp) {
            this._clearEventTracker(this._holdUnholdTrackerMap, userId);
          } else {
            return;
          }
        }

        this._holdUnholdTrackerMap.set(userId, {
          hold: enabled,
          timestamp,
          janitor: setTimeout(() => {
            this._clearEventTracker(this._holdUnholdTrackerMap, userId);
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
      };
      this._pushEventHandler(handler);
    });

    this.gateway.on(C.CHANNEL_HOLD_CHANGED_VOICE_CONF_EVT_MSG, ({ header, body }) => {
      const handler = () => {
        const { voiceConf , timestamp } = header;
        const { intId, hold } = body;
        const initialEvent = this._clearEventTracker(this._holdUnholdTrackerMap, intId);

        if (!initialEvent) return;

        const { hold: prevHold, timestamp: prevTimestamp} = initialEvent;

        if (prevHold === hold) {
          const elapsed = timestamp - prevTimestamp;
          const eventName = hold ? SFUA_NAMES.TIME_TO_HOLD : SFUA_NAMES.TIME_TO_UNHOLD;

          if (eventName) {
            const elapsedSeconds = elapsed/1000;
            const metric = PrometheusAgent.observe(eventName, elapsedSeconds);
            if (metric && elapsedSeconds > metric.buckets[metric.buckets.length - 1]) {
              Logger.warn('Audio: hold time exceeds max bucket', {
                roomId: voiceConf,
                userId: intId,
                hold,
                elapsedSeconds,
                reqTimestamp: timestamp,
              });
            }
          }
        }
      };

      this._pushEventHandler(handler);
    });

    this.gateway.on(C.USER_LEFT_MEETING_2x, ({ userId }) => {
      const handler = () => {
        this._clearEventTracker(this._holdUnholdTrackerMap, userId);
      };
      this._pushEventHandler(handler);
    });

    this.gateway.on(C.USER_LEFT_VOICE_CONF_TO_CLIENT_EVT_MSG, ({ userId }) => {
      const handler = () => {
        this._clearEventTracker(this._holdUnholdTrackerMap, userId);
      };
      this._pushEventHandler(handler);
    });

    this.gateway.on(C.MUTE_USER_CMD_MSG, ({ header, body }) => {
      if (!this.isSessionValid(header.userId)) return;

      const handler = () => {
        const { timestamp, userId, meetingId } = header;
        const { mute } = body;

        if (this._muteUnmuteTrackerMap.has(userId)) {
          const initialEvent = this._muteUnmuteTrackerMap.get(userId);
          if (timestamp > initialEvent.timestamp) {
            this._clearEventTracker(this._muteUnmuteTrackerMap, userId);
          } else {
            return;
          }
        }

        this._muteUnmuteTrackerMap.set(userId, {
          mute,
          timestamp,
          janitor: setTimeout(() => {
            this._clearEventTracker(this._muteUnmuteTrackerMap, userId);
            PrometheusAgent.increment(SFUA_NAMES.LISTEN_ONLY_TOGGLE_ERRORS, {
              errorCode: `${mute ? 'mute' : 'unmute'}_timeout`,
            });
            Logger.warn('Audio: mute toggle timeout', {
              meetingId,
              userId,
              mute,
              reqTimestamp: timestamp,
            });
          }, HOLD_EVENT_EXPIRY),
        });
      };

      this._pushEventHandler(handler);
    });

    this.gateway.on(C.USER_MUTED_VOICE_EVT_MSG, ({ header, body }) => {
      const handler = () => {
        const { meetingId, timestamp } = header;
        const { intId, muted } = body;
        const initialEvent = this._clearEventTracker(this._muteUnmuteTrackerMap, intId);

        if (!initialEvent) return;

        const { mute: prevMute, timestamp: prevTimestamp} = initialEvent;

        if (prevMute === muted) {
          const elapsed = timestamp - prevTimestamp;
          const eventName = muted ? SFUA_NAMES.TIME_TO_MUTE : SFUA_NAMES.TIME_TO_UNMUTE;

          if (eventName) {
            const elapsedSeconds = elapsed/1000;
            const metric = PrometheusAgent.observe(eventName, elapsedSeconds);

            if (metric && elapsedSeconds > metric.buckets[metric.buckets.length - 1]) {
              Logger.warn('Audio: mute time exceeds max bucket', {
                meetingId,
                userId: intId,
                muted,
                elapsedSeconds,
                reqTimestamp: timestamp,
              });
            }
          }
        }
      };

      this._pushEventHandler(handler);
    });
  }
};
