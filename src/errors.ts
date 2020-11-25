import httpStatus from 'http-status-codes'
import Koa from 'koa'
import App, { TContext } from './app'

export default (app: App) => {
  // error handler
  app.use(async (ctx: TContext, next: Koa.Next) => {
    try {
      await next()
    } catch (error) {
      ctx.status =
        error.statusCode || error.status || httpStatus.INTERNAL_SERVER_ERROR
      error.status = ctx.status
      ctx.body = { error }
      ctx.app.emit('error', error)
    }
  })

  // error logger
  app.on('error', (err: Error) => app.logger.error(err))
}
