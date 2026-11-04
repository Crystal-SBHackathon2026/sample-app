const express = require('express');
const {RequestStoreError} = require('./request');

function sendRequestError(res, error) {
  if (error && error.code === 'WRITES_PAUSED') {
    res.set('Retry-After', '1');
  }
  const known = error instanceof RequestStoreError;
  return res.status(known ? error.statusCode : 503).json({error: {
    code: known ? error.code : 'DB_UNAVAILABLE',
    message: known ? error.message : 'Database is unavailable',
  }});
}

/** Mount at any path; getContext adds application-specific response metadata. */
function createRequestRouter({store, getContext = () => ({})}) {
  const router = express.Router();
  router.use(express.json({limit: '512kb'}));
  router.post('/', async (req, res) => {
    try {
      const context = getContext();
      const result = await store.put(req.body);
      res.status(result.created ? 201 : 200).json({
        ...context, ...result, status: 'committed',
      });
    } catch (error) {
      sendRequestError(res, error);
    }
  });
  router.get('/:id', async (req, res) => {
    try {
      const result = await store.get(req.params.id);
      if (!result.request) {
        return res.status(404).json({error: {
          code: 'REQUEST_NOT_FOUND', message: 'Request was not found',
        }});
      }
      res.json({...getContext(), ...result, status: 'committed'});
    } catch (error) {
      sendRequestError(res, error);
    }
  });
  router.use((error, req, res, next) => {
    const parserStatus = error.status || error.statusCode;
    if (Number.isInteger(parserStatus) && parserStatus >= 400 &&
        parserStatus < 500) {
      return res.status(400).json({error: {
        code: 'INVALID_REQUEST', message: 'Invalid JSON request body',
      }});
    }
    return next(error);
  });
  return router;
}

module.exports = {createRequestRouter, sendRequestError};
