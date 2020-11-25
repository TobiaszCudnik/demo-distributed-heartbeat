import App from './app'
import config from '../config'

if (process.env['MAX_AGE']) {
    config.instanceTimeout = parseInt(process.env['MAX_AGE'], 10)
}

new App(config)
