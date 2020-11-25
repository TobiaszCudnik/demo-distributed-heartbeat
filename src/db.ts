import Redis from 'ioredis'
import Koa from 'koa'
import sleep from 'sleep-promise'
import App, { TContext } from './app'

export default (app: App): Redis.Redis => {
  const config = app.config
  const { logger } = app

  logger.info(
    `Connecting to "${config.db.name}" and ${config.db.sentinels.length} sentinels`
  )
  const redis = new Redis(app.config.db)

  redis.once('connect', () => {
    logger.info('Redis connected')
    // flush the DB on start
    if (app.config.emptyDB) {
      redis.flushall().then(() => {
        logger.info('DB cleared')
        app.emit('db:ready')
      })
    } else {
      app.emit('db:ready')
    }
  })

  // db to state
  app.use(async (ctx: Koa.Context, next: Koa.Next) => {
    ctx.state.db = redis
    return next()
  })

  return redis
}

/**
 * Try to aquire a write lock for the specified key.
 *
 * Uses pooling internally.
 *
 * TODO use pub/sub
 */
export async function aquireLock (ctx: TContext, name: string) {
  const { db, config, logger } = ctx.state

  while (true) {
    const mutex = await db.get('mutex:' + name)
    if (!mutex) {
      break
    }

    const start = parseInt(mutex, 10)

    if (start + config.mutexTimeout < Date.now()) {
      logger.debug(`Mutex "${name}" timed out`)
      break
    }
    
    logger.debug(`Waiting on mutex "${name}"`)
    await sleep(config.mutexTimeout / 25)
  }

  // claim the mutex
  await db.set('mutex:' + name, Date.now())
}

/**
 * Release a write lock for the specified key.
 */
export async function releaseLock (ctx: TContext, key: string) {
  const { db } = ctx.state
  await db.del('mutex:' + key)
}
