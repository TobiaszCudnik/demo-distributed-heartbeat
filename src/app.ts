import Router from '@koa/router'
import { Server } from 'http'
import httpStatus from 'http-status-codes'
import Redis from 'ioredis'
import Koa from 'koa'
import pino from 'pino'
import db from './db'
import groupEndpoints from './endpoints/groups'
import instanceEndpoints from './endpoints/instances'
import errors from './errors'

export type TState = {
  db: Redis.Redis
  logger: pino.Logger
  config: TConfig
  // timestamp
  lastInstancesDispose: number
}

export type TDBConfig = {
  sentinels: Array<{
    host: string
    port: number
  }>
  name: string
}

// TODO defaults
export type TConfig = {
  db: TDBConfig
  // timestamp
  gcInterval: number
  // timestamp
  instanceTimeout: number
  // timestamp
  mutexTimeout: number
  httpPort?: number
  logLevel?: pino.LevelWithSilent
  emptyDB?: boolean
}

export interface TContext extends Koa.ParameterizedContext<TState> {}
export type TRouter = Router<TState, TContext>

export default class extends Koa<TState, TContext> {
  config: TConfig
  logger: pino.Logger
  router: TRouter
  db: Redis.Redis
  httpServer?: Server
  lastGroupCleanup?: number
  gcCounter: number = 0

  constructor (config: TConfig) {
    super()
    this.config = config
    this.logger = pino({ level: config.logLevel || 'info' })
    this.router = new Router()
    const port = config.httpPort || 3030

    this.use(async (ctx, next) => {
      // state (logger, config)
      ctx.state.config = this.config
      ctx.state.logger = this.logger
      // log requests
      this.logger.info(`${ctx.request.method} ${ctx.request.url}`)
      return next()
    })

    errors(this)
    this.db = db(this)

    // assert the state before any endpoints
    this.use(async (ctx, next) => {
      assertState(ctx)
      return next()
    })

    instanceEndpoints(this)
    groupEndpoints(this)

    // router
    this.use(this.router.routes()).use(this.router.allowedMethods())

    // wait for the DB
    this.once('db:ready', () => {
      this.httpServer = this.listen(port)
      this.logger.info(`Listening on localhost:${port}`)
      this.emit('ready')
    })
  }

  async close () {
    this.httpServer?.close()
    this.db.disconnect()
    await new Promise(resolve => {
      this.db.on('end', resolve)
    })
  }
}

export function assertState (ctx: TContext) {
  const errCode = httpStatus.INTERNAL_SERVER_ERROR

  ctx.assert(ctx.state.db, errCode)
  ctx.assert(ctx.state.logger, errCode)
  ctx.assert(ctx.state.config, errCode)
}
