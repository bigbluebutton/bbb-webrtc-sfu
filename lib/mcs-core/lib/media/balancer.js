'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('config');
const Logger = require('../utils/logger');
const mediaServerClient = require('kurento-client');
const EventEmitter = require('events').EventEmitter;
const C = require('../constants/constants');

const KMS_ARRAY = config.get('kurento');
const VIDEO_TRANSPOSING_CEILING = config.get('video-transposing-ceiling');
const AUDIO_TRANSPOSING_CEILING = config.get('audio-transposing-ceiling');
const BALANCING_STRATEGY = config.has('balancing-strategy')
  ? config.get('balancing-strategy')
  : C.BALANCING_STRATEGIES.ROUND_ROBIN;
const NOF_STARTUP_CONNECTION_RETRIES = config.has('kurentoStartupRetries')
  ? config.get('kurentoStartupRetries')
  : 10;
const HOST_RETRY_TIMER = 3000;
const KMS_FAILOVER_TIMEOUT_MS = 15000;
const KMS_DEFAULT_OPTIONS = {
  failAfter: 5,
};
const KMS_ALLOW_MEDIATYPE_MIX = config.has('kurentoAllowMediaTypeMix')
  ? config.get('kurentoAllowMediaTypeMix')
  : true;

const LOG_PREFIX = '[mcs-balancer]';

let instance = null;

class Balancer extends EventEmitter {
  constructor () {
    super();
    if (instance == null) {
      this.hosts = [];
      this._reconnectionRoutine = {};
      instance = this;
    }
    return instance;
  }

  async upstartHosts () {
    const processHosts = async () => {
      const tryToConnect = async (host) => {
        const {
          url,
          ip,
          mediaType,
          retries,
          ipClassMappings = { public: host.ip },
          options = KMS_DEFAULT_OPTIONS,
        } = host;
        if (retries < NOF_STARTUP_CONNECTION_RETRIES) {
          if (!this._hostStarted(url, ip)) {
            try {
              const newHost = await Balancer.connectToHost(
                url,
                ip,
                options,
                ipClassMappings,
                mediaType
              );
              this._monitorConnectionState(newHost);
              this.addHost(newHost);
            }
            catch (e) {
              host.retries++;
              Logger.error(LOG_PREFIX, 'Failed to connect to media server',
                { url, ip, mediaType, retries });
              setTimeout(() => tryToConnect(host), HOST_RETRY_TIMER);
            }
          }
        } else {
          Logger.error(LOG_PREFIX, 'Maximum number of retries expired for media server',
            { url, ip, mediaType, retries });
        }
      };

      const tentativeHosts = KMS_ARRAY.map(th => { return { ...th, retries: 0}});

      tentativeHosts.forEach(tentativeHost => {
        tryToConnect(tentativeHost);
      });
    }

    processHosts();
  }

  static connectToHost (url, ip, options, ipClassMappings, mediaType = C.MEDIA_PROFILE.ALL) {
    const connect =  new Promise((resolve, reject) => {
      mediaServerClient(url, options, (error, client) => {
        if (error) {
          return reject(error);
        }
        const newHost = {
          id: uuidv4(),
          url,
          ip,
          medias: {
            [C.MEDIA_PROFILE.MAIN]: 0,
            [C.MEDIA_PROFILE.CONTENT]: 0,
            [C.MEDIA_PROFILE.AUDIO]: 0,
          },
          options,
          ipClassMappings,
          mediaType,
          client: client
        };
        return resolve(newHost);
      });
    });

    const failOver = new Promise((resolve, reject) => {
      setTimeout(reject, KMS_FAILOVER_TIMEOUT_MS, 'connectionTimeout');
    });

    return Promise.race([connect, failOver]);
  }

  async getHost (mediaType = C.MEDIA_PROFILE.ALL) {
    const host = this._fetchAvailableHost(mediaType);
    if (host == null) {
      throw C.ERROR.MEDIA_SERVER_OFFLINE;
    }

    Logger.info(LOG_PREFIX, `Got media server ${host.id}`, {
      hostId: host.id,
      url: host.url,
      mediaType: host.mediaType,
      targetMediaType: mediaType,
    });

    return host;
  }

  retrieveHost (hostId) {
    return this.hosts.find(host => host.id === hostId);
  }

  addHost (host) {
    if (host) {
      const { id } = host;
      this.removeHost(id);
      this.hosts.push(host);

      Logger.info(LOG_PREFIX, 'New media server host added',
        { hostId: id, url: host.url, ip: host.ip, mediaType: host.mediaType });

      return;
    }

    Logger.warn(LOG_PREFIX, 'Undefined media server host on addHost, SHOULD NOT HAPPEN!');
  }

  removeHost (hostId) {
    this.hosts = this.hosts.filter(host => host.id !== hostId);
  }

  decrementHostStreams (hostId, mediaType) {
    const host = this.retrieveHost(hostId);

    if (host) {
      host.medias[mediaType]--;
      Logger.info(LOG_PREFIX, `Media server ${mediaType} streams decremented`,
        { hostId: host.id, url: host.url, mediaType, [mediaType]: host.medias[mediaType] });
    }
  }

  incrementHostStreams (hostId, mediaType) {
    const host = this.retrieveHost(hostId);

    if (host) {
      host.medias[mediaType]++;
      Logger.info(LOG_PREFIX, `Media server ${mediaType} streams incremented`,
        { hostId: host.id, url: host.url, mediaType, [mediaType]: host.medias[mediaType] });
    }
  }

