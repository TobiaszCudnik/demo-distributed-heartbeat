import { TConfig } from './src/app'

const config: TConfig = {
  db: {
    sentinels: [
      { host: 'localhost', port: 26379 },
      { host: 'localhost', port: 26380 },
      { host: 'localhost', port: 26381 }
    ],
    name: 'redismaster',
  },
  gcInterval: 60*1000,
  instanceTimeout: 60*1000,
  mutexTimeout: 2*1000,
  httpPort: 3030,
  logLevel: 'debug',
  emptyDB: false
}

export default config
