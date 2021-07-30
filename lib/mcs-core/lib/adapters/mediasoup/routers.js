'use strict';

const C = require('../../constants/constants');
const { handleError } = require('./errors.js');
const Logger = require('../../utils/logger');
const { ROUTER_SETTINGS, LOG_PREFIX } = require('./configs.js');

// ROUTER_STORAGE: Map<routerId, MediaSoupRouter>. Registers thin
// wrappers for a Mediasoup router (=== pipeline for the jumentoheads)
const ROUTER_STORAGE = new Map();

const storeRouter = (id, router) => {
  if (!router) return false;

  if (hasRouter(id)) {
    // Might be an ID collision. Throw this peer out and let the client reconnect
    throw handleError({
      ...C.ERROR.MEDIA_ID_COLLISION,
      details: "MEDIASOUP_ROUTER_COLLISION"
    });
  }

  ROUTER_STORAGE.set(id, router);

  return true;
}

const getRouter = (id) => {
  return ROUTER_STORAGE.get(id);
}

const hasRouter = (id) => {
  return ROUTER_STORAGE.has(id);
}

const deleteRouter = (id) => {
  return ROUTER_STORAGE.delete(id);
}

const assembleRouterId = (routerIdPrefix, routerIdSuffix) => {
  return `${routerIdPrefix}-${routerIdSuffix}`;
}

const createRouter = (worker, {
  routerIdSuffix,
  routerSettings = ROUTER_SETTINGS,
}) => {
  return new Promise(async (resolve, reject) => {
    try {
      const router = await worker.createRouter(routerSettings);
      router.workerId = worker.internalAdapterId;
      router.activeElements = 0;
      router.internalAdapterId = `${worker.internalAdapterId}-${routerIdSuffix}`;
      return resolve(router);
    } catch (error) {
      Logger.error(LOG_PREFIX, 'Router creation failed', error,
        { errorMessage: error.Message, errorCode: error.code });
      throw error;
    }
  });
}

const getOrCreateRouter = async (worker, {
  routerIdSuffix,
  routerSettings = ROUTER_SETTINGS
}) => {
  try {
    const routerId = assembleRouterId(worker.internalAdapterId, routerIdSuffix);
    let router = getRouter(routerId);

    if (router) return router;

    router = await createRouter(worker, { routerIdSuffix, routerSettings });
    storeRouter(routerId, router);
    Logger.info(LOG_PREFIX, `Created router at room ${routerIdSuffix} with rid ${routerId}`,
      { routerId: router.id, routerIdSuffix });

    return router;
  } catch (error) {
    Logger.error(LOG_PREFIX, 'Router fetch failed',
      { errorMessage: error.Message, errorCode: error.code });
    throw (handleError(error));
  }
}

const _close = (router) => {
  if (router && typeof router.close === 'function') {
    Logger.debug(LOG_PREFIX, 'Releasing router', { routerId });
    deleteRouter(routerId);
    return router.close();
  }

  return Promise.resolve();
};

const releaseRouter = (routerId) => {
  return new Promise(async (resolve, reject) => {
    try {
      const router = getRouter(routerId);

      if (router && typeof router.close === 'function') {
        Logger.debug(LOG_PREFIX, `Releasing router ${routerId}`,
          { routerId });
        deleteRouter(routerId);
        await router.close();
        return resolve()
      }

      return resolve();
    } catch (error) {
      return reject(handleError(error));
    }
  });
}

const releaseAllRoutersWithIdSuffix = (routerIdSuffix) => {
  ROUTER_STORAGE.forEach(async (router, routerId) => {
    if (routerId.includes(routerIdSuffix)) {
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