  _fetchAvailableHost (mediaType) {
    // Check if there any available hosts. Otherwise, throw the OFFLINE error
    // which will be propagated to root API call that triggered it
    if (this.hosts.length <= 0) {
      throw C.ERROR.MEDIA_SERVER_OFFLINE;
    }

    switch (BALANCING_STRATEGY) {
      case C.BALANCING_STRATEGY.MEDIA_TYPE:
        return this._mediaTypeHost(mediaType);
      case C.BALANCING_STRATEGY.ROUND_ROBIN:
      default:
        return this._roundRobinHost();
    }
  }

  _roundRobinHost () {
    let host = this.hosts.find(host =>
      (host.medias[C.MEDIA_PROFILE.MAIN] < VIDEO_TRANSPOSING_CEILING) &&
      (host.medias[C.MEDIA_PROFILE.AUDIO] < AUDIO_TRANSPOSING_CEILING)
    );

    // Round robin if all instances are fully loaded
    if (host == null) {
      host = this.hosts.shift();
      this.addHost(host);
    }

    return host;
  }

  _compareLoad (h1, h2) {
    const h1Load = h1.medias[C.MEDIA_PROFILE.MAIN] + h1.medias[C.MEDIA_PROFILE.CONTENT] + h1.medias[C.MEDIA_PROFILE.AUDIO];
    const h2Load = h2.medias[C.MEDIA_PROFILE.MAIN] + h2.medias[C.MEDIA_PROFILE.CONTENT] + h2.medias[C.MEDIA_PROFILE.AUDIO];
    return h1Load - h2Load;
  }

  _mediaTypeHost (mediaType) {
    // The algorithm here is a very naive one: look for a media server allocated
    // for the required type. If not found, get the least loaded one. The only
    // wart here is that we won't mix video/content streams with audio streams,
    // so that's also taken into account when looking for the least loaded server.
    let host = this.hosts.find(host => host.mediaType === mediaType);

    // Didn't find a host for the mediaType, get the least loaded.
    // separation
    if (host == null) {
      if (!KMS_ALLOW_MEDIATYPE_MIX) {
        throw C.ERROR.MEDIA_SERVER_OFFLINE;
      }

      // Isolate audio if possible. And yeah, I understand it is odd that the
      // constants are MEDIA_PROFILE and the config is mediaType, but that's life.
      if (mediaType !== C.MEDIA_PROFILE.AUDIO) {
        host = this.hosts
          .filter(h => h.mediaType !== C.MEDIA_PROFILE.AUDIO)
          .sort(this._compareLoad)[0];
      } else {
        host = this.hosts.sort(this._compareLoad)[0];
      }
    }

    return host;
  }

  _hostStarted (url, ip) {
    return this.hosts.some(h => h.url == url && h.ip == ip);
  }

  _monitorConnectionState (host) {
    const { id, client, url, ip } = host;

    try {
      client.on('disconnect', () => {
        this._onDisconnection(host);
      });
      client.on('reconnected', (sameSession) => {
        this._onReconnection(sameSession, host);
      });
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Error when trying to monitor media server',
        { hostId: id, url, ip, mediaType: host.mediaType });
    }
  }

  _onDisconnection (host) {
    try {
      const { id } = host;

      Logger.error(LOG_PREFIX, 'Media server disconnected',
        { hostId: id, url: host.url, mediaType: host.mediaType });
      this.removeHost(id);
      this.emit(C.EVENT.MEDIA_SERVER_OFFLINE, id);

      // Reset host media tracking
      host.audio = 0;
      host.video = 0;

      this._reconnectToServer(host);
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Error trying to handle media server disconnection',
        { hostId: host.id, url: host.url, mediaType: host.mediaType, error });
    }
  }

  _onReconnection (sameSession, host) {
    if (!sameSession) {
      Logger.warn(LOG_PREFIX, 'Media server reconnected, not same session',
        { hostId: host.id, url: host.url, mediaType: host.mediaType });
      this._onDisconnection(host);
    }
  }

  _reconnectToServer (host) {
    const { id, url, options } = host;
    Logger.info(LOG_PREFIX, 'Reconnecting to media server',
      { hostId: id, url, mediaType: host.mediaType });
    if (this._reconnectionRoutine[id] == null) {
      this._reconnectionRoutine[id] = setInterval(async () => {
        try {
          const connect =  new Promise((resolve, reject) => {
            mediaServerClient(url, options, (error, client) => {
              if (error) {
                return reject(error);
              }
              host.client = client;
              return resolve(host);
            });
          });

          const failOver = new Promise((resolve, reject) => {
            setTimeout(reject, KMS_FAILOVER_TIMEOUT_MS, 'connectionTimeout');
          });

          Promise.race([connect, failOver]).then(h => {
            this._monitorConnectionState(host);
            clearInterval(this._reconnectionRoutine[id]);
            delete this._reconnectionRoutine[id];
            this.addHost(h);
            Logger.warn(LOG_PREFIX, 'Reconnection to media server succeeded',
              { hostId: id, url, mediaType: host.mediaType });
          }).catch(error => {
            Logger.error(LOG_PREFIX, 'Failed to reconnect to media server',
              { hostId: id, url, mediaType: host.mediaType, error });
          });
        } catch (error) {
          Logger.error(LOG_PREFIX, 'Failed to reconnect to media server',
            { hostId: id, url, mediaType: host.mediaType, error });
        }
      }, HOST_RETRY_TIMER);
    }
  }
}

module.exports = new Balancer();
