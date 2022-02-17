'use strict';

const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const { ROUTER_SETTINGS, LOG_PREFIX } = require('./configs.js');
const { PrometheusAgent, MS_METRIC_NAMES } = require('./prom-metrics.js');
const { replaceRouterCodecsWithSdpCodecs } = require('./utils.js');
const { v4: uuidv4 } = require('uuid');

const ROUTER_ID_S_TOKEN = '/roomId:';
// ROUTER_STORAGE: Map<routerId, MediaSoupRouter>. Registers thin
// wrappers for a Mediasoup router (=== pipeline for the jumentoheads)
const ROUTER_STORAGE = new Map();

const storeRouter = (id, router) => {
  if (!router) return false;

  if (hasRouter(id)) {
    Logger.error(LOG_PREFIX, 'Collision on router storage', {
      routerId: id,
    });

    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_ROUTER_COLLISION"
    });
  }

  ROUTER_STORAGE.set(id, router);
  PrometheusAgent.increment(MS_METRIC_NAMES.MEDIASOUP_ROUTERS);

  return true;
}

const getRouter = (id) => {
  return ROUTER_STORAGE.get(id);
}

const hasRouter = (id) => {
  return ROUTER_STORAGE.has(id);
}

const deleteRouter = (id) => {
  const deleted = ROUTER_STORAGE.delete(id);

  if (deleted) {
    PrometheusAgent.decrement(MS_METRIC_NAMES.MEDIASOUP_ROUTERS);
  }

  return deleted;
}

const assembleRouterId = (routerIdPrefix, routerIdSuffix) => {
  return `${routerIdPrefix}${ROUTER_ID_S_TOKEN}${routerIdSuffix}`;
}

const getRouterIdSuffix = (routerId) => {
  return routerId.split(ROUTER_ID_S_TOKEN)[1];
}

const _createRouter = async (worker, {
  internalRouterId,
  routerSettings = ROUTER_SETTINGS,
}) => {
  try {
    const router = await worker.createRouter(routerSettings);
    router.workerId = worker.appData.internalAdapterId;
    router.appData.internalAdapterId = internalRouterId;
    router.once("workerclose", () => {_close(router, "workerclose")});

    return router;
  } catch (error) {
    Logger.error(LOG_PREFIX, 'Router creation failed', {
      errorMessage: error.message, internalRouterId,
    });
    throw error;
  }
}

const getOrCreateRouter = async (worker, {
  routerIdSuffix,
  routerSettings = ROUTER_SETTINGS,
  dedicatedRouter = false,
  overrideRouterCodecs = false,
  remoteDescriptor,
}) => {
  try {
    let router;
    const routerIdPrefix = !dedicatedRouter ? worker.appData.internalAdapterId : uuidv4();
    const routerId = assembleRouterId(routerIdPrefix, routerIdSuffix);
    const appData = { dedicatedRouter };

    if (!dedicatedRouter || !overrideRouterCodecs) {
      router = getRouter(routerId);
      if (router) return router;
    }

    if (overrideRouterCodecs && remoteDescriptor) {
      routerSettings = replaceRouterCodecsWithSdpCodecs(routerSettings, remoteDescriptor);
    }

    // App-specific data (ours)
    routerSettings.appData = appData;
    router = await _createRouter(worker, { internalRouterId: routerId, routerSettings });
    storeRouter(routerId, router);
    Logger.info(LOG_PREFIX, 'Router created', {
      routerId: router.id, routerIntId: router.appData.internalAdapterId, roomId: routerIdSuffix,
    });

    return router;
  } catch (error) {
    Logger.error(LOG_PREFIX, 'Router fetch failed', {
      errorMessage: error.message, roomId: routerIdSuffix,
    });
    throw (handleError(error));
  }
}

const _close = (router, reason = 'normalclearing') => {
  if (router && typeof router.close === 'function') {
    Logger.info(LOG_PREFIX, 'Releasing router', {
      routerId: router.id, routerIntId: router.appData.internalAdapterId, reason
    });
    deleteRouter(router.appData.internalAdapterId);
    return router.close();
  }

  return Promise.resolve();
};

const releaseRouter = (routerId) => {
  const router = getRouter(routerId);
  return _close(router);
}

// TODO refactor: why are we iterating over the whole map...
const releaseAllRoutersWithIdSuffix = ({ roomId: routerIdSuffix }) => {
  ROUTER_STORAGE.forEach(async (router, routerId) => {
    const targetSuffix = getRouterIdSuffix(routerId);
    if (targetSuffix === routerIdSuffix) {
      try {
        await releaseRouter(routerId);
      } catch (error) {
        handleError(error);
      }
    }
  });
}


module.exports = {
  getOrCreateRouter,
  storeRouter,
  getRouter,
  hasRouter,
  deleteRouter,
  releaseRouter,
  releaseAllRoutersWithIdSuffix,
}
