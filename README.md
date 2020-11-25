# Distributed Heartbeat (demo)

Distributed heartbeat microservice with a scalable Redis Sentinel backend. Supports groups and garbage collection. Spec from [UB.io](https://github.com/ubio/technical-challenges/tree/master/backend). DB dockers from [zaozaoniao](https://github.com/zaozaoniao/Redis-sentinel-with-docker-compose/blob/master/redisclientApp-independentNetwork/sentinel/docker-compose.yml).

## API

- `GET /`
- `GET /:group`
- `POST /:group/:id`
- `DELETE /:group/:id`

## Features

- groups with counters
- garbage collection
- granular heartbeat updates (main traffic)
- scaling up by adding new nodes
- redis sentinel for DB scaling
  - more masters for sharding
  - more slaves for replication
- granular per-group write locks
- groups index write lock

## Usage

- `yarn install`
- `yarn build`
- `yarn start:db`
- `yarn start`

## Tests

- `yarn start:db`
- `yarn test`

## Dependencies

- node
- yarn
- docker-compose

## Config

- `./config.ts`
- `MAX_AGE` env var

## TODO

- unit tests (-network, +mocks)
- better exceptions handling
- authentication
- request data validation
- CORS
- sourcemaps in stacktraces
- persisting redis for fault tolerance
- `pipeline` to batch DB requests
- docker-compose to Kubernetes (with Kompose)
- pm2 / nodemon / ...
- pub/sub based mutexes (instead of timeout-based)
- stream JSON in a workerpool (for lists)
- TypeORM?
