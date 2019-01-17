'use strict';

const rid = require('readable-id');
const config = require('config');
const Logger = require('../utils/logger');
const mediaServerClient = require('kurento-client');
const EventEmitter = require('events').EventEmitter;
const C = require('../constants/constants');

const KMS_ARRAY = config.get('kurento');
const VIDEO_TRANSPOSING_CEILING = config.get('video-transposing-ceiling');
const AUDIO_TRANSPOSING_CEILING = config.get('audio-transposing-ceiling');
const KMS_FAIL_AFTER = 5;

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
      let validHosts = [];
      for (let i = 0; i < KMS_ARRAY.length; i++) {
        const { url, ip } = KMS_ARRAY[i];
        if (!this._hostStarted(url, ip)) {
          try {
            const newHost = await Balancer.connectToHost(url, ip);
            validHosts.push(newHost);
            this._monitorConnectionState(newHost);
          }
          catch (e) {
            Logger.error('[mcs-balancer] Failed to connect to candidate host', { url, ip });
          };
        }
      }
      return validHosts;
    }

    this.hosts = await processHosts();

    Logger.info('[mcs-balancer] Available hosts =>', this.hosts.map(h => ({ url: h.url })));
  }

  static connectToHost (url, ip) {
    const connect =  new Promise((resolve, reject) => {
      mediaServerClient(url, {failAfter: KMS_FAIL_AFTER}, (error, client) => {
        if (error) {
          return reject(error);
        }
        const newHost = {
          id: rid(),
          url,
          ip,
          video: 0,
          audio: 0,
          client: client
        };
        return resolve(newHost);
      });
    });

    const failOver = new Promise((resolve, reject) => {
      setTimeout(reject, 5000, 'connectionTimeout');
    });

    return Promise.race([connect, failOver]);
  }

  async getHost () {
    const host = this._fetchAvailableHost();
    if (host) {
      Logger.info("[mcs-balancer] Chosen host is", host.id, host.url, host.ip, host.video, host.audio);
      return host;
    }
  }

  retrieveHost (hostId) {
    return this.hosts.find(host => host.id == hostId);
  }

  removeHost (hostId) {
    this.hosts = this.hosts.filter(host => host.id !== hostId);
  }

  decrementHostStreams (hostId, nature) {
    const host = this.retrieveHost(hostId);
    if (host) {
      host[nature]--;
      Logger.info("[mcs-balancer] Host", host.id, nature, 'streams decremented', { audio: host.audio }, { video: host.video });
    }
  }

  incrementHostStreams (hostId, nature) {
    const host = this.retrieveHost(hostId);
    if (host) {
      host[nature]++;
      Logger.info("[mcs-balancer] Host", host.id, "streams incremented", { audio: host.audio }, { video: host.video });
    }
  }

  _fetchAvailableHost () {
    let host = this.hosts.find(host => host.video < VIDEO_TRANSPOSING_CEILING &&
      host.audio < AUDIO_TRANSPOSING_CEILING);

    // Round robin if all instances are fully loaded
    if (host == null) {
      host = this.hosts.shift();
      this.hosts.push(host);
    }

    return host;
  }

  _hostStarted (url, ip) {
    return this.hosts.some(h => h.url == url && h.ip == ip);
  }

  _monitorConnectionState (host) {
    const { id, client, url, ip } = host;
    try {
      Logger.debug('[mcs-balancer] Monitoring connection state for host', id, 'at', url);
      client.on('disconnect', () => {
        this._onDisconnection(host);
      });
      client.on('reconnected', () => {
        this._onReconnection(host);
      });
    }
    catch (err) {
      Logger.error('[mcs-balancer] Error on monitoring host', id, err);
    }
  }

  _onDisconnection (host) {
    try {
      const { client, id } = host;
      Logger.error('[mcs-balancer] Host', id, 'was disconnected for some reason, will have to clean up all elements and notify users');
      this.removeHost(id);
      this.emit(C.EVENT.MEDIA_SERVER_OFFLINE, id);

      // Reset host media tracking
      host.audio = 0;
      host.video = 0;

      this._reconnectToServer(host);
    } catch (e) {
      Logger.error('[mcs-balancer] Error trying to handle host disconnection', e);
    }
  }

  _onReconnection (sameSession) {
    if (!sameSession) {
      Logger.info('[mcs-media] Media server is back online');
      this.emit(C.EVENT.MEDIA_SERVER_ONLINE);
    }
  }

  _reconnectToServer (host) {
    const { client, id, url } = host;
    Logger.info("[mcs-balancer] Reconnecting to host", id, url);
    if (this._reconnectionRoutine[id] == null) {
      this._reconnectionRoutine[id] = setInterval(async () => {
        try {
          const connect =  new Promise((resolve, reject) => {
            mediaServerClient(url, {failAfter: KMS_FAIL_AFTER}, (error, client) => {
              if (error) {
                return reject(error);
              }
              host.client = client;
              return resolve(host);
            });
          });

          const failOver = new Promise((resolve, reject) => {
            setTimeout(reject, 5000, 'connectionTimeout');
          });

          Promise.race([connect, failOver]).then(h => {
            this._monitorConnectionState(host);
            clearInterval(this._reconnectionRoutine[id]);
            delete this._reconnectionRoutine[id];
            this.hosts.push(h);
          }).catch(e => {
            Logger.info("[mcs-balancer] Failed to reconnect to host", id);
          });
          Logger.warn("[mcs-media] Reconnection to media server succeeded", id, url);
        } catch (err) {
          Logger.info("[mcs-balancer] Failed to reconnect to host", id);
        }
      }, 2000);
    }
  }
}

module.exports = new Balancer();
